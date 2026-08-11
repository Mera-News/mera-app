// Persistence for on-device fact checks (`fact_checks`, schema v51).
//
// WHY THIS EXISTS. The fact check used to be a request the reader waited out:
// tap, poll every 3s, give up at 60s. It is now fire-and-forget — the request
// goes out, the app renders "we'll tell you when it's done", and the answer
// arrives minutes later (via push, or on the next visit to the article). With
// no local store the answer had nowhere to land: leaving the screen threw it
// away, and there was no surface that could list what had ever been checked.
//
// v52 — THE KEY CHANGED, AND WITH IT WHAT THIS TABLE IS.
//
// It used to be one row per ARTICLE, backed by a cross-user server cache: a
// wiped row could always be re-fetched by article id, which is what made the
// per-row delete on the list screen cheap rather than destructive. Neither half
// of that is true any more. The check is now "this CLAIM in this article" — the
// user picks one assertion out of the three or four the picker proposes and can
// come back for another — and the whole job runs on this device, so a deleted
// row is gone for good.
//
// The upsert key is therefore `(article_id, claim_key)`. Two consequences that
// are easy to get wrong and are both covered by tests:
//
//  1. The duplicate-collapse below must be scoped to the SAME composite key.
//     Collapsing on `article_id` alone would make each new claim destroy the
//     previous claim's answer.
//  2. A v51 row has `claim_key = NULL` and that null is meaningful: it is a
//     legacy whole-article check. A keyed lookup must never match it, so it
//     keeps its own slot next to per-claim rows instead of being overwritten.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import FactCheckRecord from '../models/FactCheckRecord';
import logger from '../../logger';

/** A stored fact check, already parsed, as every UI surface wants it. */
export interface StoredFactCheck<TPayload = any> {
    /** WatermelonDB row id — the delete key on the list screen. */
    readonly id: string;
    readonly articleId: string;
    readonly factCheckId: string;
    readonly articleTitle: string | null;
    readonly status: string;
    readonly verdict: string | null;
    /** The whole server row (claims, citations, `checkedBy`), or null if the
     *  stored JSON could not be parsed — never a throw on a read path. */
    readonly payload: TPayload | null;
    readonly requestedAt: number;
    readonly resolvedAt: number | null;
    /** The verbatim assertion checked. Null on a legacy (v51) whole-article row. */
    readonly claim: string | null;
    /** Normalised hash of `claim`. Null ⇒ legacy whole-article row. */
    readonly claimKey: string | null;
}

const collection = () => database.get<FactCheckRecord>('fact_checks');

function toStored(row: FactCheckRecord): StoredFactCheck {
    let payload: any = null;
    try {
        payload = row.payloadJson ? JSON.parse(row.payloadJson) : null;
    } catch {
        // A corrupt payload degrades to "we know a check exists, we just can't
        // render its detail" — the row's own status/verdict columns still work.
        payload = null;
    }
    return {
        id: row.id,
        articleId: row.articleId,
        factCheckId: row.factCheckId,
        articleTitle: row.articleTitle ?? null,
        status: row.status,
        verdict: row.verdict ?? null,
        payload,
        requestedAt: row.requestedAt ? row.requestedAt.getTime() : 0,
        resolvedAt: row.resolvedAt ? row.resolvedAt.getTime() : null,
        claim: row.claim ?? null,
        claimKey: row.claimKey ?? null,
    };
}

/** Fields a caller supplies when recording a check. Everything else is derived. */
export interface UpsertFactCheckInput {
    readonly articleId: string;
    readonly factCheckId: string;
    readonly articleTitle?: string | null;
    readonly status: string;
    readonly verdict?: string | null;
    /** The full server row. Serialized verbatim into `payload_json`. */
    readonly payload: unknown;
    /** Completion time, when the row is terminal. Defaults to now for terminal
     *  statuses so the list can say when an answer landed. */
    readonly resolvedAt?: number | null;
    /** The verbatim assertion. Omit for a legacy whole-article check. */
    readonly claim?: string | null;
    /** Second half of the upsert key. Omit ⇒ the legacy `claim_key IS NULL` slot. */
    readonly claimKey?: string | null;
}

const TERMINAL: ReadonlySet<string> = new Set(['complete', 'blocked']);

/** The clauses that identify ONE stored check. Exported so the query the
 *  service actually runs is assertable, rather than trusted. */
export function claimKeyClauses(articleId: string, claimKey?: string | null) {
    return [
        Q.where('article_id', articleId),
        // `claim_key` is nullable and the null is meaningful — see the header.
        // `Q.where(col, null)` compiles to `IS NULL`, which is the ONLY thing
        // that matches a v51 row; a keyed lookup compiles to `= 'x'` and cannot.
        Q.where('claim_key', claimKey == null ? null : claimKey),
    ];
}

/**
 * Insert-or-update the row for one (article, claim).
 *
 * Idempotent and last-write-wins on every field except `requested_at`, which is
 * only set on insert — the list is ordered by "when did I ask for this", and an
 * answer landing minutes later must not jump the row to the top as if it were a
 * fresh request.
 */
export async function upsertFactCheck(
    input: UpsertFactCheckInput,
): Promise<void> {
    if (!input.articleId) return;
    const payloadJson = (() => {
        try {
            return JSON.stringify(input.payload ?? null);
        } catch {
            return 'null';
        }
    })();
    const terminal = TERMINAL.has(String(input.status ?? '').trim().toLowerCase());
    const resolvedAt = input.resolvedAt ?? (terminal ? Date.now() : null);

    try {
        await database.write(async () => {
            // Scoped to the COMPOSITE key. Querying `article_id` alone here
            // would make the collapse below delete every other claim's answer
            // for this article the first time a second claim was checked.
            const existing = await collection()
                .query(...claimKeyClauses(input.articleId, input.claimKey))
                .fetch();
            const apply = (row: FactCheckRecord) => {
                row.factCheckId = input.factCheckId ?? '';
                row.articleTitle = input.articleTitle ?? null;
                row.status = input.status;
                row.verdict = input.verdict ?? null;
                row.payloadJson = payloadJson;
                row.resolvedAt = resolvedAt != null ? new Date(resolvedAt) : null;
                row.claim = input.claim ?? null;
                row.claimKey = input.claimKey ?? null;
            };
            if (existing.length > 0) {
                await existing[0].update(apply);
                // Any accidental duplicates OF THIS SAME CLAIM (a pre-index
                // race) collapse here rather than accumulating in the list.
                for (const dupe of existing.slice(1)) {
                    await dupe.destroyPermanently();
                }
                return;
            }
            await collection().create((row) => {
                row.articleId = input.articleId;
                row.requestedAt = new Date();
                apply(row);
            });
        });
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-record-service', method: 'upsertFactCheck' },
            extra: { articleId: input.articleId },
        });
    }
}

/**
 * EVERY stored check for one article, newest request first.
 *
 * This is the read the panel wants post-v52: an article can carry a legacy
 * whole-article row plus one row per claim the user has picked, and all of them
 * are renderable.
 */
export async function listFactChecksForArticle(
    articleId: string,
): Promise<StoredFactCheck[]> {
    if (!articleId) return [];
    try {
        const rows = await collection()
            .query(Q.where('article_id', articleId), Q.sortBy('requested_at', Q.desc))
            .fetch();
        return rows.map(toStored);
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-record-service', method: 'listFactChecksForArticle' },
            extra: { articleId },
        });
        return [];
    }
}

/**
 * The stored check for one (article, claim), or null.
 *
 * Omitting `claimKey` asks for the LEGACY whole-article row specifically, not
 * "any row for this article" — `claim_key IS NULL` is a slot of its own.
 */
export async function getFactCheckForClaim(
    articleId: string,
    claimKey?: string | null,
): Promise<StoredFactCheck | null> {
    if (!articleId) return null;
    try {
        const rows = await collection()
            .query(...claimKeyClauses(articleId, claimKey))
            .fetch();
        return rows.length > 0 ? toStored(rows[0]) : null;
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-record-service', method: 'getFactCheckForClaim' },
            extra: { articleId },
        });
        return null;
    }
}

/**
 * The first stored check for one article, or null.
 *
 * Kept for the orphan-card path, which knows an article id and nothing else.
 * Post-v52 an article may hold several rows — prefer
 * {@link listFactChecksForArticle} anywhere the answer is rendered.
 */
export async function getFactCheckForArticle(
    articleId: string,
): Promise<StoredFactCheck | null> {
    const rows = await listFactChecksForArticle(articleId);
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Rows sitting in a non-terminal status — the recovery task's input.
 *
 * Filtering is done in SQL on `status`, but the staleness decision is NOT: a
 * re-driven row keeps its original `requested_at` (see {@link upsertFactCheck}),
 * so "how long has this attempt been running" lives in the payload and is the
 * caller's to read.
 */
export async function listFactChecksByStatus(
    status: string,
    limit = 20,
): Promise<StoredFactCheck[]> {
    try {
        const rows = await collection()
            .query(Q.where('status', status), Q.sortBy('requested_at', Q.desc), Q.take(limit))
            .fetch();
        return rows.map(toStored);
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-record-service', method: 'listFactChecksByStatus' },
            extra: { status },
        });
        return [];
    }
}

/**
 * Every stored check, newest request first.
 *
 * `limit` exists for the Dashboard's 3-card block; the list screen passes
 * nothing. Sorting is done in SQL so the Dashboard never materializes the whole
 * table just to slice three rows off it.
 */
export async function listFactChecks(limit?: number): Promise<StoredFactCheck[]> {
    try {
        const clauses: any[] = [Q.sortBy('requested_at', Q.desc)];
        if (typeof limit === 'number' && limit > 0) clauses.push(Q.take(limit));
        const rows = await collection().query(...clauses).fetch();
        return rows.map(toStored);
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-record-service', method: 'listFactChecks' },
        });
        return [];
    }
}

/** Permanently removes one stored check. The server cache is untouched. */
export async function deleteFactCheck(id: string): Promise<void> {
    try {
        await database.write(async () => {
            const row = await collection().find(id);
            await row.destroyPermanently();
        });
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-record-service', method: 'deleteFactCheck' },
            extra: { id },
        });
    }
}
