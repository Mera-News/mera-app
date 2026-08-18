// The scheduled backup.
//
// Registered with a fixed 6h frequency, which is a TICK GRANULARITY and not the
// user's cadence. `TaskDefinition.frequency` is read once at register time, so
// a user-configurable cadence cannot live there; the handler compares
// `backup_last_run_at` against the chosen interval and marks the run a no-op
// when it is not yet due. `markNoOp()` matters: it leaves `lastRun` unstamped,
// so a run that skipped is not treated as a run that happened.
//
// `off` is expressed as a failing CONDITION rather than an early return, which
// is as close as this scheduler gets to the plan's "unregister" — the job is
// never created rather than created and abandoned. `AppScheduler` has no
// `unregister`.
//
// The Wi-Fi check is in the handler rather than in a condition because it is
// async and `TaskCondition`'s custom check is synchronous.
//
// **Everything except the synchronous condition helpers is require()d INSIDE
// the handler, and that is a cold-start decision, not a style one.** This file
// is side-effect imported from `app/_layout.tsx`, so a static import here
// evaluates at boot on every launch. Static imports pulled in the whole backup
// stack — the codec, @noble/ciphers, @noble/hashes, pako, RNFS,
// expo-file-system — plus `react-native-cloud-storage`, which resolves TWO
// TurboModules at module scope and has no other importer in the app. All of
// that for a feature that is OFF by default and, for most users, never turned
// on. `backup-settings` stays static because the scheduler evaluates its
// condition synchronously and it only reaches `setting-service`, which is
// already on the boot path.

import {
  backupProviderId,
  connectionSatisfiesWifiOnly,
  recordBackupRun,
  scheduledBackupEnabled,
  scheduledBackupIsDue,
} from '@/lib/backup/backup-settings';
import type { BackupProvider } from '@/lib/backup/types';

import { AppScheduler } from '../AppScheduler';
import { backgroundWorkIsIdle } from '../background-idle';

function resolveProvider(): BackupProvider | null {
  switch (backupProviderId()) {
    case 'icloud':
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('@/lib/backup/providers/icloud').icloudProvider as BackupProvider;
    case 'google-drive':
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('@/lib/backup/providers/google-drive').googleDriveProvider as BackupProvider;
    case 'file':
      // Stated rather than left to `default`. A file the user saved by hand has
      // no address this task holds, so there is nothing to write to unattended.
      // `scheduledBackupEnabled()` already keeps the job from being created at
      // all; this is the second gate, so a future edit to either one cannot
      // quietly start writing.
      return null;
    default:
      return null;
  }
}

AppScheduler.register({
  name: 'backup',
  displayName: 'Backup',
  frequency: 6 * 60 * 60 * 1000,
  triggers: ['app-foreground'],
  conditions: [
    { type: 'db-ready' },
    { type: 'network' },
    // Reads the synchronous mirror in backup-settings.ts, which exists
    // precisely because this callback cannot be async. It is also what keeps
    // the whole backup stack off the boot path: this returns false without
    // loading any of it.
    { type: 'custom', check: scheduledBackupEnabled },
    // An export holds a WatermelonDB reader for its snapshot phase, blocking
    // every writer. Deferring to an idle app is what keeps that out of the way
    // of a feed sync the user is waiting on.
    { type: 'custom', check: backgroundWorkIsIdle },
  ],
  // Generous: a large persona is minutes of compression and a 25 MB upload.
  timeout: 5 * 60 * 1000,
  maxAttempts: 2,
  exclusive: true,
  handler: async (_input, ctx) => {
    const now = Date.now();
    if (!scheduledBackupIsDue(now)) {
      ctx.markNoOp();
      return;
    }

    if (!(await connectionSatisfiesWifiOnly())) {
      // Not a failure. The user asked not to spend cellular data on this, and
      // the next foreground will ask again.
      ctx.log('waiting for Wi-Fi');
      ctx.markNoOp();
      return;
    }

    const provider = resolveProvider();
    if (!provider) {
      ctx.markNoOp();
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runBackup } = require('@/lib/backup/backup-service') as typeof import('@/lib/backup/backup-service');

    const result = await runBackup(provider, (progress) => {
      ctx.reportProgress({ step: progress.phase, current: progress.rowsWritten });
    });

    // Stamped only on a real upload, so a failed run retries at the next tick
    // rather than resetting the clock.
    await recordBackupRun(now);
    ctx.log(
      `backed up ${result.header.tables.reduce((n, t) => n + t.rows, 0)} rows ` +
        `(${Math.round(result.blobBytes / 1024)} KB) to ${provider.id}`,
    );
  },
});
