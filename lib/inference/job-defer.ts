// job-defer — what counts as "try again later" for a queued inference job,
// and how much later.
//
// A deferral is NOT a failure: the job goes back to pending without spending
// one of its attempts (InferenceJob.markDeferred), and the queue keeps the
// whole job TYPE out of `dequeueJob` until the delay has passed. Deferrable
// means "the conditions were wrong, not the job": the device is offline, there
// is no local session credential yet, or the gateway said "busy" (503) or
// "slow down" (429). Anything else is an ordinary failed attempt.
//
// Only job types the queue lists as deferrable use `isDeferrableError`; today
// that is `topic_combo`, whose pass would otherwise burn three attempts on an
// app closed without a connection. The built-in model's "busy" and
// "unavailable" (`isOnDeviceDeferrable`) defer EVERY job type: Gemini Nano
// refuses background work and has a per-app quota, Apple throttles, and the
// model can be mid-download. None of that is the job's fault.

/** First delay. The idle poll caps at 30s, so anything shorter is noise. */
export const DEFER_BASE_MS = 30_000;
/** Longest delay. A foreground lifts the gate anyway (InferenceQueue). */
export const DEFER_MAX_MS = 120_000;

/** Delay for the `count`-th consecutive deferral of a type (0-based). */
export function deferDelayMs(count: number): number {
  const n = Math.max(0, Math.floor(count));
  return Math.min(DEFER_MAX_MS, DEFER_BASE_MS * 2 ** Math.min(n, 16));
}

/** `E2EE batch failed: 503 …` — cloudBatchComplete puts the status in the TEXT
 *  and attaches no `statusCode`, so the message is the only place to read it. */
const STATUS_IN_MESSAGE = /\bfailed: (503|429)\b/;

/**
 * The built-in on-device model said "not now": busy, over quota, blocked in the
 * background (all ERR_AFM_BUSY) or not available yet (ERR_AFM_UNAVAILABLE).
 * Duck-typed on `code`, so this module never imports the native module.
 */
export function isOnDeviceDeferrable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_AFM_BUSY' || code === 'ERR_AFM_UNAVAILABLE';
}

export function isDeferrableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; message?: unknown; statusCode?: unknown };

  // Duck-typed on the name, like logger.classifySuppression, so this module
  // never imports lib/e2ee.
  if (e.name === 'NoCredentialError') return true;
  if (e.statusCode === 503 || e.statusCode === 429) return true;
  if (typeof e.message === 'string' && STATUS_IN_MESSAGE.test(e.message)) return true;

  // Offline: a transport failure while the device is CONFIRMED offline.
  // `=== false`, never `!isConnected`: the store assumes online until NetInfo's
  // first reading, so "not yet known" must fall on the failure side. And the
  // raw link, never `isOnline()`, which is a latch about Mera's own API.
  // Lazy-required: this module sits under InferenceQueue, which every enqueue
  // path imports.
  try {
    const { useNetworkStore } =
      require('../stores/network-store') as typeof import('../stores/network-store');
    if (useNetworkStore.getState().isConnected !== false) return false;
    const { isTransientNetworkError } =
      require('../algorithms/transient-error') as typeof import('../algorithms/transient-error');
    return isTransientNetworkError(err);
  } catch {
    return false;
  }
}
