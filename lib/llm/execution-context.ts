// ExecutionContext — explicit foreground/background marker passed through
// every inference-gateway call. The auth-selection rule is strict:
//   - foreground → user JWT only (read from keychain)
//   - background → capability token only (read from AsyncStorage)
// No silent fallback in either direction. A foreground call with no JWT or
// a background call with no capability token throws — the cycle stays put,
// the next tick retries with the right credential available.

export type ExecutionContext = 'foreground' | 'background';

/** Map a runBackgroundCycle reason to the execution context that produced
 *  it. Background reasons are the silent-push wakes delivered to the
 *  TaskManager task; everything else originates from a foreground caller
 *  (AppLayout poll, syncFeed, pull-to-refresh, scoring-pass). */
export function contextForCycleReason(
  reason:
    | 'phase1-done'
    | 'phase2-done'
    | 'silent-push'
    | 'app-resume'
    | 'scoring-pass',
): ExecutionContext {
  switch (reason) {
    case 'phase1-done':
    case 'phase2-done':
    case 'silent-push':
      return 'background';
    case 'app-resume':
    case 'scoring-pass':
      return 'foreground';
  }
}
