/**
 * How long the Feed card may say "Writing a note" for one row, counted from the
 * first moment THIS PROCESS saw that row's reasons in flight since it last
 * entered the in-flight set. Mirrors the
 * pipeline's own stale bound (`MARK_STALE_MS` in for-you/use-mark-active.ts,
 * mirrored rather than imported because that module sits in an unowned
 * directory). The in-flight set is the real end signal; this only stops a
 * batch that never settles from claiming work forever.
 *
 * Anchored on first sight, NOT on `scoredAt`: a background run applies
 * relevance while the app is closed, hours before anyone looks, so a
 * `scoredAt` anchor would be expired on the first frame after open.
 */
export const REASON_WRITING_BACKSTOP_MS = 15 * 60_000;

/** Row id → epoch ms this process first saw its reasons in flight (dropped when
 *  the id leaves the set, see `pruneReasonsInFlight`). Module
 *  level, so list virtualisation (unmount + remount) cannot restart the clock,
 *  and a cold launch starts it fresh, which is what "first sight" means. */
const firstInFlightAt = new Map<string, number>();

/** Record (once) that `id` was seen in flight at `nowMs`; returns the anchor. */
export function noteReasonInFlight(id: string, nowMs: number = Date.now()): number {
    const seen = firstInFlightAt.get(id);
    if (seen !== undefined) return seen;
    firstInFlightAt.set(id, nowMs);
    return nowMs;
}

/** Forget every id that is no longer in flight, so a later re-entry gets a fresh anchor. */
export function pruneReasonsInFlight(inFlight: ReadonlySet<string>): void {
    for (const id of firstInFlightAt.keys()) {
        if (!inFlight.has(id)) firstInFlightAt.delete(id);
    }
}

/** Test seam: forget every recorded first sight. */
export function resetReasonInFlightForTest(): void {
    firstInFlightAt.clear();
}
