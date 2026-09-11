// Per-task cadence jitter for AppScheduler's due checks.
//
// Why this file exists (the specific friction, per the repo's pattern rule):
// every device that foregrounds at the same moment — after a push, after a
// network blip, at the top of a commute — stamps `lastRun` at the same moment,
// and then re-syncs in lockstep for as long as the app stays open. At fleet
// scale that turns a 5-minute cadence into a 5-minute spike. Spreading the DUE
// CHECK, not the request, is what breaks the convoy: the work is unchanged, only
// the moment it becomes due moves.
//
// Applied ONCE here rather than per task, so a task author cannot forget it and
// a new task gets it for free.

/** Fraction of the base interval the jitter may move it, either way. */
export const JITTER_RATIO = 0.2;

/**
 * Per app SESSION, not per run and not per device.
 *
 * Per-run randomness was rejected: it makes a device's own cadence wander, so
 * "when will this next fire" stops being answerable and a task can fire twice in
 * quick succession across two ticks. Per-device persistence was rejected too —
 * it needs a `settings` row, which needs hydration through `hydrateAllStores`,
 * and both due checks are SYNCHRONOUS and run for every task on every 5s tick.
 * A session seed buys the only property that matters (a device does not drift
 * while the app is open) for no storage, no async and no hydration ordering.
 */
let sessionSeed = Math.random();

/** taskName -> factor. The hash runs once per task, not once per tick. */
const factorCache = new Map<string, number>();

/** FNV-1a over the seeded key, normalised to [0, 1). */
function hash01(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

/**
 * Stable multiplier in [1 - JITTER_RATIO, 1 + JITTER_RATIO) for this task, for
 * the life of this app session.
 */
export function jitterFactor(taskName: string): number {
  const cached = factorCache.get(taskName);
  if (cached !== undefined) return cached;
  const factor = 1 + JITTER_RATIO * (2 * hash01(`${sessionSeed}:${taskName}`) - 1);
  factorCache.set(taskName, factor);
  return factor;
}

/**
 * `baseMs` jittered by this task's factor.
 *
 * A non-positive base is returned UNCHANGED, which is load-bearing: `frequency:
 * 0` means "event-driven, always due" everywhere else in the scheduler, and
 * jittering it would turn 0 into a small positive interval and silently give
 * every event-only task a cadence it never declared.
 */
export function jitteredInterval(taskName: string, baseMs: number): number {
  if (baseMs <= 0) return baseMs;
  return Math.round(baseMs * jitterFactor(taskName));
}

/**
 * Test-only. Re-seeds and clears the cache so a spec can assert the FORMULA
 * rather than whatever `Math.random()` happened to return at module load.
 * Nothing in app code calls this; the seed is deliberately not settable at
 * runtime, because a mid-session re-seed is exactly the drift this module
 * exists to prevent.
 */
export function __setJitterSeedForTests(seed: number): void {
  sessionSeed = seed;
  factorCache.clear();
}
