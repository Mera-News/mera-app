// The one lock every llama.rn caller goes through.
//
// llama.rn holds ONE context for the whole app: Kev, the relevance model (D37).
// A call mutates its KV cache in place, so two overlapping calls interleave: the
// second one's prefill lands on top of the first one's state. Loading and
// releasing Kev run under the same lock, so a load can never release a context
// mid-call. The built-in text model runs out of process but takes the same lock,
// so a chat turn's decide and write run one after the other, never nested.
//
// NOT re-entrant. Every public toolkit entry (infer, inferStream, decide,
// initBaseModel, disposeModel, resetContext, the deletes) takes it exactly once,
// and nothing that holds it may call a public entry: inside, use modelManager's
// unlocked internals (`_ensureLoaded`, `_releaseModel`). Calling a public entry
// while holding the lock waits on itself forever.

let llamaChain: Promise<unknown> = Promise.resolve();

/** Runs `fn` once every earlier llama caller has settled. */
export function withLlamaLock<T>(fn: () => Promise<T>): Promise<T> {
  // `.then(fn, fn)` runs fn whether the previous holder resolved OR rejected —
  // one failed call must not wedge every later one behind it.
  const run = llamaChain.then(fn, fn);
  llamaChain = run.catch(() => {});
  return run;
}

/**
 * Manual acquire for `inferStream`, which spans many awaits and so cannot be
 * expressed as a single promise. Resolves once the lock is held; the caller
 * MUST release it in a `finally`, or every later llama call waits forever.
 *
 * `for await` always calls the generator's `.return()` on break/throw, so the
 * `finally` runs and this is safe for every consumer today. The one shape that
 * would deadlock is a consumer driving `.next()` by hand and abandoning the
 * generator without `.return()`: nothing releases, and the whole engine goes
 * quiet with no error. Iterate with `for await`.
 */
export function acquireLlamaLock(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = llamaChain.then(
    () => release,
    () => release,
  );
  llamaChain = acquired.then(() => held);
  return acquired;
}
