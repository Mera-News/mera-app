// Deadline plumbing for the OS background task (bgsubmit).
//
// The friction: the background run has ONE hard deadline, but several awaits on
// its path take no AbortSignal (`getJwtToken`, the rate limiter's `acquire`).
// Racing them against the signal is what lets the run stop on time; the losing
// promise keeps running and settles harmlessly.

import { createCancellationError } from '@/lib/utils/retry';

/** Resolve with `p`, or reject with the app's cancellation error the moment
 *  `signal` aborts. Without a signal this is `p`. */
export function raceSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(createCancellationError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createCancellationError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * An AbortController that fires when `outer` aborts OR after `timeoutMs`,
 * whichever comes first. Call `dispose()` in a finally so the timer and the
 * listener never outlive the request.
 */
export function linkedAbort(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuter = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onOuter, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    },
  };
}
