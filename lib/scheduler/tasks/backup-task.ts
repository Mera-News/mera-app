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

import {
  backupProviderId,
  connectionSatisfiesWifiOnly,
  recordBackupRun,
  scheduledBackupEnabled,
  scheduledBackupIsDue,
} from '@/lib/backup/backup-settings';
import { runBackup } from '@/lib/backup/backup-service';
import { googleDriveProvider } from '@/lib/backup/providers/google-drive';
import { icloudProvider } from '@/lib/backup/providers/icloud';
import type { BackupProvider } from '@/lib/backup/types';

import { AppScheduler } from '../AppScheduler';
import { backgroundWorkIsIdle } from '../background-idle';

function resolveProvider(): BackupProvider | null {
  switch (backupProviderId()) {
    case 'icloud':
      return icloudProvider;
    case 'google-drive':
      return googleDriveProvider;
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
    // precisely because this callback cannot be async.
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
