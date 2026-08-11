// Persistence for on-device fact checks (`fact_checks`, schema v51).
//
// WHY THIS EXISTS. The fact check used to be a request the reader waited out:
// tap, poll every 3s, give up at 60s. It is now fire-and-forget — the request
// goes out, the app renders "we'll tell you when it's done", and the answer
// arrives minutes later (via push, or on the next visit to the article). With
// no local store the answer had nowhere to land: leaving the screen threw it
// away, and there was no surface that could list what had ever been checked.
//
// Everything here is derived, single-user, and safe to delete — the server
// keeps its own cross-user cache, so a wiped row can always be re-fetched by
// article id. That is what makes the per-row delete on the list screen a
// genuinely cheap operation rather than data loss.
//
// One row per ARTICLE, not per request. `requestFactCheck` is idempotent
// server-side and returns the same row for repeat taps, so upserting on
// `article_id` is what keeps the list free of duplicates.

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
}

const TERMINAL: ReadonlySet<string> = new Set(['complete', 'blocked']);

/**
 * Insert-or-update the row for one article.
 *
 * Idempotent and last-write-wins on every field except `requested_at`, which is
 * only set on insert — the list is ordered by "when did I ask for this", and a
 * push-driven update arriving hours later must not jump the row to the top as
 * if it were a fresh request.
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
            const existing = await collection()
                .query(Q.where('article_id', input.articleId))
                .fetch();
            const apply = (row: FactCheckRecord) => {
                row.factCheckId = input.factCheckId ?? '';
                row.articleTitle = input.articleTitle ?? null;
                row.status = input.status;
                row.verdict = input.verdict ?? null;
                row.payloadJson = payloadJson;
                row.resolvedAt = resolvedAt != null ? new Date(resolvedAt) : null;
            };
            if (existing.length > 0) {
                await existing[0].update(apply);
                // Any accidental duplicates (a pre-index race) collapse here
                // rather than accumulating in the list forever.
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

/** The stored check for one article, or null. Never throws. */
export async function getFactCheckForArticle(
    articleId: string,
): Promise<StoredFactCheck | null> {
    if (!articleId) return null;
    try {
        const rows = await collection().query(Q.where('article_id', articleId)).fetch();
        return rows.length > 0 ? toStored(rows[0]) : null;
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-record-service', method: 'getFactCheckForArticle' },
            extra: { articleId },
        });
        return null;
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
