/**
 * GraphQL access for the article fact check — the SERVER (async) path.
 *
 * ONE operation, matching the SDL this file was built against verbatim:
 *
 *   factCheck(articleId: ID!): FactCheck
 *
 * Unlike the pre-pivot design (a `requestFactCheck` mutation plus a read-only
 * `factCheck` query), this single query is documented to do all three things
 * a caller might need in one round trip:
 *   - a TERMINAL cached row (this article, or one another user already
 *     checked — the server's cache is cross-user) comes back immediately;
 *   - NO row yet ⇒ the server inserts a `pending` row and enqueues the job,
 *     and this call returns a not-yet-confirmed result;
 *   - a row already IN FLIGHT ⇒ same not-yet-confirmed result, no new job.
 *
 * `no-cache`, matching every other live query in this app: the point of
 * calling this more than once is to find out whether the answer changed,
 * which is exactly what an Apollo cache hit would hide.
 *
 * ⚠️ BECAUSE THE FIRST CALL FOR AN ARTICLE STARTS A BILLABLE SERVER JOB,
 * `fetchFactCheck` / `requestFactCheck` must only be reached from an EXPLICIT
 * user action — the fact-check tick, and the chat's "The Article" async pill.
 * They must never be called merely because an article screen mounted. See
 * `use-fact-check.ts`'s own guard: it only polls the server once a LOCAL,
 * non-terminal row already exists, i.e. once something has already asked.
 *
 * A CHECK IS VISIBLE ONLY IF THIS DEVICE ASKED FOR IT (owner decision, navx).
 * Nothing here lands a check another reader asked for, and every re-read goes
 * through the asked list (`fact-check-settled.ts`). Rows already stored on a
 * phone before that decision are left exactly as they are.
 */

import { gql } from '@apollo/client';
import client from '../apollo-client';
import logger from '../logger';
import {
    getFactCheckForClaim,
    upsertFactCheck,
} from '../database/services/fact-check-record-service';
import {
    keepArticleForFactCheck,
    type FactCheckKeepInput,
} from '../database/services/saved-article-suggestion-service';
import { FACT_CHECK_FIELDS } from './fact-check-fields';
import { isTerminalStatus } from './fact-check-state';
import type { FactCheckRow } from './fact-check-types';
import {
    listAskedFactChecks,
    noteFactCheckStored,
    recordFactCheckAsked,
} from './fact-check-settled';

const GET_FACT_CHECK = gql`
  query GetFactCheck($articleId: ID!) {
    factCheck(articleId: $articleId) {
      ${FACT_CHECK_FIELDS}
    }
  }
`;

/**
 * Retain the checked article like a saved one, so the check stays openable
 * after the 48h feed prune (`keepArticleForFactCheck` is the single retention
 * write; it swallows its own failures). The screens pass a full article or
 * suggestion snapshot through `keep`; every other caller (the chat pill, the
 * reconcile sweep, the poll loop) degrades to what the server row itself
 * carries — title, url, publication — which `keepArticleForFactCheck` will
 * never let overwrite a richer snapshot already captured.
 */
async function keepCheckedArticle(
    articleId: string,
    keep: FactCheckKeepInput | undefined,
    row: FactCheckRow | null,
    articleTitle?: string | null,
): Promise<void> {
    try {
        await keepArticleForFactCheck(
            keep ?? {
                articleId,
                title: row?.articleTitle ?? articleTitle ?? null,
                articleUrl: row?.articleUrl ?? null,
                publicationName: row?.publicationName ?? null,
            },
        );
    } catch {
        // `keepArticleForFactCheck` swallows and logs its own failures; this
        // catch only defends the contract — a failed keep must never turn a
        // successful ask into a degraded outcome.
    }
}

/**
 * THE ONE STORE for a server check, and so the one place a check that has just
 * settled is noticed. Reads the local row's status first, writes, then hands
 * both to `noteFactCheckStored`, which notifies only for a check this device
 * asked for that went from waiting to settled. The ask, the panel poll and
 * the asked re-read all come through here, so the same change seen by two of them
 * still notifies once (the ask is consumed by the first).
 */
async function storeServerFactCheck(
    articleId: string,
    row: FactCheckRow,
    articleTitle?: string | null,
): Promise<void> {
    const previous = await getFactCheckForClaim(articleId);
    await upsertFactCheck({
        articleId,
        factCheckId: String(row._id ?? ''),
        articleTitle: row.articleTitle ?? articleTitle ?? null,
        status: row.status,
        verdict: row.verdict ?? null,
        payload: row,
    });
    await noteFactCheckStored(articleId, previous?.status ?? null, row);
}

/** One read of `factCheck(articleId)`. `terminal` is derived from `row.status`
 *  via `isTerminalStatus` — the same predicate the render layer uses — so a
 *  caller never has to duplicate that judgement. `row` is null both when the
 *  server has nothing yet (a brand-new `pending` insert may not even echo back
 *  a full row, depending on the resolver) and on a request that failed; the
 *  request failure meaning is only ever visible above this function as a
 *  thrown error, this type only describes a SUCCESSFUL response. */
export interface FactCheckQueryOutcome {
    readonly terminal: boolean;
    readonly row: FactCheckRow | null;
}

/**
 * Raw network call. Throws on transport/GraphQL failure — callers decide how
 * to degrade (the poll loop below treats a throw as "still not confirmed",
 * matching a `queued` response rather than surfacing a network blip as if the
 * check had failed).
 */
export async function fetchFactCheck(articleId: string): Promise<FactCheckQueryOutcome> {
    const { data } = await client.query<{ factCheck: FactCheckRow | null }>({
        query: GET_FACT_CHECK,
        variables: { articleId },
        fetchPolicy: 'no-cache',
    });
    const row = data?.factCheck ?? null;
    return { terminal: !!row && isTerminalStatus(row.status), row };
}

/**
 * `fetchFactCheck` PLUS the write into the on-device `fact_checks`
 * table (v52, `claimKey` omitted — the table's "legacy whole-article" slot,
 * which is exactly what a server (whole-article) check is). This is the ONE
 * function that should ever be used to ASK the server for a check, whether
 * that ask is the first one (kicking the job off) or a later poll:
 *
 *   - the chat's async pill (Q1's tool handler) calls this once to lodge the
 *     request and get back an immediate answer if one is already cached;
 *   - `useFactCheck`'s poll loop calls this repeatedly (bounded — see
 *     `POLL_INTERVAL_MS`/`POLL_CEILING_MS`) to advance a `pending` row to a
 *     terminal one.
 *
 * Idempotent from the caller's point of view either way: a terminal row comes
 * back unchanged on every later call, and a non-terminal one just keeps
 * reporting "not yet".
 *
 * Never throws — a network/GraphQL failure degrades to "not yet confirmed"
 * (nothing written, `terminal: false`) rather than propagating, because every
 * caller's honest response to a failed poll attempt is "try again later", not
 * a crash.
 */
export async function requestFactCheck(
    articleId: string,
    articleTitle?: string | null,
    keep?: FactCheckKeepInput,
    /** True only from a user's own tap (the tick, the chat pill). The panel
     *  poll passes nothing, so a poll can never make a check "asked". */
    explicit = false,
): Promise<FactCheckQueryOutcome> {
    try {
        // THE ASK is recorded before the network call, so an answer that lands
        // while this is in flight is not missed: the first call for an article
        // with no local row, or an explicit tap on one whose local row has not
        // settled (an older row nobody on this device asked for). A tap on a
        // settled row records nothing: there is nothing left to wait for.
        const local = await getFactCheckForClaim(articleId);
        if (local === null || (explicit && !isTerminalStatus(local.status))) {
            await recordFactCheckAsked({
                articleId,
                suggestionId: keep && 'suggestion' in keep ? keep.suggestion._id : null,
                title: articleTitle ?? null,
            });
            ensureAskedFactCheckPoller();
        }
        const outcome = await fetchFactCheck(articleId);
        if (outcome.row) {
            await storeServerFactCheck(articleId, outcome.row, articleTitle);
        } else {
            // Defensive: the SDL documents an insert-and-enqueue on first ask,
            // but a resolver could legitimately answer "lodged" without
            // echoing a full row back on the very first round trip. Record
            // SOMETHING non-terminal locally so the reader sees "processing"
            // rather than "absent" — a request that has no local trace at all
            // is indistinguishable from one that was never made.
            await upsertFactCheck({
                articleId,
                factCheckId: '',
                articleTitle: articleTitle ?? null,
                status: 'pending',
                payload: null,
            });
        }
        await keepCheckedArticle(articleId, keep, outcome.row, articleTitle);
        return outcome;
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-graphql-client', method: 'requestFactCheck' },
            extra: { articleId },
        });
        return { terminal: false, row: null };
    }
}

const GET_CACHED_FACT_CHECK = gql`
  query GetCachedFactCheck($articleId: ID!) {
    cachedFactCheck(articleId: $articleId) {
      ${FACT_CHECK_FIELDS}
    }
  }
`;

/** One read-only re-read through `cachedFactCheck`, stored through the one
 *  store. Never throws; returns the settled-or-not state it saw, or null
 *  when the read failed or the server has no row. */
async function rereadFactCheck(
    articleId: string,
    articleTitle?: string | null,
): Promise<{ terminal: boolean } | null> {
    try {
        const { data } = await client.query<{ cachedFactCheck: FactCheckRow | null }>({
            query: GET_CACHED_FACT_CHECK,
            variables: { articleId },
            fetchPolicy: 'no-cache',
        });
        const row = data?.cachedFactCheck ?? null;
        if (!row) return null;
        await storeServerFactCheck(articleId, row, articleTitle);
        return { terminal: isTerminalStatus(row.status) };
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-graphql-client', method: 'rereadFactCheck' },
            extra: { articleId },
        });
        return null;
    }
}

/** Bound on one re-read pass, carried over from `RECONCILE_CAP`. */
const ASKED_REREAD_CAP = 20;

/**
 * Re-reads the checks THIS DEVICE asked for that have not settled, and lets the
 * one store notify for any that have. The foreground task (data scout's
 * `fact-check-reconcile`) calls it on every return to the app, which, since a
 * return reloads JS, is also how the work survives a reload. The asked list is
 * the filter: a row this device did not ask for (one stored before the
 * community lookup was removed) is never re-read, here or anywhere.
 *
 * Read-only (`cachedFactCheck`), bounded, never throws. Returns how many asks
 * are still waiting.
 */
export async function reconcileAskedFactChecks(): Promise<number> {
    let waiting = 0;
    try {
        const asked = await listAskedFactChecks();
        for (const ask of asked.slice(0, ASKED_REREAD_CAP)) {
            // eslint-disable-next-line no-await-in-loop -- bounded, and each
            // store must land before the next read decides anything.
            const seen = await rereadFactCheck(ask.articleId, ask.title);
            if (!seen || !seen.terminal) waiting++;
        }
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-graphql-client', method: 'reconcileAskedFactChecks' },
        });
    }
    return waiting;
}

/** How often, and for how long, the in-session poller re-reads. Most checks
 *  settle within 30s; past the ceiling the foreground task takes over. */
export const ASKED_POLL_INTERVAL_MS = 6_000;
export const ASKED_POLL_CEILING_MS = 10 * 60_000;

let pollerTimer: ReturnType<typeof setTimeout> | null = null;
let pollerRunning = false;

/**
 * Keeps re-reading asked checks while this JS context lives, so a result that
 * lands after the reader left the article still reaches them in-session. One
 * poller at a time; it stops once nothing is waiting or the ceiling passes.
 * iOS suspends timers in the background and every return reloads JS, so the
 * foreground task is what covers a result that settled while the app was away.
 */
export function ensureAskedFactCheckPoller(now: () => number = Date.now): void {
    if (pollerRunning) return;
    pollerRunning = true;
    const startedAt = now();
    const schedule = () => {
        pollerTimer = setTimeout(() => { void tick(); }, ASKED_POLL_INTERVAL_MS);
    };
    const tick = async () => {
        pollerTimer = null;
        if (!pollerRunning) return;
        const waiting = await reconcileAskedFactChecks();
        if (pollerRunning && waiting > 0 && now() - startedAt < ASKED_POLL_CEILING_MS) {
            schedule();
        } else {
            pollerRunning = false;
        }
    };
    schedule();
}

/** Test seam: stop a poller an earlier test left running. */
export function stopAskedFactCheckPollerForTest(): void {
    pollerRunning = false;
    if (pollerTimer !== null) clearTimeout(pollerTimer);
    pollerTimer = null;
}
