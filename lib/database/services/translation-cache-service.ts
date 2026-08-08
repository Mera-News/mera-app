// Persistence for the on-device translation cache.
//
// WHAT CHANGED AND WHY. The cache used to be an in-memory `Map` in
// `lib/stores/app-language-store` and nothing else: no persistence, no table.
// Every translation the OS produced was thrown away on app exit, and a language
// switch replaced the Map wholesale — so switching back to a language you had
// used all week re-translated every headline from scratch, one serial native
// call at a time. That, not the queue, is most of what "translation is slow"
// felt like on a warm app.
//
// Three properties this file exists to guarantee:
//
//  1. WRITES ARE BATCHED. A fast scroll completes dozens of translations in a
//     couple of seconds. One `database.write` each would be dozens of SQLite
//     transactions competing with feed sync and scoring. Completions land in a
//     buffer and flush on a trailing debounce, as ONE batch.
//
//  2. READS ARE A SINGLE QUERY. Hydration pulls the most recently used rows for
//     ONE language and hands back a plain Map. `TranslatableDynamic` reads that
//     Map synchronously during render, so anything not hydrated by the time a
//     node renders still costs a native call — hydration therefore runs early
//     (see `hydrate-stores`) and again on every language switch.
//
//  3. IT IS BOUNDED. Every title × every language ever seen is not a cache, it
//     is a leak. One TTL sweep per hydrate, plus a cap on how much is held in
//     memory.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type TranslationCache from '../models/TranslationCache';
import logger from '../../logger';

/** Rows untouched for this long are swept on the next hydrate. */
export const TRANSLATION_CACHE_TTL_DAYS = 30;

/**
 * Most-recently-used rows loaded into memory per language.
 *
 * Kept modest on purpose. `hydrateFromDb` AWAITS this load (the render path
 * reads the Map synchronously, so a node that renders ahead of the hydrate
 * still pays a native call) and that await sits inside the `Promise.all` whose
 * completion flips `database-store.ready` — the gate for `syncFeed`. Every row
 * here is a materialized WatermelonDB model in front of that gate. The query is
 * MRU-ordered and a screenful is ~20 titles, so the head of the list is what
 * earns the win; the tail mostly buys latency.
 */
export const TRANSLATION_CACHE_HYDRATE_LIMIT = 1500;

/** Trailing coalesce window for buffered writes. */
export const TRANSLATION_CACHE_FLUSH_DEBOUNCE_MS = 1500;

/** Hard cap on the write buffer — flush immediately once it is this full. */
export const TRANSLATION_CACHE_FLUSH_MAX_BUFFER = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * FNV-1a (32-bit) over the source text, hex, with the length appended in base
 * 36.
 *
 * Deliberately NOT a cryptographic hash: this is a cache key, there is no
 * adversary, and `expo-crypto`'s digest is async (which would put an await
 * between a completed translation and the buffer that records it). Length is
 * mixed in because FNV-1a's weakest case is short strings differing only in
 * trailing characters — headlines. And a collision is harmless anyway: the full
 * `source_text` is stored and compared on read, so the worst case is a miss.
 */
export function hashSourceText(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        // 32-bit FNV prime multiply, kept in range via Math.imul.
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16)}${text.length.toString(36)}`;
}

/** The WatermelonDB row id for one (text, language) pair — the primary key. */
export function translationCacheId(text: string, targetLang: string): string {
    return `${hashSourceText(text)}:${targetLang}`;
}

interface BufferedWrite {
    readonly sourceText: string;
    readonly targetLang: string;
    readonly translatedText: string;
}

/** id → pending write. A Map so a re-translation of the same key coalesces. */
const writeBuffer = new Map<string, BufferedWrite>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;

/**
 * Record one completed translation. Buffered — returns immediately, never
 * throws, and never blocks the render path that produced it.
 */
export function rememberTranslation(
    sourceText: string,
    targetLang: string,
    translatedText: string,
): void {
    if (!sourceText || !targetLang || !translatedText) return;
    writeBuffer.set(translationCacheId(sourceText, targetLang), {
        sourceText,
        targetLang,
        translatedText,
    });
    if (writeBuffer.size >= TRANSLATION_CACHE_FLUSH_MAX_BUFFER) {
        void flushTranslationCacheWrites();
        return;
    }
    // NON-resetting trailing debounce: a re-arming timer would never fire
    // during a continuous scroll, which is exactly when the buffer fills.
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushTranslationCacheWrites();
    }, TRANSLATION_CACHE_FLUSH_DEBOUNCE_MS);
}

/**
 * Write everything buffered so far, as ONE batch. Safe to call at any time
 * (app background, tests); resolves when the batch has landed.
 */
export function flushTranslationCacheWrites(): Promise<void> {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    // Serialize: a second flush while one is in flight would re-read the buffer
    // the first one is draining.
    if (flushInFlight) {
        return flushInFlight.then(() =>
            writeBuffer.size > 0 ? flushTranslationCacheWrites() : undefined,
        );
    }
    if (writeBuffer.size === 0) return Promise.resolve();

    const entries = [...writeBuffer.entries()];
    writeBuffer.clear();

    flushInFlight = (async () => {
        const collection = database.get<TranslationCache>('translation_cache');
        const ids = entries.map(([id]) => id);
        // ONE query for the whole batch — never one `find()` per row.
        const existing = await collection.query(Q.where('id', Q.oneOf(ids))).fetch();
        const byId = new Map(existing.map((row) => [row.id, row]));
        const now = new Date();

        const ops = entries.map(([id, item]) => {
            const found = byId.get(id);
            if (found) {
                return found.prepareUpdate((row) => {
                    row.translatedText = item.translatedText;
                    row.lastUsedAt = now;
                });
            }
            return collection.prepareCreate((row) => {
                // The row id IS `${hash}:${lang}` — that is what makes the read
                // path a primary-key hit. Same `_raw.id` seeding the feed uses.
                const raw = row._raw as { id?: string } | undefined;
                if (raw) raw.id = id;
                row.sourceHash = hashSourceText(item.sourceText);
                row.targetLang = item.targetLang;
                row.sourceText = item.sourceText;
                row.translatedText = item.translatedText;
                row.createdAt = now;
                row.lastUsedAt = now;
            });
        });

        await database.write(async () => {
            await database.batch(...ops);
        });
        logger.debug('[TranslationCache] Persisted translations', { count: ops.length });
    })()
        .catch((err: unknown) => {
            // A cache write failing is never worth surfacing — the translation
            // is already on screen and the next visit just re-asks the OS.
            logger.warn('[TranslationCache] Failed to persist translations', {
                count: entries.length,
                error: err instanceof Error ? err.message : String(err),
            });
        })
        .then(() => {
            flushInFlight = null;
        });

    return flushInFlight;
}

/**
 * Every cached translation for one language, most-recently-used first, as the
 * `sourceText → translatedText` Map the store holds.
 *
 * Returns an empty Map on any error: a missing cache is a slow app, a throwing
 * hydrate is a broken one.
 */
export async function loadTranslationCache(
    targetLang: string,
    limit: number = TRANSLATION_CACHE_HYDRATE_LIMIT,
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!targetLang || targetLang === 'en') return out;
    try {
        const rows = await database
            .get<TranslationCache>('translation_cache')
            .query(
                Q.where('target_lang', targetLang),
                Q.sortBy('last_used_at', Q.desc),
                Q.take(limit),
            )
            .fetch();
        for (const row of rows) {
            if (row.sourceText && row.translatedText) out.set(row.sourceText, row.translatedText);
        }
        logger.debug('[TranslationCache] Hydrated', { targetLang, count: out.size });
    } catch (err) {
        logger.warn('[TranslationCache] Failed to hydrate', {
            targetLang,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    return out;
}

/**
 * Delete rows untouched for {@link TRANSLATION_CACHE_TTL_DAYS}. Returns how
 * many were removed. Never throws.
 */
export async function sweepTranslationCache(
    ttlDays: number = TRANSLATION_CACHE_TTL_DAYS,
    now: number = Date.now(),
): Promise<number> {
    const cutoff = now - ttlDays * DAY_MS;
    try {
        const collection = database.get<TranslationCache>('translation_cache');
        const stale = await collection.query(Q.where('last_used_at', Q.lt(cutoff))).fetch();
        if (stale.length === 0) return 0;
        await database.write(async () => {
            await database.batch(...stale.map((row) => row.prepareDestroyPermanently()));
        });
        logger.debug('[TranslationCache] Swept stale rows', { count: stale.length });
        return stale.length;
    } catch (err) {
        logger.warn('[TranslationCache] Sweep failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return 0;
    }
}

/** Test seam — drops anything buffered without writing it. */
export function __resetTranslationCacheBufferForTests(): void {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    writeBuffer.clear();
    flushInFlight = null;
}

/** Test seam — how many writes are buffered right now. */
export function __translationCacheBufferSizeForTests(): number {
    return writeBuffer.size;
}
