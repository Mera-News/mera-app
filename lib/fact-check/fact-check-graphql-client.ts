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
 * `mirrorArticleFactCheck` (bottom of this file) is the EXCEPTION THAT PROVES
 * THE RULE, and it is exempt because it makes NO request at all: it lands a
 * check that already came back attached to `articleById`. That is what lets a
 * reader see a check somebody else paid for without either of them being
 * asked, or recorded, for it.
 */

import { gql } from '@apollo/client';
import client from '../apollo-client';
import logger from '../logger';
import {
    listFactChecksByStatus,
    upsertFactCheck,
} from '../database/services/fact-check-record-service';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import type { FactCheck as GeneratedFactCheck } from '../generated/graphql-types';
import { FACT_CHECK_FIELDS } from './fact-check-fields';
import { isTerminalStatus } from './fact-check-state';
import type { FactCheckRow } from './fact-check-types';

const GET_FACT_CHECK = gql`
  query GetFactCheck($articleId: ID!) {
    factCheck(articleId: $articleId) {
      ${FACT_CHECK_FIELDS}
    }
  }
`;

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
 * `fetchFactCheck` PLUS the mirror write into the on-device `fact_checks`
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
): Promise<FactCheckQueryOutcome> {
    try {
        const outcome = await fetchFactCheck(articleId);
        if (outcome.row) {
            await upsertFactCheck({
                articleId,
                factCheckId: String(outcome.row._id ?? ''),
                articleTitle: outcome.row.articleTitle ?? articleTitle ?? null,
                status: outcome.row.status,
                verdict: outcome.row.verdict ?? null,
                payload: outcome.row,
            });
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
        return outcome;
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-graphql-client', method: 'requestFactCheck' },
            extra: { articleId },
        });
        return { terminal: false, row: null };
    }
}

/**
 * Mirror a fact check that arrived ON AN ARTICLE into the local `fact_checks`
 * table. NO NETWORK CALL — the row was already in the `articleById` response.
 *
 * THIS IS WHAT MAKES A CACHED CHECK VISIBLE TO SOMEBODY WHO DID NOT ASK FOR
 * IT. Checks are cached server-side and keyed on the article, deliberately
 * holding no user identity, so the cache was always cross-user — but only the
 * device that asked ever had a local row, and `useFactCheck` reports `absent`
 * (and `FactCheckPanel` renders nothing) when the LOCAL table is empty. User A
 * paid for the check; user B opened the same article and saw nothing. Writing
 * the row here is the whole fix: from that point the existing live
 * WatermelonDB subscription and the existing panel render it, with no new
 * render path.
 *
 * `factCheckEnabled` is honoured HERE rather than only at the call sites: a
 * reader who turned the feature off must not accumulate fact-check rows on
 * their device as a side effect of reading articles.
 *
 * Never throws, for the same reason `requestFactCheck` doesn't — a failed
 * mirror must cost the reader a missing panel, never a failed article open.
 */
export async function mirrorArticleFactCheck(
    articleId: string,
    // The codegen'd `NewsArticle.factCheck` and the hand-written `FactCheckRow`
    // describe the same payload and differ only in how tightly a couple of
    // string fields are typed (see fact-check-types.ts's header). Accept either
    // and narrow ONCE, here, rather than making every screen cast.
    factCheck: FactCheckRow | GeneratedFactCheck | null | undefined,
    articleTitle?: string | null,
): Promise<boolean> {
    if (!factCheck || !articleId) return false;

    const row = factCheck as FactCheckRow;
    try {
        await upsertFactCheck({
            articleId,
            factCheckId: String(row._id ?? ''),
            articleTitle: row.articleTitle ?? articleTitle ?? null,
            status: row.status,
            verdict: row.verdict ?? null,
            payload: row,
        });
        return true;
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'fact-check-graphql-client', method: 'mirrorArticleFactCheck' },
            extra: { articleId },
        });
        return false;
    }
}

/** Statuses `requestFactCheck` treats as "not yet confirmed" — see
 *  `isTerminalStatus`. `failed` is included: the server's own recovery cron
 *  re-drives it, so from a device that only ever reads, a `failed` row is
 *  indistinguishable from one still in flight. */
const NON_TERMINAL_STATUSES = ['pending', 'running', 'failed'] as const;

/** Combined cap across every non-terminal status this sweeps — r14 P2b's own
 *  bound for the same shape of problem ("costs one bounded server read per
 *  UNRESOLVED row"), carried forward rather than re-derived. */
const RECONCILE_CAP = 20;

/**
 * Re-asks the server for every LOCALLY non-terminal row, bounded, and lets
 * `requestFactCheck`'s own upsert land any newly-terminal answer.
 *
 * WHY THIS EXISTS. `useFactCheck`'s poll only covers the ONE article currently
 * open. Without this, a check requested via chat and then left (the reader
 * closed the article, or the poll itself gave up at its ceiling — see
 * `POLL_CEILING_MS`) has no path back to the reader except reopening that
 * SAME article. That is the exact bug r14 P2b found and fixed once already
 * ("a completed check was stuck forever" — "The Dashboard block and the
 * fact-checks list did ZERO server reads, ever"), recreated here because this
 * wave moved the check server-side again. This wave's own copy makes the same
 * promise the Dashboard has to honour: `factCheck.queuedHint` and
 * `factCheck.stillChecking` both tell the reader to look there.
 *
 * Structural bound, not a poll: no interval, called once per Dashboard "Fact
 * checks" chip selection (see `FactChecksPanel`'s `active` effect) — a settled
 * table costs zero requests, since `listFactChecksByStatus` only ever returns
 * non-terminal rows.
 *
 * Never throws: `requestFactCheck` already swallows its own failures, so one
 * bad row degrades to "still pending" rather than aborting the sweep for
 * every row after it.
 */
export async function reconcileStoredFactChecks(): Promise<void> {
    let budget = RECONCILE_CAP;
    for (const status of NON_TERMINAL_STATUSES) {
        if (budget <= 0) return;
        // eslint-disable-next-line no-await-in-loop -- bounded (RECONCILE_CAP),
        // and each round trip's own upsert must land before the next read
        // decides how much budget remains.
        const rows = await listFactChecksByStatus(status, budget);
        for (const row of rows) {
            if (budget <= 0) return;
            budget -= 1;
            // eslint-disable-next-line no-await-in-loop -- see above.
            await requestFactCheck(row.articleId, row.articleTitle);
        }
    }
}
