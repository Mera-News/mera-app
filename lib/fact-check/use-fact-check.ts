/**
 * The fact-check OBSERVER + POLLER for the article detail screens and the
 * action-row tick.
 *
 * PIVOT P8d re-adds a real server poll, deleted in pivot P4 when the check
 * briefly ran entirely on-device (no server round trip to wait on). Now the
 * job is server-side again (BullMQ, "no mobile deadline"), so this hook is
 * back to doing two things:
 *
 *   1. LIVE-OBSERVE the on-device `fact_checks` table — unchanged mechanism
 *      from the on-device era, see the `observeWithColumns` note below.
 *   2. POLL THE SERVER, bounded, but ONLY while a local non-terminal row
 *      already exists — i.e. only once something has already asked. An
 *      article nobody has asked about triggers zero network calls, same
 *      invariant the pure-observer version had.
 *
 *   absent ── something writes a non-terminal row ──► processing ──┬─► terminal
 *                                                                   └─► stalled (poll gave up)
 *
 * `absent` — nobody has asked about this article on this device.
 * `processing` — at least one row is non-terminal AND the poll for it hasn't
 *   given up yet. `failed` rows count as processing too: the server's own
 *   recovery cron re-drives them, so from the reader's side a `failed` row is
 *   indistinguishable from one still in flight.
 * `stalled` — a non-terminal row's poll ran out its window (`POLL_CEILING_MS`
 *   in `fact-check-state.ts`) without a terminal answer. THIS MUST NEVER
 *   RENDER LIKE `absent` — see that file's header for why (r14 shipped exactly
 *   that bug once). A fresh mount re-arms a fresh, equally bounded poll.
 * `terminal` — every row has an answer (`complete` or `blocked`; see
 *   `isTerminalStatus`).
 *
 * LIVE, NOT POLLED, FOR THE LOCAL HALF. Whatever writes the row (Q1's chat
 * tool handler lodging the first ask, or this hook's own poll loop advancing
 * it) UPDATES THAT SAME ROW in place — no new row is ever inserted for an
 * existing article. A plain WatermelonDB `.observe()` only re-emits when the
 * matched ROW SET changes (rows added/removed), so it would never notice a
 * poll flipping `pending` → `complete` in place and the panel would spin
 * forever. `.observeWithColumns([...])` is what actually re-emits on an
 * in-place field change, which is the only way "the detail screen shows
 * processing → result while the reader is still looking at it" can be true.
 *
 * Queried directly against the WatermelonDB collection rather than through
 * `fact-check-record-service.ts`: that service only exposes one-shot reads,
 * and this hook needs a live subscription. `article_id` is the one column
 * this depends on, and it is untouched by the v52 migration (additive-only —
 * see CLAUDE.md's WatermelonDB migration policy), so this stays correct
 * across it.
 */

import { Q } from '@nozbe/watermelondb';
import { useEffect, useState } from 'react';
import database from '../database/index';
import FactCheckRecord from '../database/models/FactCheckRecord';
import type { StoredFactCheck } from '../database/services/fact-check-record-service';
import { requestFactCheck } from './fact-check-graphql-client';
import type { FactCheckRow } from './fact-check-types';
import {
    isTerminalStatus,
    POLL_CEILING_MS,
    POLL_INTERVAL_MS,
    PROGRESS_DELAY_MS,
    shouldShowProgress,
    type FactCheckPhase,
} from './fact-check-state';

export type { FactCheckPhase };

export interface UseFactCheckResult {
    /** Aggregate over every stored row for this article. */
    readonly phase: FactCheckPhase;
    /** True once a `processing` row has been in flight long enough to be worth
     *  showing a spinner for — see `PROGRESS_DELAY_MS`. Always false when
     *  `phase !== 'processing'`. */
    readonly showProgress: boolean;
    /** Every stored row for this article, newest request first. Includes
     *  non-terminal rows — a caller rendering the terminal stack should filter
     *  with `isTerminalStatus(row.status)` itself, the same predicate this hook
     *  uses to compute `phase`. */
    readonly rows: readonly StoredFactCheck<FactCheckRow>[];
}

const collection = () => database.get<FactCheckRecord>('fact_checks');

/**
 * WatermelonDB → the render shape. Deliberately duplicated from F2's private
 * `toStored` in `fact-check-record-service.ts` rather than imported: that
 * function isn't exported (by design — the service's contract is its typed
 * read functions, not a raw mapper), and this hook needs a mapper it can run
 * inside a LIVE subscription callback rather than an async read. Same five
 * fields either way; if the shape drifts, `fact-check-record-service.test.ts`
 * and this file's own tests both notice.
 */
function toStoredRow(row: FactCheckRecord): StoredFactCheck<FactCheckRow> {
    let payload: FactCheckRow | null = null;
    try {
        payload = row.payloadJson ? JSON.parse(row.payloadJson) : null;
    } catch {
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

/** The LOCAL phase — never `'stalled'`, which only exists once a poll session
 *  has actually given up; see `useFactCheck`'s combination with `pollGaveUp`. */
function computeLocalPhase(
    rows: readonly StoredFactCheck<FactCheckRow>[],
): 'absent' | 'processing' | 'terminal' {
    if (rows.length === 0) return 'absent';
    return rows.some((row) => !isTerminalStatus(row.status)) ? 'processing' : 'terminal';
}

/** How long the OLDEST still-processing row has been running, in ms. Used to
 *  drive the no-flash gate off the row's own `requestedAt` rather than a mount
 *  timer, so a job that has genuinely been running a while shows immediately on
 *  remount instead of waiting out a second artificial delay. */
function oldestProcessingStartedAt(rows: readonly StoredFactCheck<FactCheckRow>[]): number {
    const started = rows
        .filter((row) => !isTerminalStatus(row.status))
        .map((row) => row.requestedAt || Date.now());
    return started.length > 0 ? Math.min(...started) : Date.now();
}

export function useFactCheck(articleId: string | null | undefined): UseFactCheckResult {
    const [rows, setRows] = useState<readonly StoredFactCheck<FactCheckRow>[]>([]);

    useEffect(() => {
        if (!articleId) {
            setRows([]);
            return;
        }
        const subscription = collection()
            .query(Q.where('article_id', articleId), Q.sortBy('requested_at', Q.desc))
            // See the file header — plain `.observe()` would miss a poll
            // updating an existing row in place.
            .observeWithColumns(['status', 'verdict', 'payload_json', 'resolved_at'])
            .subscribe((records) => setRows(records.map(toStoredRow)));
        return () => subscription.unsubscribe();
    }, [articleId]);

    const localPhase = computeLocalPhase(rows);

    // ── The server poll layer ────────────────────────────────────────────
    // Only runs while a LOCAL non-terminal row already exists — see the file
    // header. Bounded by POLL_INTERVAL_MS / POLL_CEILING_MS (fact-check-state.ts).
    //
    // A terminal result never needs to be read out of this effect: landing it
    // means calling `requestFactCheck`, which UPSERTS the row, which the live
    // subscription above picks up on its own and flips `localPhase` to
    // 'terminal' — at which point this effect re-runs, sees a non-'processing'
    // phase, and exits without scheduling anything further. This effect's own
    // job is only to track whether the CEILING was reached first.
    const [pollGaveUp, setPollGaveUp] = useState(false);

    useEffect(() => {
        // Any re-entry into (or out of) 'processing' — a fresh mount, a new
        // article, or a fresh ask after a prior session stalled — starts a
        // clean poll session. This IS "re-read once on next mount": the
        // effect's first action below is an immediate, unconditional poll.
        setPollGaveUp(false);
        if (!articleId || localPhase !== 'processing') return;

        let cancelled = false;
        let timerId: ReturnType<typeof setTimeout> | null = null;
        const startedAt = Date.now();

        const poll = () => {
            if (cancelled) return;
            requestFactCheck(articleId)
                .then((outcome) => {
                    if (cancelled || outcome.terminal) return;
                    if (Date.now() - startedAt >= POLL_CEILING_MS) {
                        setPollGaveUp(true);
                        return;
                    }
                    timerId = setTimeout(poll, POLL_INTERVAL_MS);
                })
                .catch(() => {
                    // `requestFactCheck` is documented to never reject (it
                    // catches and degrades to "not yet confirmed" internally)
                    // — this is a defensive backstop, not the primary error
                    // path. A misbehaving caller (or a test) throwing here
                    // must not become an unhandled rejection, and must not
                    // silently stop polling either: treat it exactly like a
                    // non-terminal response and try again next interval.
                    if (cancelled) return;
                    if (Date.now() - startedAt >= POLL_CEILING_MS) {
                        setPollGaveUp(true);
                        return;
                    }
                    timerId = setTimeout(poll, POLL_INTERVAL_MS);
                });
        };

        poll();

        return () => {
            cancelled = true;
            if (timerId) clearTimeout(timerId);
        };
    }, [articleId, localPhase]);

    // 'stalled' is the ONLY state a caller can't get by reading `localPhase`
    // alone — it must never collapse into 'absent' (nothing rendered) or into
    // a fabricated 'terminal' (a fake answer). See fact-check-state.ts.
    const phase: FactCheckPhase =
        localPhase === 'processing' && pollGaveUp ? 'stalled' : localPhase;

    const [showProgress, setShowProgress] = useState(false);
    useEffect(() => {
        if (phase !== 'processing') {
            setShowProgress(false);
            return;
        }
        const elapsed = Date.now() - oldestProcessingStartedAt(rows);
        if (shouldShowProgress(phase, elapsed)) {
            setShowProgress(true);
            return;
        }
        const timer = setTimeout(() => setShowProgress(true), PROGRESS_DELAY_MS - elapsed);
        return () => clearTimeout(timer);
        // Re-running per `rows` emission (not just per `phase` flip) is the
        // point: a second claim going `processing` while the first is already
        // terminal must re-arm the gate off ITS OWN `requestedAt`.
    }, [phase, rows]);

    return { phase, showProgress, rows };
}
