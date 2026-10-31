// A6 — cooperative yielding helpers so heavy background work (feed-sync store
// refreshes, on-device scoring batches) doesn't starve hydration/first-paint or
// jank foreground animations. RN-touching code is fine in lib/scheduler/.

import { sleep } from '@/lib/utils/sleep';

/** Run `cb` on the next macrotask; the returned function cancels it. RN's interaction manager was already a setImmediate stub in RN 0.83, so this keeps today's timing. */
export function runWhenIdle(cb: () => void): () => void {
  const id = setTimeout(cb, 0);
  return () => clearTimeout(id);
}

/**
 * Resolve on the next macrotask. Use to defer non-urgent work past
 * gestures/first-paint so the UI thread stays responsive.
 */
export function yieldToInteractions(): Promise<void> {
  return new Promise<void>((resolve) => {
    runWhenIdle(resolve);
  });
}

/**
 * `yieldToInteractions` with a hard ceiling: whichever of the yield and the
 * timeout resolves first wins.
 */
export function yieldToInteractionsWithTimeout(ms: number): Promise<void> {
  return Promise.race([
    yieldToInteractions(),
    sleep(ms),
  ]);
}

/**
 * Resolve on the next macrotask (setTimeout 0). Lets the JS thread drain pending
 * work (renders, touch handling) between tight loop iterations 
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
