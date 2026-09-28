// `mera-background`: the app's ONE OS background task.
//
// **One task, because the library has one of everything.** expo-background-task
// gives every task it registers the same iOS BGTask identifier
// (`com.expo.modules.backgroundtask.processing`), the same Android WorkManager
// worker and a single interval, set by whichever registration ran last. All
// registered tasks then run CONCURRENTLY in the same wake, and the window closes
// when the slowest finishes. Two tasks would fight over one JS thread and one
// interval; one task runs its steps in an order we choose.
//
// **Order, per wake:** the refresh (collect, then fetch), then the scheduled
// backup. Backup keeps its own due and Wi-Fi checks, so an hourly wake still
// backs up only daily or weekly.
//
// **Where it is defined:** `index.js`, through `define-tasks.ts`, never
// `app/_layout.tsx`. Under expo-router every route module is lazy, so a killed
// app woken headless on Android never evaluates `_layout`; an event for an
// undefined task makes expo-task-manager UNREGISTER it.
//
// **What the OS gives us (iOS):** a BGProcessingTaskRequest with
// `requiresNetworkConnectivity` and without `requiresExternalPower`, usually
// granted overnight. Its expiration never reaches JS, and completion is always
// reported as success, so the task's return value is inert. The run bounds
// itself with its own deadline instead.
//
// No telemetry: the run reports failures to Sentry like any other code, and
// nothing about its schedule, timing or outcome is sent anywhere.

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import logger from '@/lib/logger';

export const BACKGROUND_TASK = 'mera-background';

/** The hint while the refresh is on. The OS treats it as a minimum delay. */
export const REFRESH_INTERVAL_MINUTES = 60;

/** One budget for the whole refresh. */
export const RUN_DEADLINE_MS = 60_000;

/** No fetch starts with less than this left: a submit needs the room. */
export const FETCH_START_RESERVE_MS = 15_000;

/** The toggle read doubles as the DB probe; it gets this long. */
export const DB_PROBE_TIMEOUT_MS = 3_000;

export type RefreshStop =
  | 'disabled'
  | 'db-unavailable'
  | 'locked'
  | 'signed-out'
  | 'deadline'
  | 'done'
  | 'error';

export interface RefreshOutcome {
  stoppedBy: RefreshStop;
  /** Step (b)'s own outcome, when it ran. */
  fetch?: string;
}

let defined = false;

function breadcrumb(message: string, data: Record<string, unknown> = {}): void {
  logger.addBreadcrumb(`background: ${message}`, 'background', data, 'info');
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * The refresh: collect what the device is owed, then fetch just enough for the
 * next open. Never throws. Every exit that is a normal state of a device
 * (toggle off, locked since reboot, signed out, nothing to do) is quiet: a
 * breadcrumb at most, never a Sentry event, never a toast, never a logout.
 */
export async function runBackgroundRefresh(now: number = Date.now()): Promise<RefreshOutcome> {
  const deadlineAt = now + RUN_DEADLINE_MS;

  // 1. The toggle, which is also the DB probe. The first read of the wake is
  //    the one that finds out whether SQLite opens at all.
  let enabled: boolean;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const settings = require('./bg-refresh-settings') as typeof import('./bg-refresh-settings');
    enabled = await withTimeout(settings.isBgRefreshEnabled(), DB_PROBE_TIMEOUT_MS);
  } catch (err) {
    breadcrumb('database unavailable', { error: String(err) });
    return { stoppedBy: 'db-unavailable' };
  }
  if (!enabled) return { stoppedBy: 'disabled' };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withTaskAuthScope } = require('@/lib/auth-failure-breaker') as typeof import('@/lib/auth-failure-breaker');

  return withTaskAuthScope(async (): Promise<RefreshOutcome> => {
    try {
      // 2. Release the install-boundary quarantine. Until it runs, the auth
      //    cookie reads as null in this process.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { enforceInstallBoundary } = require('@/lib/security/install-boundary') as typeof import('@/lib/security/install-boundary');
      await enforceInstallBoundary();

      // 3. The keychain probe. It throws while the device has been locked
      //    since reboot, and reads empty when signed out.
      let cookie: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { authClient } = require('@/lib/auth-client') as typeof import('@/lib/auth-client');
        cookie = authClient.getCookie();
      } catch {
        return { stoppedBy: 'locked' };
      }
      if (typeof cookie !== 'string' || cookie.length === 0) return { stoppedBy: 'signed-out' };

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pipeline = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { trackBackgroundCollect } = require('./collect-gate') as typeof import('./collect-gate');

      // 4. Collect: the device's waiting batches first, so the next open has
      //    notes, and so their slots are free for step (b).
      const collected = await trackBackgroundCollect(pipeline.advanceWaitingForBackground({ deadlineAt }));
      breadcrumb('collect finished', { stoppedBy: collected.stoppedBy });

      // 5. Fetch, only if a submit would still fit.
      if (Date.now() > deadlineAt - FETCH_START_RESERVE_MS) return { stoppedBy: 'deadline' };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runBackgroundFeedSync } = require('./background-feed-sync') as typeof import('./background-feed-sync');
      const fetched = await runBackgroundFeedSync({ deadlineAt });
      breadcrumb('fetch finished', { stoppedBy: fetched.stoppedBy, budget: fetched.meteredBudget });
      return { stoppedBy: 'done', fetch: fetched.stoppedBy };
    } catch (err) {
      logger.captureException(err, { tags: { service: 'background-task', step: 'refresh' } });
      return { stoppedBy: 'error' };
    }
  });
}

/** The whole wake: refresh, then backup. Never throws. */
export async function runBackgroundWake(): Promise<BackgroundTask.BackgroundTaskResult> {
  await runBackgroundRefresh();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runScheduledBackup } = require('./backup-task') as typeof import('./backup-task');
    await runScheduledBackup();
  } catch (err) {
    logger.captureException(err, { tags: { service: 'background-task', step: 'backup' } });
  }
  // Inert on both platforms (see the header), returned for the type.
  return BackgroundTask.BackgroundTaskResult.Success;
}

export function defineBackgroundTask(): void {
  if (defined) return;
  defined = true;
  TaskManager.defineTask(BACKGROUND_TASK, () => runBackgroundWake());
}

/**
 * The interval the ONE task should be registered with: the refresh's hourly
 * hint while it is on, else the backup cadence, else none (unregistered).
 */
export async function wantedIntervalMinutes(): Promise<number | undefined> {
  let refreshOn = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const settings = require('./bg-refresh-settings') as typeof import('./bg-refresh-settings');
    refreshOn = await settings.isBgRefreshEnabled();
  } catch {
    // Unreadable: keep the default. The run re-reads it before doing anything.
  }
  if (refreshOn) return REFRESH_INTERVAL_MINUTES;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { backupIntervalMinutes } = require('./backup-task') as typeof import('./backup-task');
  return backupIntervalMinutes();
}

/**
 * Bring the OS registration in line with the settings. Idempotent and safe on
 * every boot.
 *
 * `registerTaskAsync` does NOTHING when the task is already registered, so an
 * interval change needs an unregister and a register. Cycling reschedules the
 * next run from now, so it happens only when the persisted interval differs.
 *
 * Migration: the retired `mera-backup-task` is unregistered after the new task
 * is registered, so the native task count never reaches zero in between (at
 * zero, iOS cancels the pending request).
 */
export async function syncBackgroundTaskRegistration(): Promise<void> {
  defineBackgroundTask();
  try {
    const wanted = await wantedIntervalMinutes();
    const registered = await TaskManager.getRegisteredTasksAsync();
    const ours = registered.find((t) => t.taskName === BACKGROUND_TASK);
    const current = (ours?.options as { minimumInterval?: number } | undefined)?.minimumInterval;

    if (wanted === undefined) {
      if (ours) await BackgroundTask.unregisterTaskAsync(BACKGROUND_TASK);
    } else if (!ours) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_TASK, { minimumInterval: wanted });
    } else if (current !== wanted) {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_TASK);
      await BackgroundTask.registerTaskAsync(BACKGROUND_TASK, { minimumInterval: wanted });
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BACKUP_TASK } = require('./backup-task') as typeof import('./backup-task');
    if (registered.some((t) => t.taskName === BACKUP_TASK)) {
      await BackgroundTask.unregisterTaskAsync(BACKUP_TASK);
    }
  } catch (err) {
    // A device that refuses registration still has manual backup and the
    // foreground sync. Never let this throw into a settings tap or app boot.
    logger.captureException(err, { tags: { service: 'background-task', step: 'register' } });
  }
}
