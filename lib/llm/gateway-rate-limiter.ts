// gateway-rate-limiter — module-level gate in front of EVERY inference-gateway
// HTTP call: chat, single + batch completions, async job submits, /results
// polls, web search and attestation fetches. The gateway throttles per USER
// (JWT sub), so the device is the unit of enforcement and anything that skips
// this gate is spending that user's budget unmetered.
//
// TWO LANES, ONE CEILING.
//   interactive — a person is waiting (chat turns, the prewarm, web search
//                 inside a chat tool, the user-initiated attestation verify tap)
//   background  — everything else (scoring submits, /results polls, batch topic
//                 generation)
// Interactive callers are granted ahead of every queued background caller and
// are spaced MIN_INTERACTIVE_INTERVAL_MS apart; background keeps
// MIN_GATEWAY_INTERVAL_MS. Both lanes share ONE anchor (`lastGrantAt`), which is
// what keeps the device-wide ceiling provable: no lane is eligible sooner than
// lastGrantAt + MIN_INTERACTIVE_INTERVAL_MS, so two consecutive grants are never
// closer than 1s — at most 60 requests/minute, whatever the mix.
//
// Interactive deliberately anchors on `lastGrantAt`, NOT on the
// background-advanced `nextGrantAt`: a chat turn arriving just after a scoring
// submit should wait out 1s of spacing, not the background lane's 3s cadence.
//
// `acquire()` queues (FIFO within a lane, interactive lane first) and takes an
// optional AbortSignal so an abandoned caller is spliced out instead of holding
// its position and burning a grant nobody uses. `tryTakeImmediate()` is the
// non-blocking sibling the scoring pipeline uses to decide whether it can admit
// another batch right now. `pauseFor()` lets a 429 push the next grant further
// out.

export type GatewayLane = 'interactive' | 'background';

export const MIN_GATEWAY_INTERVAL_MS = 3000;

/** Interactive spacing. 60 req/min is the device ceiling this implies, which is
 *  the number that has to stay under the gateway's per-user limit. */
export const MIN_INTERACTIVE_INTERVAL_MS = 1000;

/** The longest a `pauseFor()` may hold the INTERACTIVE lane.
 *
 *  A 429 raised by a background batch would otherwise freeze chat for the whole
 *  Retry-After — up to 60s of a composer that looks alive, accepts nothing and
 *  offers no way out. The device still backs off; the lane a person is watching
 *  just stops obeying the long tail of it. Background honours the pause in
 *  full. */
export const INTERACTIVE_MAX_PAUSE_MS = 2000;

// Epoch ms of the most recent grant on EITHER lane — the shared anchor.
let lastGrantAt = 0;

// Epoch ms the BACKGROUND lane may next be granted. Advanced on every grant
// (either lane) and by tryTakeImmediate().
let nextGrantAt = 0;

// Active pause (from pauseFor): `pausedUntil` is when it lifts for background,
// `pauseSetAt` when it was armed, so the interactive lane can cap its share.
let pausedUntil = 0;
let pauseSetAt = 0;

interface Waiter {
  lane: GatewayLane;
  resolve: () => void;
  reject: (err: Error) => void;
  /** Detach the abort listener. Runs on grant and on abort. */
  cleanup: () => void;
}

// Waiters in arrival order. The dispatcher picks the first interactive one, or
// the first background one when no interactive caller is waiting.
let waiters: Waiter[] = [];
let dispatchTimer: ReturnType<typeof setTimeout> | null = null;

/** When the interactive lane may next be granted. */
function interactiveEligibleAt(): number {
  const pauseFloor = pausedUntil === 0
    ? 0
    : Math.min(pausedUntil, pauseSetAt + INTERACTIVE_MAX_PAUSE_MS);
  return Math.max(lastGrantAt + MIN_INTERACTIVE_INTERVAL_MS, pauseFloor);
}

/** When the background lane may next be granted. */
function backgroundEligibleAt(): number {
  return Math.max(nextGrantAt, pausedUntil);
}

function eligibleAt(lane: GatewayLane): number {
  return lane === 'interactive' ? interactiveEligibleAt() : backgroundEligibleAt();
}

/** Record a grant against the shared anchor. Both lanes advance the background
 *  clock, so background cadence stays 3s no matter which lane spent the slot. */
function markGranted(now: number): void {
  lastGrantAt = now;
  nextGrantAt = now + MIN_GATEWAY_INTERVAL_MS;
}

/** Head of the queue under the priority rule: interactive first, FIFO within
 *  a lane. */
function nextWaiter(): Waiter | undefined {
  return waiters.find((w) => w.lane === 'interactive') ?? waiters[0];
}

/**
 * Grant whatever is due now, then arm a timer for whatever is due next.
 *
 * Re-entrant by design: every enqueue, abort and pause calls it, so a newly
 * arrived interactive waiter can pre-empt a timer that was armed for a
 * background one.
 */
function schedule(): void {
  if (dispatchTimer !== null) {
    clearTimeout(dispatchTimer);
    dispatchTimer = null;
  }

  const waiter = nextWaiter();
  if (!waiter) return;

  const now = Date.now();
  const dueAt = eligibleAt(waiter.lane);
  const waitMs = Math.max(0, dueAt - now);

  // ALWAYS through a timer, even at 0ms. Callers (and the existing specs) rely
  // on a grant never resolving synchronously inside acquire().
  dispatchTimer = setTimeout(() => {
    dispatchTimer = null;
    const due = nextWaiter();
    if (!due) return;
    // The head may have changed while the timer ran (an interactive waiter
    // arrived, the pause moved). Re-check rather than granting blind.
    if (Date.now() < eligibleAt(due.lane)) {
      schedule();
      return;
    }
    waiters = waiters.filter((w) => w !== due);
    markGranted(Date.now());
    due.cleanup();
    due.resolve();
    schedule();
  }, waitMs);
}

/**
 * Resolves once it is this caller's turn and its lane's spacing has elapsed.
 *
 * `lane` defaults to 'background', which is what keeps every pre-existing
 * caller on exactly the behaviour it had. Pass an AbortSignal for any caller
 * that can give up waiting (a deadline, a cancelled chat turn, a losing hedge
 * leg): an abandoned waiter is spliced out of the queue instead of holding its
 * position ahead of background callers and consuming a grant nobody uses.
 */
export function acquire(
  lane: GatewayLane = 'background',
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      lane,
      resolve,
      reject,
      cleanup: () => {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      },
    };

    const onAbort = signal
      ? () => {
          waiters = waiters.filter((w) => w !== waiter);
          waiter.cleanup();
          reject(abortError());
          // The head may have been this waiter; re-arm for whoever is next.
          schedule();
        }
      : undefined;
    if (onAbort) signal?.addEventListener('abort', onAbort);

    waiters.push(waiter);
    schedule();
  });
}

/** The rejection an abandoned waiter gets. `name: 'AbortError'` so the shared
 *  `isAbortLike` classifier reads it as a cancellation, never as evidence
 *  about a model. */
function abortError(): Error {
  const err = new Error('gateway-rate-limiter: caller abandoned its wait');
  err.name = 'AbortError';
  return err;
}

/**
 * Non-blocking check: if a grant is available right now for `lane`, take it and
 * return true; otherwise return false without affecting the queue or state used
 * by `acquire()`'s waiters. Used by the scoring orchestrator to decide whether
 * to admit another batch without blocking.
 */
export function tryTakeImmediate(lane: GatewayLane = 'background'): boolean {
  const now = Date.now();
  if (now < eligibleAt(lane)) return false;
  markGranted(now);
  return true;
}

/**
 * Milliseconds until the BACKGROUND lane's next grant (0 when one is available
 * right now). READ-ONLY — does not take the grant and does not touch the queue.
 *
 * Exists so a caller that SCHEDULES future work can align to the limiter
 * instead of guessing a fixed interval. The scoring pipeline's results poller is
 * the one such caller: its first tick used to land a hair BEFORE `nextGrantAt`
 * whenever the submit round trip was quicker than the poller's lead, so
 * `tryTakeImmediate()` refused and the first GET /results slipped a whole extra
 * interval. Measured on prod: 5533ms from POST to the first poll, with the
 * server's results already waiting (the decode landed 118ms later).
 */
export function msUntilNextGrant(): number {
  return Math.max(0, backgroundEligibleAt() - Date.now());
}

/**
 * Pushes the next available grant at least `ms` into the future — used on HTTP
 * 429 to back off. Repeated calls don't stack: the pause is the max of the
 * current value and `now + ms`. Background honours it in full; the interactive
 * lane honours at most INTERACTIVE_MAX_PAUSE_MS of it.
 */
export function pauseFor(ms: number): void {
  const candidate = Date.now() + ms;
  if (candidate > pausedUntil) {
    pausedUntil = candidate;
    pauseSetAt = Date.now();
  }
  // A pause can only push grants later, but the dispatcher may hold a timer
  // armed for the old, earlier time.
  schedule();
}

/** Test-only: reset all module state between tests. */
export function _resetForTests(): void {
  lastGrantAt = 0;
  nextGrantAt = 0;
  pausedUntil = 0;
  pauseSetAt = 0;
  waiters = [];
  if (dispatchTimer !== null) {
    clearTimeout(dispatchTimer);
    dispatchTimer = null;
  }
}
