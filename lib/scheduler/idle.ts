// A6 — cooperative yielding helpers so heavy background work (feed-sync store
// refreshes, on-device scoring batches) doesn't starve hydration/first-paint or
// jank foreground animations. RN-touching code is fine in lib/scheduler/.

import { InteractionManager } from 'react-native';

/**
 * Resolve after the current interactions/animations have finished. Falls back to
 * the next macrotask when InteractionManager is unavailable (e.g. unit tests that
 * stub `react-native` without it). Use to defer non-urgent work past
 * gestures/first-paint so the UI thread stays responsive.
 */
export function yieldToInteractions(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (InteractionManager && typeof InteractionManager.runAfterInteractions === 'function') {
      InteractionManager.runAfterInteractions(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Resolve on the next macrotask (setTimeout 0). Lets the JS thread drain pending
 * work (renders, touch handling) between tight loop iterations without waiting
 * for all interactions to settle.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
