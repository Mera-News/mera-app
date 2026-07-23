// Shared "is the app busy with important work?" guard for LOW-PRIORITY
// background scheduler tasks (the daily/weekly maintenance sweeps).
//
// The AppScheduler has no cross-task priority — tasks only gate on
// frequency/triggers/conditions. To make a task "lower priority" (run only when
// nothing important is in flight), attach `backgroundWorkIsIdle` as a `custom`
// condition: when it returns false the task is skipped for this tick and,
// because its lastRun isn't stamped, it's simply re-checked on the next 5s tick
// — so it fires at the first idle moment after it comes due.

import { useSchedulerStore } from './scheduler-store';

/** Tasks whose in-flight run marks the app as "doing important work". Keep this
 *  to the genuinely user-facing / CPU-heavy work maintenance should defer to. */
const IMPORTANT_TASKS = ['feed-sync'] as const;

/**
 * Synchronous idle check backing the low-priority maintenance tasks' `custom`
 * condition (scheduler custom checks must return a boolean, so this cannot be
 * async). Returns false — "busy, skip for now" — when the feed is syncing OR the
 * on-device inference queue is actively running a job / held by chat.
 *
 * The InferenceQueue is lazy-`require`d (not top-level imported) so this module
 * stays free of the queue's WatermelonDB import chain at load time, letting the
 * task-registration modules import it without pulling the real DB adapter. Any
 * failure resolves to "idle" (true) so a probe error never wedges a task
 * permanently.
 */
export function backgroundWorkIsIdle(): boolean {
  try {
    const scheduler = useSchedulerStore.getState();
    for (const task of IMPORTANT_TASKS) {
      if (scheduler.isRunning(task)) return false;
    }
    const { inferenceQueue } =
      require('@/lib/inference/InferenceQueue') as typeof import('@/lib/inference/InferenceQueue');
    if (inferenceQueue.isBusy()) return false;
    return true;
  } catch {
    // Can't determine busyness — don't block the task.
    return true;
  }
}
