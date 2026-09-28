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
//
// **It is not its own OS task any more.** Every expo-background-task task
// shares ONE iOS BGTask identifier, ONE Android WorkManager worker and ONE
// interval (whichever registration ran last), and all of them run concurrently
// in the same wake. So backup runs as the second step of `mera-background`
// (`background-task.ts`), after the refresh, and keeps its own cadence through
// `scheduledBackupIsDue`: a wake that comes hourly for the refresh still backs
// up only daily or weekly.

// Side-effect imports, load-bearing: the OS can resolve this module on a
// background wake without ever loading `app/_layout.tsx`.
//   - sentry-init, or a failure here is invisible.
//   - get-random-values, because the blob codec calls @noble's `randomBytes`
//     for every nonce prefix. Without the polyfill the backup throws at
//     encryption time, in a context with nobody watching.
import '@/lib/sentry-init';
import 'react-native-get-random-values';

import * as BackgroundTask from 'expo-background-task';

import logger from '@/lib/logger';

import {
  backupProviderId,
  connectionSatisfiesWifiOnly,
  hydrateBackupSettings,
  recordBackupFailure,
  recordBackupRun,
  scheduledBackupEnabled,
  scheduledBackupIsDue,
  backupCadence,
} from '@/lib/backup/backup-settings';
import type { BackupProvider } from '@/lib/backup/types';

/** The retired task name. Kept only so the one-task migration can unregister
 *  it (`background-task.ts`). Nothing defines it any more. */
export const BACKUP_TASK = 'mera-backup-task';

/** Cadence to `minimumInterval`, which the API takes in MINUTES. Undefined for
 *  `off` and `manual`, which want no wake. */
export function backupIntervalMinutes(): number | undefined {
  if (!scheduledBackupEnabled()) return undefined;
  return INTERVAL_MINUTES[backupCadence()];
}

const INTERVAL_MINUTES: Record<string, number> = {
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
};

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

/**
 * The scheduled backup, as one step of the `mera-background` wake. Never
 * throws: a failure is reported and stamped, and the wake goes on.
 *
 * There is no expiry handling. expo-background-task never delivers its iOS
 * expiration event to JS (the native side posts it without the `url` key its
 * own handler requires), so an `addExpirationListener` flag can never be set.
 * An upload the OS cuts off simply never reaches `recordBackupRun`, which is the
 * safe outcome: an unstamped run costs one redundant backup, never a missing
 * one.
 */
export async function runScheduledBackup(): Promise<void> {
  try {
    // The mirror is module state and this process may have been started by
    // the OS purely to run this task, so nothing has hydrated it.
    await hydrateBackupSettings();

    const now = Date.now();
    if (!scheduledBackupEnabled() || !scheduledBackupIsDue(now)) return;
    // Not a failure. The user asked not to spend mobile data on this.
    if (!(await connectionSatisfiesWifiOnly())) return;

    const provider = resolveProvider();
    if (!provider) return;

    // Required lazily. This module is resolved on every background wake, and
    // a static import would pull the whole backup stack plus
    // react-native-cloud-storage's TurboModules in even when the guards above
    // return immediately.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runBackup } = require('@/lib/backup/backup-service') as typeof import('@/lib/backup/backup-service');
    const result = await runBackup(provider);

    await recordBackupRun(now);
    logger.addBreadcrumb(
      'backup: background run complete',
      'backup-task',
      { rows: result.header.tables.reduce((n, t) => n + t.rows, 0), provider: provider.id },
      'info',
    );
  } catch (err) {
    // `backup_last_run_at` is deliberately untouched, so the next window
    // tries again and the staleness line keeps counting up.
    logger.captureException(err, { tags: { service: 'backup-task' } });
    // The failure IS stamped, so Settings says "Last backup failed on
    // <date>" rather than going quiet about a schedule that is not working.
    // Best effort: a failed write here must not change the outcome.
    try {
      await recordBackupFailure(Date.now());
    } catch {
      // The staleness line still counts up without it.
    }
  }
}

/**
 * Brings the ONE OS task in line with the backup cadence and the refresh
 * toggle. Kept under this name because `hydrateAllStores` and the backup
 * settings setters call it; the reconciler itself lives with the task.
 */
export async function syncBackupTaskRegistration(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { syncBackgroundTaskRegistration } = require('./background-task') as typeof import('./background-task');
  await syncBackgroundTaskRegistration();
}

/**
 * Whether the OS will run background tasks for this app at all.
 *
 * `getStatusAsync` reports `Restricted` only on the iOS simulator and in Expo
 * Go. It does NOT detect Background App Refresh being off or Low Power Mode.
 */
export async function backgroundBackupIsAvailable(): Promise<boolean> {
  try {
    return (await BackgroundTask.getStatusAsync()) === BackgroundTask.BackgroundTaskStatus.Available;
  } catch {
    return false;
  }
}
