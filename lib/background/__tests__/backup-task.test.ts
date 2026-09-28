// The scheduled backup, as the second step of the `mera-background` wake.
//
// What matters here is what happens when things go WRONG, because this runs
// with nobody watching:
//
//   1. `backup_last_run_at` is stamped ONLY on a run that provably finished.
//      Stamping an interrupted run costs a missing backup; not stamping a
//      finished one costs a redundant backup. Those are not symmetric.
//   2. A failure is reported and stamped as a failure, and never throws into
//      the wake: the refresh step before it has already run.
//   3. `off` and `manual` want no wake at all (`backupIntervalMinutes` is
//      undefined), which is what lets the one-task reconciler unregister.
//
// Registration itself is the reconciler's and is tested in
// background-task.test.ts.

const calls: string[] = [];

let mockStatus = 2; // Available
jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  getStatusAsync: jest.fn(async () => mockStatus),
}));

jest.mock('@/lib/sentry-init', () => ({}));
jest.mock('react-native-get-random-values', () => ({}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), addBreadcrumb: jest.fn(), info: jest.fn() },
}));

let mockEnabled = true;
let mockDue = true;
let mockWifiOk = true;
let mockProvider: string | null = 'icloud';
let mockCadence = 'daily';
const mockRecordRun = jest.fn(async (_at: number) => { calls.push('recordBackupRun'); });
jest.mock('@/lib/backup/backup-settings', () => ({
  hydrateBackupSettings: jest.fn(async () => { calls.push('hydrate'); }),
  scheduledBackupEnabled: () => mockEnabled,
  scheduledBackupIsDue: () => mockDue,
  connectionSatisfiesWifiOnly: async () => mockWifiOk,
  backupProviderId: () => mockProvider,
  backupCadence: () => mockCadence,
  recordBackupRun: (at: number) => mockRecordRun(at),
  recordBackupFailure: (at: number) => mockRecordFailure(at),
}));
const mockRecordFailure = jest.fn(async (_at: number) => { calls.push('recordBackupFailure'); });

const mockRunBackup = jest.fn(async () => {
  calls.push('runBackup');
  return { header: { tables: [{ table: 'facts', rows: 2, rowsAvailable: 2 }] }, blobBytes: 1 };
});
jest.mock('@/lib/backup/backup-service', () => ({ runBackup: () => mockRunBackup() }));
jest.mock('@/lib/backup/providers/icloud', () => ({ icloudProvider: { id: 'icloud' } }));
jest.mock('@/lib/backup/providers/google-drive', () => ({ googleDriveProvider: { id: 'google-drive' } }));

const mockSyncBackgroundTaskRegistration = jest.fn(async () => {});
jest.mock('../background-task', () => ({
  syncBackgroundTaskRegistration: () => mockSyncBackgroundTaskRegistration(),
}));

import {
  backgroundBackupIsAvailable,
  backupIntervalMinutes,
  runScheduledBackup,
  syncBackupTaskRegistration,
} from '../backup-task';

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockEnabled = true;
  mockDue = true;
  mockWifiOk = true;
  mockProvider = 'icloud';
  mockCadence = 'daily';
  mockStatus = 2;
});

describe('the run', () => {
  it('hydrates its own settings, because the OS may have started the process just for this', async () => {
    await runScheduledBackup();
    expect(calls.indexOf('hydrate')).toBeLessThan(calls.indexOf('runBackup'));
  });

  it('backs up and stamps the run', async () => {
    await runScheduledBackup();
    expect(calls).toContain('runBackup');
    expect(calls).toContain('recordBackupRun');
  });

  it('does nothing when it is not yet due, so an hourly wake still backs up on its own cadence', async () => {
    mockDue = false;
    await runScheduledBackup();
    expect(mockRunBackup).not.toHaveBeenCalled();
    expect(mockRecordRun).not.toHaveBeenCalled();
  });

  it('waits for Wi-Fi rather than spending mobile data', async () => {
    mockWifiOk = false;
    await runScheduledBackup();
    expect(mockRunBackup).not.toHaveBeenCalled();
  });

  it('does nothing when backup is not configured', async () => {
    mockEnabled = false;
    await runScheduledBackup();
    expect(mockRunBackup).not.toHaveBeenCalled();
  });
});

describe('when it goes wrong', () => {
  it('leaves the run timestamp alone and stamps the failure, without throwing', async () => {
    mockRunBackup.mockRejectedValueOnce(new Error('upload died'));
    await expect(runScheduledBackup()).resolves.toBeUndefined();
    // Not stamping is what makes this self-healing: the staleness line keeps
    // counting up and the next window tries again.
    expect(mockRecordRun).not.toHaveBeenCalled();
    // But the failure IS stamped, so Settings can say "Last backup failed on
    // <date>" instead of going quiet about a schedule that is not working.
    expect(mockRecordFailure).toHaveBeenCalledTimes(1);
  });

  it('never throws even when the failure stamp fails too', async () => {
    mockRunBackup.mockRejectedValueOnce(new Error('upload died'));
    mockRecordFailure.mockRejectedValueOnce(new Error('db gone'));
    await expect(runScheduledBackup()).resolves.toBeUndefined();
  });
});

describe('the interval it wants', () => {
  it('is the cadence IN MINUTES', () => {
    mockCadence = 'daily';
    expect(backupIntervalMinutes()).toBe(24 * 60);
    mockCadence = 'weekly';
    expect(backupIntervalMinutes()).toBe(7 * 24 * 60);
  });

  it('is none for off and manual, which want no wake at all', () => {
    mockEnabled = false;
    mockCadence = 'off';
    expect(backupIntervalMinutes()).toBeUndefined();
    mockCadence = 'manual';
    expect(backupIntervalMinutes()).toBeUndefined();
  });

  it('delegates registration to the one-task reconciler', async () => {
    await syncBackupTaskRegistration();
    expect(mockSyncBackgroundTaskRegistration).toHaveBeenCalledTimes(1);
  });
});

describe('availability', () => {
  it('is false when the OS restricts background work', async () => {
    mockStatus = 1; // Restricted
    expect(await backgroundBackupIsAvailable()).toBe(false);
  });

  it('is true when the OS allows it', async () => {
    expect(await backgroundBackupIsAvailable()).toBe(true);
  });

  it('reports false rather than throwing at a settings screen', async () => {
    const bg = require('expo-background-task');
    bg.getStatusAsync.mockRejectedValueOnce(new Error('nope'));
    expect(await backgroundBackupIsAvailable()).toBe(false);
  });
});
