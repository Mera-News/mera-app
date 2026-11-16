// fold-readiness — when the Feed may draw its fold (D5): never while the
// session's first scoring run is still reading. Latched per session.

import {
  FOLD_IDLE_MS,
  FOLD_NO_SYNC_MS,
  foldReadinessWakeAt,
  nextFoldReadiness,
  startFoldReadiness,
  type FoldObservation,
} from '@/components/custom/feed/fold-readiness';

const T0 = 1_000_000;
const obs = (o: Partial<FoldObservation> & { now: number }): FoldObservation => ({
  lastRunFinishedAt: null,
  busy: false,
  scoring: false,
  syncRan: false,
  offline: false,
  ...o,
});

describe('nextFoldReadiness', () => {
  it('(A) is ready once a processing run finishes after the session started', () => {
    let s = startFoldReadiness(T0);
    s = nextFoldReadiness(s, obs({ now: T0 + 100, busy: true, scoring: true }));
    expect(s.ready).toBe(false);
    // A run that finished BEFORE this session says nothing about it.
    s = nextFoldReadiness(s, obs({ now: T0 + 200, busy: true, scoring: true, lastRunFinishedAt: T0 - 5 }));
    expect(s.ready).toBe(false);
    s = nextFoldReadiness(s, obs({ now: T0 + 300, lastRunFinishedAt: T0 + 250 }));
    expect(s.ready).toBe(true);
  });

  it('no fold while the first scoring run is still processing, even when idle long enough', () => {
    let s = startFoldReadiness(T0);
    s = nextFoldReadiness(s, obs({ now: T0 + 10, busy: true, scoring: true }));
    // The run goes quiet between batches: scoring started, so (B) can no longer apply.
    s = nextFoldReadiness(s, obs({ now: T0 + 20, syncRan: true }));
    s = nextFoldReadiness(s, obs({ now: T0 + 20 + FOLD_IDLE_MS + FOLD_NO_SYNC_MS, syncRan: true }));
    expect(s.ready).toBe(false);
  });

  it('(B) with no scoring this session: ready after idle 3s once a sync ran', () => {
    let s = startFoldReadiness(T0);
    s = nextFoldReadiness(s, obs({ now: T0 + 10, busy: true })); // a sync that found nothing to score
    s = nextFoldReadiness(s, obs({ now: T0 + 1000, syncRan: true }));
    expect(s.ready).toBe(false);
    s = nextFoldReadiness(s, obs({ now: T0 + 1000 + FOLD_IDLE_MS - 1, syncRan: true }));
    expect(s.ready).toBe(false);
    s = nextFoldReadiness(s, obs({ now: T0 + 1000 + FOLD_IDLE_MS, syncRan: true }));
    expect(s.ready).toBe(true);
  });

  it('(B) offline: a failed or impossible sync still readies after the idle wait', () => {
    let s = startFoldReadiness(T0);
    s = nextFoldReadiness(s, obs({ now: T0, offline: true }));
    s = nextFoldReadiness(s, obs({ now: T0 + FOLD_IDLE_MS, offline: true }));
    expect(s.ready).toBe(true);
  });

  it('(B) with no sync and online: waits for the 20s fallback', () => {
    let s = startFoldReadiness(T0);
    s = nextFoldReadiness(s, obs({ now: T0 }));
    s = nextFoldReadiness(s, obs({ now: T0 + FOLD_IDLE_MS }));
    expect(s.ready).toBe(false);
    s = nextFoldReadiness(s, obs({ now: T0 + FOLD_NO_SYNC_MS - 1 }));
    expect(s.ready).toBe(false);
    s = nextFoldReadiness(s, obs({ now: T0 + FOLD_NO_SYNC_MS }));
    expect(s.ready).toBe(true);
  });

  it('busy resets the idle clock', () => {
    let s = startFoldReadiness(T0);
    s = nextFoldReadiness(s, obs({ now: T0, syncRan: true }));
    s = nextFoldReadiness(s, obs({ now: T0 + 2000, busy: true, syncRan: true }));
    s = nextFoldReadiness(s, obs({ now: T0 + 2500, syncRan: true }));
    s = nextFoldReadiness(s, obs({ now: T0 + 2500 + FOLD_IDLE_MS - 1, syncRan: true }));
    expect(s.ready).toBe(false);
    s = nextFoldReadiness(s, obs({ now: T0 + 2500 + FOLD_IDLE_MS, syncRan: true }));
    expect(s.ready).toBe(true);
  });

  it('is latched: once ready, a new run never hides the fold again this session', () => {
    let s = startFoldReadiness(T0);
    s = nextFoldReadiness(s, obs({ now: T0 + 5, lastRunFinishedAt: T0 + 1 }));
    expect(s.ready).toBe(true);
    const again = nextFoldReadiness(s, obs({ now: T0 + 10, busy: true, scoring: true }));
    expect(again).toBe(s);
  });

  it('a new session starts unready', () => {
    expect(startFoldReadiness(T0).ready).toBe(false);
  });
});

describe('foldReadinessWakeAt', () => {
  it('names the moment the idle rule can next flip, so the hook needs no polling', () => {
    let s = startFoldReadiness(T0);
    s = nextFoldReadiness(s, obs({ now: T0 + 100, syncRan: true }));
    expect(foldReadinessWakeAt(s, obs({ now: T0 + 100, syncRan: true }))).toBe(T0 + 100 + FOLD_IDLE_MS);
    // No sync yet and online: the later of the idle wait and the fallback.
    expect(foldReadinessWakeAt(s, obs({ now: T0 + 100 }))).toBe(T0 + FOLD_NO_SYNC_MS);
  });

  it('is null when nothing time-based can flip it', () => {
    const ready = nextFoldReadiness(startFoldReadiness(T0), obs({ now: T0, lastRunFinishedAt: T0 + 1 }));
    expect(foldReadinessWakeAt(ready, obs({ now: T0 }))).toBeNull();
    const busy = nextFoldReadiness(startFoldReadiness(T0), obs({ now: T0, busy: true }));
    expect(foldReadinessWakeAt(busy, obs({ now: T0, busy: true }))).toBeNull();
    const scored = nextFoldReadiness(startFoldReadiness(T0), obs({ now: T0, scoring: true }));
    expect(foldReadinessWakeAt(scored, obs({ now: T0 + 1 }))).toBeNull();
  });
});
