// gateway-rate-limiter — module-level gate placed in front of every
// inference-gateway HTTP call (submits AND polls). The gateway throttles at
// 30 requests/60s per IP; this enforces a conservative hard ceiling of
// 20 req/min (one grant every MIN_GATEWAY_INTERVAL_MS) so the many small
// pipelined batch jobs the orchestrator issues never trip it.
//
// `acquire()` is a serial FIFO queue: callers are granted in call order, each
// grant spaced at least MIN_GATEWAY_INTERVAL_MS after the previous one.
// `pauseFor()` lets a 429 response push the next grant further into the
// future without disturbing callers already queued. `tryTakeImmediate()` is
// the non-blocking sibling — the orchestrator uses it to decide whether it
// can admit another batch right now without joining the queue.

export const MIN_GATEWAY_INTERVAL_MS = 3000;

// Epoch ms of the earliest time the next grant may be issued. Advanced on
// every grant (from acquire() or tryTakeImmediate()) and pushed further out
// by pauseFor().
let nextGrantAt = 0;

// Tail of the FIFO chain — each acquire() appends its wait behind whatever is
// already queued, so grants are issued in call order.
let queueTail: Promise<void> = Promise.resolve();

/**
 * Resolves once it's this caller's turn and at least
 * MIN_GATEWAY_INTERVAL_MS has passed since the last grant. Callers queue in
 * FIFO order.
 */
export function acquire(): Promise<void> {
  const wait = queueTail.then(() => grant());
  // Keep the chain alive even if a link ever rejects — a rejection must not
  // stall every caller queued behind it.
  queueTail = wait.catch(() => undefined);
  return wait;
}

/**
 * Non-blocking check: if a grant is available right now, take it and return
 * true; otherwise return false without affecting the queue or state used by
 * `acquire()`'s waiters. Used by the orchestrator to decide whether to admit
 * another batch without blocking.
 */
export function tryTakeImmediate(): boolean {
  const now = Date.now();
  if (now < nextGrantAt) return false;
  nextGrantAt = now + MIN_GATEWAY_INTERVAL_MS;
  return true;
}

/**
 * Pushes the next available grant at least `ms` into the future — used on
 * HTTP 429 to back off. Repeated calls don't stack: the next grant time is
 * the max of the current value and `now + ms`.
 */
export function pauseFor(ms: number): void {
  const candidate = Date.now() + ms;
  if (candidate > nextGrantAt) nextGrantAt = candidate;
}

function grant(): Promise<void> {
  const waitMs = Math.max(0, nextGrantAt - Date.now());
  return new Promise((resolve) => {
    setTimeout(() => {
      nextGrantAt = Date.now() + MIN_GATEWAY_INTERVAL_MS;
      resolve();
    }, waitMs);
  });
}

/** Test-only: reset all module state between tests. */
export function _resetForTests(): void {
  nextGrantAt = 0;
  queueTail = Promise.resolve();
}
