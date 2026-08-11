/**
 * The fact-check OBSERVER for the article detail screens and the action-row
 * tick.
 *
 * THIS HOOK DOES NOTHING BUT WATCH. There is no mutation, no network query, and
 * no reconcile pass — the whole request/response dance (`requestFactCheck`
 * mutation, `factCheck` query, the `reconcileFactCheck` read-on-mount) is gone
 * along with the server pipeline it talked to. Starting a check is
 * `startFactCheckChat` (opens the floating chat, which stages a claim and calls
 * F2's `enqueueFactCheck`); this hook only ever reads back what that produced.
 *
 *   absent ── enqueueFactCheck writes a row ──► processing ──► terminal
 *
 * `absent` — nobody has asked about this article on this device.
 * `processing` — at least one claim is still being checked. A `processing` row
 *   coexists with already-`terminal` ones the moment a second claim is picked,
 *   so this is an AGGREGATE across every stored row, not one row's state.
 * `terminal` — every asked-for claim has an answer (`complete` or `blocked`;
 *   see `isTerminalStatus`). `failed` rows are NOT terminal: F2's recovery task
 *   re-drives them, so from the reader's side a `failed` row is indistinguishable
 *   from one still in flight.
 *
 * LIVE, NOT POLLED. `enqueueFactCheck` writes the row once and the runner then
 * UPDATES THAT SAME ROW as it progresses — no new row is ever inserted for an
 * existing claim. A plain WatermelonDB `.observe()` only re-emits when the
 * matched ROW SET changes (rows added/removed), so it would never notice the
 * runner flipping `processing` → `complete` in place and the panel would spin
 * forever. `.observeWithColumns([...])` is what actually re-emits on an
 * in-place field change, which is the only way "the detail screen shows
 * processing → result while the reader is still looking at it" can be true.
 *
 * Queried directly against the WatermelonDB collection rather than through
 * `fact-check-record-service.ts` (F2's file, not this wave's to edit): the
 * service only exposes one-shot reads, and this hook needs a live subscription.
 * `article_id` is the one column this depends on, and it is untouched by the
 * v52 migration (additive-only — see CLAUDE.md's WatermelonDB migration
 * policy), so this stays correct across it.
 */

import { Q } from '@nozbe/watermelondb';
import { useEffect, useState } from 'react';
import database from '../database/index';
import FactCheckRecord from '../database/models/FactCheckRecord';
import type { StoredFactCheck } from '../database/services/fact-check-record-service';
import type { FactCheckRow } from './fact-check-types';
import {
    isTerminalStatus,
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

function computePhase(rows: readonly StoredFactCheck<FactCheckRow>[]): FactCheckPhase {
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
            // See the file header — plain `.observe()` would miss the runner
            // updating an existing row in place.
            .observeWithColumns(['status', 'verdict', 'payload_json', 'resolved_at'])
            .subscribe((records) => setRows(records.map(toStoredRow)));
        return () => subscription.unsubscribe();
    }, [articleId]);

    const phase = computePhase(rows);

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
