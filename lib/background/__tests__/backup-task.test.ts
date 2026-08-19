// The backup background task.
//
// What matters here is what happens when things go WRONG, because this runs
// with nobody watching. Three properties:
//
//   1. `backup_last_run_at` is stamped ONLY on a run that provably finished.
//      Stamping an interrupted run costs a missing backup; not stamping a
//      finished one costs a redundant backup. Those are not symmetric.
//   2. A failure returns `Failed`, which is what lets the OS back off instead
//      of retrying into a flat battery.
//   3. `off` and `manual` UNREGISTER the task rather than registering one that
//      wakes up and returns early. The foreground scheduler could not do this;
//      this API can.

const calls: string[] = [];

let mockTaskBody: ((...a: unknown[]) => Promise<unknown>) | null = null;
let mockRegistered = false;
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn((_name: string, fn: (...a: unknown[]) => Promise<unknown>) => {
    mockTaskBody = fn;
  }),
  isTaskRegisteredAsync: jest.fn(async () => mockRegistered),
}));

let mockExpiryListener: (() => void) | null = null;
let mockStatus = 2; // Available
jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  getStatusAsync: jest.fn(async () => mockStatus),
  registerTaskAsync: jest.fn(async (_n: string, o: { minimumInterval?: number }) => {
    calls.push(`register:${o?.minimumInterval}`);
    mockRegistered = true;
  }),
  unregisterTaskAsync: jest.fn(async () => {
    calls.push('unregister');
    mockRegistered = false;
  }),
  addExpirationListener: jest.fn((l: () => void) => {
    mockExpiryListener = l;
    return { remove: () => { mockExpiryListener = null; } };
  }),
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
}));

const mockRunBackup = jest.fn(async () => {
  calls.push('runBackup');
  return { header: { tables: [{ table: 'facts', rows: 2, rowsAvailable: 2 }] }, blobBytes: 1 };
});
jest.mock('@/lib/backup/backup-service', () => ({ runBackup: () => mockRunBackup() }));
jest.mock('@/lib/backup/providers/icloud', () => ({ icloudProvider: { id: 'icloud' } }));
jest.mock('@/lib/backup/providers/google-drive', () => ({ googleDriveProvider: { id: 'google-drive' } }));

import {
  backgroundBackupIsAvailable,
  defineBackupTask,
  syncBackupTaskRegistration,
} from '../backup-task';

const SUCCESS = 1;
const FAILED = 2;

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockEnabled = true;
  mockDue = true;
  mockWifiOk = true;
  mockProvider = 'icloud';
  mockCadence = 'daily';
  mockStatus = 2;
  mockRegistered = false;
  defineBackupTask();
});

describe('the run', () => {
  it('hydrates its own settings, because the OS may have started the process just for this', async () => {
    await mockTaskBody?.();
    expect(calls.indexOf('hydrate')).toBeLessThan(calls.indexOf('runBackup'));
  });

  it('backs up and stamps the run', async () => {
    expect(await mockTaskBody?.()).toBe(SUCCESS);
    expect(calls).toContain('runBackup');
    expect(calls).toContain('recordBackupRun');
  });

  it('does nothing when it is not yet due', async () => {
    mockDue = false;
    expect(await mockTaskBody?.()).toBe(SUCCESS);
    expect(mockRunBackup).not.toHaveBeenCalled();
    expect(mockRecordRun).not.toHaveBeenCalled();
  });

  it('waits for Wi-Fi rather than spending mobile data', async () => {
    mockWifiOk = false;
    // Success, not Failed: the user asked for this, so there is nothing for the
    // system to back off from.
    expect(await mockTaskBody?.()).toBe(SUCCESS);
    expect(mockRunBackup).not.toHaveBeenCalled();
  });

  it('does nothing when backup is not configured', async () => {
    mockEnabled = false;
    expect(await mockTaskBody?.()).toBe(SUCCESS);
    expect(mockRunBackup).not.toHaveBeenCalled();
  });
});

describe('when it goes wrong', () => {
  it('returns Failed and leaves the timestamp alone, so the next window retries', async () => {
    mockRunBackup.mockRejectedValueOnce(new Error('upload died'));
    expect(await mockTaskBody?.()).toBe(FAILED);
    // Not stamping is what makes this self-healing: the staleness line keeps
    // counting up and the next window tries again.
    expect(mockRecordRun).not.toHaveBeenCalled();
  });

  it('does NOT stamp a run the system interrupted', async () => {
    mockRunBackup.mockImplementationOnce(async () => {
      // iOS pulls the runtime mid-upload. The upload may even have completed,
      // but we cannot tell, and a missing backup is worse than a redundant one.
      mockExpiryListener?.();
      return { header: { tables: [] }, blobBytes: 0 };
    });
    expect(await mockTaskBody?.()).toBe(FAILED);
    expect(mockRecordRun).not.toHaveBeenCalled();
  });

  it('removes the expiration listener afterwards', async () => {
    await mockTaskBody?.();
    expect(mockExpiryListener).toBeNull();
  });
});

describe('registration follows the cadence', () => {
  it('registers with the cadence as a minimum interval IN MINUTES', async () => {
    mockCadence = 'daily';
    await syncBackupTaskRegistration();
    expect(calls).toContain(`register:${24 * 60}`);

    calls.length = 0;
    mockCadence = 'weekly';
    await syncBackupTaskRegistration();
    expect(calls).toContain(`register:${7 * 24 * 60}`);
  });

  it('UNREGISTERS on off or manual rather than waking up to do nothing', async () => {
    mockRegistered = true;
    mockEnabled = false;
    mockCadence = 'off';
    await syncBackupTaskRegistration();
    expect(calls).toContain('unregister');
  });

  it('does not try to unregister a task that was never registered', async () => {
    mockRegistered = false;
    mockEnabled = false;
    mockCadence = 'manual';
    await syncBackupTaskRegistration();
    expect(calls).not.toContain('unregister');
  });

  it('never throws into a settings tap or app boot', async () => {
    const bg = require('expo-background-task');
    bg.registerTaskAsync.mockRejectedValueOnce(new Error('denied'));
    await expect(syncBackupTaskRegistration()).resolves.toBeUndefined();
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
