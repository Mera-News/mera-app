// fold-readiness — when the Feed may draw its fold (D5). Pure reducer, latched
// per reading session: `resetSession` starts a new state.
//
// The fold says "you're up to date", so it must never show while the session's
// first scoring run is still reading. Ready when either:
//   (A) a processing run finished after the session started
//       (`lastProcessingRunFinishedAt`), or
//   (B) nothing started scoring this session, the feed has been idle (no sync
//       and no processing) for FOLD_IDLE_MS, and a sync ran, or the phone is
//       offline, or FOLD_NO_SYNC_MS passed since the session started.
// Before then the Feed shows its quiet reading line and hides Low rows.

/** Idle this long before (B) applies. */
export const FOLD_IDLE_MS = 3_000;
/** (B)'s fallback when no sync ran and the phone is online. */
export const FOLD_NO_SYNC_MS = 20_000;

export interface FoldReadiness {
  readonly ready: boolean;
  readonly sessionStart: number;
  /** A scoring run was seen this session: only (A) can ready it now. */
  readonly scoringStarted: boolean;
  /** Since when sync and processing have both been quiet; null while busy. */
  readonly idleSince: number | null;
}

/** What the screen sees at one moment. */
export interface FoldObservation {
  readonly now: number;
  readonly lastRunFinishedAt: number | null;
  /** `useFeedSyncRunning() || useIsFeedProcessing()`. */
  readonly busy: boolean;
  /** A scoring run is active (`pickScoringProgress` has a run). */
  readonly scoring: boolean;
  /** A sync finished since the session started. */
  readonly syncRan: boolean;
  readonly offline: boolean;
}

export function startFoldReadiness(sessionStart: number): FoldReadiness {
  return { ready: false, sessionStart, scoringStarted: false, idleSince: null };
}

export function nextFoldReadiness(prev: FoldReadiness, o: FoldObservation): FoldReadiness {
  if (prev.ready) return prev;
  const scoringStarted = prev.scoringStarted || o.scoring;
  const idleSince = o.busy ? null : (prev.idleSince ?? o.now);
  const runFinished = o.lastRunFinishedAt != null && o.lastRunFinishedAt > prev.sessionStart;
  const quiet =
    !scoringStarted &&
    idleSince != null &&
    o.now - idleSince >= FOLD_IDLE_MS &&
    (o.syncRan || o.offline || o.now - prev.sessionStart >= FOLD_NO_SYNC_MS);
  return { ready: runFinished || quiet, sessionStart: prev.sessionStart, scoringStarted, idleSince };
}

/** When (B) could next flip with nothing else changing, so the hook arms one
 *  timer instead of polling. Null when only a new observation can change it. */
export function foldReadinessWakeAt(s: FoldReadiness, o: FoldObservation): number | null {
  if (s.ready || s.scoringStarted || s.idleSince == null) return null;
  const idleDue = s.idleSince + FOLD_IDLE_MS;
  return o.syncRan || o.offline ? idleDue : Math.max(idleDue, s.sessionStart + FOLD_NO_SYNC_MS);
}
