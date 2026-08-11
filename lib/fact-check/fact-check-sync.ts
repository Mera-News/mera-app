/**
 * Reconciling a locally-stored fact check against the server — ONE read, never
 * a loop.
 *
 * WHY THIS FILE EXISTS. Removing the poll left exactly two paths from "asked"
 * to "answered": a read when a surface mounts, and the push notification. The
 * first shipped in `use-fact-check` only, so the Dashboard block and the
 * /logged-in/fact-checks list rendered whatever the local table happened to
 * hold and never once asked whether it was still true. A user whose push never
 * arrived — notifications denied, no token, a dev client, a dropped send —
 * therefore sat on "Still searching" forever, which is the same failure this
 * wave set out to remove, moved one step later.
 *
 * So the read lives here, once, and every surface that renders a stored row
 * calls it. The bound is structural, not a timer: one server read per
 * non-terminal row per invocation, and invocations are tied to a mount, a
 * focus, or a deliberate pull-to-refresh. There is NO interval here and none
 * may be added — if a result needs to arrive without the user doing anything,
 * that is the push notification's job, not a poll's.
 *
 * The DB write is AWAITED, unlike the fire-and-forget version this replaces.
 * That mattered: a surface that reconciled and then re-read the table could
 * still observe the pre-write row and redraw the stale state it had just fixed.
 */

import {
    getFactCheckForArticle,
    listFactChecks,
    upsertFactCheck,
    type StoredFactCheck,
} from '../database/services/fact-check-record-service';
import logger from '../logger';
import { FactCheckService, type FactCheckRow } from './fact-check-service';
import { isTerminalStatus } from './fact-check-state';

/**
 * Upper bound on how many unresolved rows one list-level reconcile will look
 * up. A user asks for fact checks a handful at a time, so this is generous;
 * it exists so a pathological table can never turn a pull-to-refresh into a
 * hundred concurrent queries.
 */
export const MAX_RECONCILE_PER_PASS = 20;

/** Writes one server row into the local table. Awaited by every caller. */
async function store(articleId: string, row: FactCheckRow): Promise<void> {
    await upsertFactCheck({
        articleId,
        factCheckId: String(row._id ?? ''),
        articleTitle: row.articleTitle ?? null,
        status: row.status,
        verdict: row.verdict ?? null,
        payload: row,
    });
}

export interface ReconcileResult {
    /** The row as it stands after the pass — refreshed if the server had more. */
    readonly stored: StoredFactCheck | null;
    /** True when this pass actually moved the row on (usually to terminal). */
    readonly changed: boolean;
    /** True when a server read was attempted and failed (offline, plan, etc.). */
    readonly failed: boolean;
}

/**
 * Bring ONE article's stored fact check up to date.
 *
 * Returns immediately for a row that is already terminal (nothing can change)
 * or absent (nobody asked on this device, so there is nothing to reconcile and
 * no call worth spending). Otherwise: exactly one `factCheck` read, persisted
 * and re-read so the caller gets what the table now actually holds.
 *
 * Never throws. `failed` is reported rather than raised because every caller
 * is a render path where the honest response to a failed refresh is to keep
 * showing the stored row and offer the user a way to ask again.
 */
export async function reconcileFactCheck(
    articleId: string | null | undefined,
    knownStored?: StoredFactCheck | null,
): Promise<ReconcileResult> {
    if (!articleId) return { stored: null, changed: false, failed: false };

    const stored = knownStored !== undefined
        ? knownStored
        : await getFactCheckForArticle(articleId);

    if (!stored) return { stored: null, changed: false, failed: false };
    if (isTerminalStatus(stored.status) && stored.payload) {
        return { stored, changed: false, failed: false };
    }

    try {
        const row = await FactCheckService.getFactCheck(articleId);
        if (!row) return { stored, changed: false, failed: false };
        await store(articleId, row);
        const refreshed = await getFactCheckForArticle(articleId);
        return {
            stored: refreshed ?? stored,
            changed: row.status !== stored.status,
            failed: false,
        };
    } catch (err) {
        // Offline, or the plan does not cover this. Not an error report — the
        // user did not ask for this read and the stored row is still on screen.
        // It IS reported back so the surface can offer a manual retry rather
        // than silently pretending the refresh happened.
        logger.debug('[fact-check-sync] reconcile failed', {
            articleId,
            error: String(err),
        });
        return { stored, changed: false, failed: true };
    }
}

/**
 * Bring every unresolved stored row up to date, in one bounded pass.
 *
 * Used by the Dashboard block and the list screen, which render many rows and
 * previously read none of them. Terminal rows are skipped entirely, so the
 * steady-state cost of opening the Dashboard is zero requests.
 *
 * Returns the number of rows that actually moved, so a caller can skip a
 * re-render when nothing did.
 */
export async function reconcileStoredFactChecks(
    items?: readonly StoredFactCheck[],
): Promise<number> {
    const rows = items ?? (await listFactChecks());
    const pending = rows
        .filter((row) => !isTerminalStatus(row.status))
        .slice(0, MAX_RECONCILE_PER_PASS);
    if (pending.length === 0) return 0;

    const results = await Promise.all(
        pending.map((row) => reconcileFactCheck(row.articleId, row)),
    );
    return results.filter((r) => r.changed).length;
}
