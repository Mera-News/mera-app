// The scheduled backup, running in a REAL background task.
//
// **Why it is not in the foreground.** It used to be an `AppScheduler` task,
// which meant a WatermelonDB reader blocking every writer, plus compression,
// encryption and a multi-megabyte upload, all while the user was reading news.
// That spends RAM and CPU competing with the only thing they opened the app to
// do. A backup should be invisible, and the foreground now does nothing but
// READ `backup_last_run_at` to decide whether to nudge.
//
// **This needed no native change.** `expo-background-task`'s config plugin was
// already in `app.json` before backup existed, so the shipped binary already
// carries `UIBackgroundModes: [… 'processing']` and
// `BGTaskSchedulerPermittedIdentifiers`. Registering the task is pure JS.
//
// **Memory is what decides whether this works at all**, and the codec was built
// for it before there was a background task to run in: the export pages the
// database 500 rows at a time, reads the scratch file in 256 KB chunks, and
// writes the blob as frames rather than assembling it. Peak memory is bounded
// and small by construction. Do not "optimise" any of that into a buffer.
//
// **`minimumInterval` is a MINIMUM DELAY, not a schedule.** The system decides
// when to actually run, and on iOS that is typically overnight. The UI copy
// says "about once a day, usually overnight" for that reason, and the staleness
// line exists because the system is entitled to skip a device for a long time.

// Both of these are side-effect imports and both are load-bearing, for the same
// reason they are in `inference-task.ts`: the OS can resolve THIS module on a
// background wake without ever loading `app/_layout.tsx`.
//   - sentry-init, or a failure here is invisible.
//   - get-random-values, because the blob codec calls @noble's `randomBytes`
//     for every nonce prefix. Without the polyfill the backup throws at
//     encryption time, in a context with nobody watching.
import '@/lib/sentry-init';
import 'react-native-get-random-values';

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import logger from '@/lib/logger';

import {
  backupProviderId,
  connectionSatisfiesWifiOnly,
  hydrateBackupSettings,
  recordBackupRun,
  scheduledBackupEnabled,
  scheduledBackupIsDue,
  backupCadence,
} from '@/lib/backup/backup-settings';
import type { BackupProvider } from '@/lib/backup/types';

export const BACKUP_TASK = 'mera-backup-task';

/** Cadence to `minimumInterval`, which the API takes in MINUTES. */
const INTERVAL_MINUTES: Record<string, number> = {
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
};

let defined = false;
/** Set by the iOS expiration listener; checked before anything is stamped. */
let expired = false;

function resolveProvider(): BackupProvider | null {
  switch (backupProviderId()) {
    case 'icloud':
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('@/lib/backup/providers/icloud').icloudProvider as BackupProvider;
    case 'google-drive':
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('@/lib/backup/providers/google-drive').googleDriveProvider as BackupProvider;
    default:
      return null;
  }
}

export function defineBackupTask(): void {
  if (defined) return;
  defined = true;

  TaskManager.defineTask(BACKUP_TASK, async () => {
    expired = false;
    // iOS can stop the task at any point. When it does, the run is abandoned
    // WITHOUT stamping `backup_last_run_at`, so the next window retries rather
    // than believing a partial upload counted.
    const subscription = BackgroundTask.addExpirationListener(() => {
      expired = true;
      logger.addBreadcrumb('backup: background task expired mid-run', 'backup-task', {}, 'warning');
    });

    try {
      // The mirror is module state and this process may have been started by
      // the OS purely to run this task, so nothing has hydrated it.
      await hydrateBackupSettings();

      const now = Date.now();
      if (!scheduledBackupEnabled() || !scheduledBackupIsDue(now)) {
        return BackgroundTask.BackgroundTaskResult.Success;
      }
      if (!(await connectionSatisfiesWifiOnly())) {
        // Not a failure. The user asked not to spend mobile data on this.
        return BackgroundTask.BackgroundTaskResult.Success;
      }

      const provider = resolveProvider();
      if (!provider) return BackgroundTask.BackgroundTaskResult.Success;

      // Required lazily. This module is resolved on every background wake, and
      // a static import would pull the whole backup stack plus
      // react-native-cloud-storage's TurboModules in even when the guards above
      // return immediately.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runBackup } = require('@/lib/backup/backup-service') as typeof import('@/lib/backup/backup-service');
      const result = await runBackup(provider);

      if (expired) {
        // The upload may have completed, but the system took the runtime away
        // mid-flight and we cannot tell. Not stamping costs one redundant
        // backup; stamping a run that did not finish costs a missing one.
        return BackgroundTask.BackgroundTaskResult.Failed;
      }

      await recordBackupRun(now);
      logger.addBreadcrumb(
        'backup: background run complete',
        'backup-task',
        { rows: result.header.tables.reduce((n, t) => n + t.rows, 0), provider: provider.id },
        'info',
      );
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (err) {
      // `Failed` is what lets the system back off instead of retrying into a
      // flat battery. `backup_last_run_at` is deliberately untouched, so the
      // next window tries again and the staleness line keeps counting up.
      logger.captureException(err, { tags: { service: 'backup-task' } });
      return BackgroundTask.BackgroundTaskResult.Failed;
    } finally {
      subscription.remove();
    }
  });
}

/**
 * Brings registration in line with the current cadence.
 *
 * `off` and `manual` genuinely UNREGISTER rather than registering a task that
 * returns early. The foreground `AppScheduler` had no `unregister`, which is
 * why the old implementation could only no-op; this API has one, so the
 * original intent is achievable — a user who declined backup has no task on
 * their device at all.
 */
export async function syncBackupTaskRegistration(): Promise<void> {
  defineBackupTask();
  try {
    const cadence = backupCadence();
    const minutes = INTERVAL_MINUTES[cadence];
    const wanted = scheduledBackupEnabled() && minutes !== undefined;

    if (!wanted) {
      if (await TaskManager.isTaskRegisteredAsync(BACKUP_TASK)) {
        await BackgroundTask.unregisterTaskAsync(BACKUP_TASK);
      }
      return;
    }
    await BackgroundTask.registerTaskAsync(BACKUP_TASK, { minimumInterval: minutes });
  } catch (err) {
    // A device that refuses registration still has the manual button, and the
    // staleness line will say the backup is old. Never let this throw into a
    // settings tap or app boot.
    logger.captureException(err, { tags: { service: 'backup-task', step: 'register' } });
  }
}

/**
 * Whether the OS will run background tasks for this app at all.
 *
 * `Restricted` means Background App Refresh is off, or the device is in Low
 * Power Mode. Backups then never run on their own, and the section says so —
 * silence would leave the user believing a schedule they do not have.
 */
export async function backgroundBackupIsAvailable(): Promise<boolean> {
  try {
    return (await BackgroundTask.getStatusAsync()) === BackgroundTask.BackgroundTaskStatus.Available;
  } catch {
    return false;
  }
}
