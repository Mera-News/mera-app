// `mera-background`, the one OS task.
//
// The properties that matter, because nobody is watching when it runs:
//   - a normal state of a device (toggle off, DB unreadable, locked since
//     reboot, signed out) exits QUIETLY: no Sentry event, no toast, no logout;
//   - the order is fixed: toggle (the DB probe), install boundary, keychain,
//     collect, fetch, then backup;
//   - registration: ONE task, one interval (60 min while the refresh is on,
//     else the backup cadence, else unregistered), cycled only when the
//     interval changed, and the retired backup task unregistered AFTER.

const calls: string[] = [];

let mockDefinedBody: (() => Promise<unknown>) | null = null;
let mockRegistered: { taskName: string; options?: { minimumInterval?: number } }[] = [];
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn((_name: string, fn: () => Promise<unknown>) => {
    mockDefinedBody = fn;
  }),
  getRegisteredTasksAsync: jest.fn(async () => mockRegistered),
}));
jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  registerTaskAsync: jest.fn(async (name: string, o: { minimumInterval?: number }) => {
    calls.push(`register:${name}:${o.minimumInterval}`);
  }),
  unregisterTaskAsync: jest.fn(async (name: string) => {
    calls.push(`unregister:${name}`);
  }),
}));

const mockCapture = jest.fn();
const mockBreadcrumb = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...a: unknown[]) => mockCapture(...a),
    addBreadcrumb: (...a: unknown[]) => mockBreadcrumb(...a),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

let mockEnabled: boolean | Error | 'hang' = true;
jest.mock('../bg-refresh-settings', () => ({
  isBgRefreshEnabled: jest.fn(async () => {
    calls.push('toggle');
    if (mockEnabled instanceof Error) throw mockEnabled;
    if (mockEnabled === 'hang') return new Promise<boolean>(() => {});
    return mockEnabled;
  }),
}));

jest.mock('@/lib/security/install-boundary', () => ({
  enforceInstallBoundary: jest.fn(async () => { calls.push('boundary'); }),
}));

let mockCookie: string | null | Error = 'session=abc';
jest.mock('@/lib/auth-client', () => ({
  authClient: {
    getCookie: jest.fn(() => {
      calls.push('cookie');
      if (mockCookie instanceof Error) throw mockCookie;
      return mockCookie;
    }),
  },
}));

let mockScopeDepth = 0;
jest.mock('@/lib/auth-failure-breaker', () => ({
  withTaskAuthScope: jest.fn(async (fn: () => Promise<unknown>) => {
    mockScopeDepth += 1;
    try {
      return await fn();
    } finally {
      mockScopeDepth -= 1;
    }
  }),
}));

const mockAdvance = jest.fn(async (_o: { deadlineAt: number }) => {
  calls.push(`collect:scope=${mockScopeDepth}`);
  return { appliedRelevance: 0, appliedReasons: 0, reasonsSubmitted: 0, stoppedBy: 'done' };
});
jest.mock('@/lib/services/scoring-pipeline', () => ({
  advanceWaitingForBackground: (o: { deadlineAt: number }) => mockAdvance(o),
}));

const mockRunFeedSync = jest.fn(async (_o: { deadlineAt: number }) => {
  calls.push(`fetch:scope=${mockScopeDepth}`);
  return { stoppedBy: 'done', meteredBudget: 10 };
});
jest.mock('../background-feed-sync', () => ({
  runBackgroundFeedSync: (o: { deadlineAt: number }) => mockRunFeedSync(o),
}));

let mockBackupMinutes: number | undefined = 24 * 60;
jest.mock('../backup-task', () => ({
  BACKUP_TASK: 'mera-backup-task',
  runScheduledBackup: jest.fn(async () => { calls.push('backup'); }),
  backupIntervalMinutes: () => mockBackupMinutes,
}));

import {
  BACKGROUND_TASK,
  defineBackgroundTask,
  runBackgroundRefresh,
  runBackgroundWake,
  syncBackgroundTaskRegistration,
} from '../background-task';

const { toastManager } = jest.requireMock('@/lib/toast-manager') as {
  toastManager: { showNotifiedToast: jest.Mock };
};
jest.mock('@/lib/toast-manager', () => ({ toastManager: { showNotifiedToast: jest.fn() } }));

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockEnabled = true;
  mockCookie = 'session=abc';
  mockRegistered = [];
  mockBackupMinutes = 24 * 60;
  mockScopeDepth = 0;
});

describe('the wake', () => {
  it('runs the steps in order: toggle, boundary, keychain, collect, fetch, then backup', async () => {
    await runBackgroundWake();
    expect(calls).toEqual(['toggle', 'boundary', 'cookie', 'collect:scope=1', 'fetch:scope=1', 'backup']);
  });

  it('runs collect and fetch inside the task auth scope, so a 401 never trips the breaker', async () => {
    await runBackgroundRefresh();
    expect(calls).toContain('collect:scope=1');
    expect(calls).toContain('fetch:scope=1');
  });

  it('gives the whole refresh one 60s deadline', async () => {
    const now = Date.now();
    await runBackgroundRefresh(now);
    expect(mockAdvance).toHaveBeenCalledWith({ deadlineAt: now + 60_000 });
    expect(mockRunFeedSync).toHaveBeenCalledWith({ deadlineAt: now + 60_000 });
  });

  it('starts no fetch with less than 15s left', async () => {
    const now = Date.now() - 50_000; // only ~10s left of the 60s budget
    const out = await runBackgroundRefresh(now);
    expect(out.stoppedBy).toBe('deadline');
    expect(mockRunFeedSync).not.toHaveBeenCalled();
  });

  it('still backs up when the refresh is off', async () => {
    mockEnabled = false;
    await runBackgroundWake();
    expect(calls).toEqual(['toggle', 'backup']);
  });

  it('is defined as one task whose body is the wake', async () => {
    defineBackgroundTask();
    expect(mockDefinedBody).not.toBeNull();
    await mockDefinedBody!();
    expect(calls).toContain('backup');
  });
});

describe('quiet exits (no Sentry, no toast)', () => {
  afterEach(() => {
    expect(mockCapture).not.toHaveBeenCalled();
    expect(toastManager.showNotifiedToast).not.toHaveBeenCalled();
  });

  it('toggle off: stops at the first read', async () => {
    mockEnabled = false;
    expect(await runBackgroundRefresh()).toEqual({ stoppedBy: 'disabled' });
    expect(calls).toEqual(['toggle']);
  });

  it("the first read failing is the DB probe: 'db-unavailable', breadcrumb only", async () => {
    mockEnabled = new Error('SQLITE_CANTOPEN');
    expect(await runBackgroundRefresh()).toEqual({ stoppedBy: 'db-unavailable' });
    expect(mockBreadcrumb).toHaveBeenCalled();
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('a hung first read times out as db-unavailable after 3s', async () => {
    jest.useFakeTimers();
    try {
      mockEnabled = 'hang';
      const out = runBackgroundRefresh();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(await out).toEqual({ stoppedBy: 'db-unavailable' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a keychain locked since reboot throws on read: locked, nothing sent', async () => {
    mockCookie = new Error('errSecInteractionNotAllowed');
    expect(await runBackgroundRefresh()).toEqual({ stoppedBy: 'locked' });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('signed out: nothing sent', async () => {
    mockCookie = null;
    expect(await runBackgroundRefresh()).toEqual({ stoppedBy: 'signed-out' });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('an offline fetch is a result, not an exception', async () => {
    mockRunFeedSync.mockResolvedValueOnce({ stoppedBy: 'error', meteredBudget: 10 });
    expect(await runBackgroundRefresh()).toEqual({ stoppedBy: 'done', fetch: 'error' });
  });
});

describe('an unexpected throw', () => {
  it('is reported and the wake still backs up', async () => {
    mockAdvance.mockRejectedValueOnce(new Error('boom'));
    await runBackgroundWake();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(calls).toContain('backup');
  });
});

describe('registration: one task, one interval', () => {
  it('registers hourly while the refresh is on', async () => {
    await syncBackgroundTaskRegistration();
    expect(calls.filter((c) => c !== 'toggle')).toEqual([`register:${BACKGROUND_TASK}:60`]);
  });

  it('uses the backup cadence when the refresh is off', async () => {
    mockEnabled = false;
    await syncBackgroundTaskRegistration();
    expect(calls).toContain(`register:${BACKGROUND_TASK}:${24 * 60}`);
  });

  it('unregisters when both are off: a device that said no has no wake at all', async () => {
    mockEnabled = false;
    mockBackupMinutes = undefined;
    mockRegistered = [{ taskName: BACKGROUND_TASK, options: { minimumInterval: 60 } }];
    await syncBackgroundTaskRegistration();
    expect(calls).toContain(`unregister:${BACKGROUND_TASK}`);
    expect(calls.some((c) => c.startsWith('register:'))).toBe(false);
  });

  it('leaves an up-to-date registration alone (cycling would push the next run out)', async () => {
    mockRegistered = [{ taskName: BACKGROUND_TASK, options: { minimumInterval: 60 } }];
    await syncBackgroundTaskRegistration();
    expect(calls.filter((c) => c !== 'toggle')).toEqual([]);
  });

  it('cycles when the interval changed, because re-registering alone changes nothing', async () => {
    mockEnabled = false;
    mockRegistered = [{ taskName: BACKGROUND_TASK, options: { minimumInterval: 60 } }];
    await syncBackgroundTaskRegistration();
    expect(calls.filter((c) => c !== 'toggle')).toEqual([
      `unregister:${BACKGROUND_TASK}`,
      `register:${BACKGROUND_TASK}:${24 * 60}`,
    ]);
  });

  it('migrates: registers the new task FIRST, then unregisters the retired backup task', async () => {
    mockRegistered = [{ taskName: 'mera-backup-task', options: { minimumInterval: 24 * 60 } }];
    await syncBackgroundTaskRegistration();
    expect(calls.filter((c) => c !== 'toggle')).toEqual([
      `register:${BACKGROUND_TASK}:60`,
      'unregister:mera-backup-task',
    ]);
  });

  it('never throws into a settings tap or boot', async () => {
    const bg = require('expo-background-task');
    bg.registerTaskAsync.mockRejectedValueOnce(new Error('denied'));
    await expect(syncBackgroundTaskRegistration()).resolves.toBeUndefined();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('keeps the default (on) when the toggle cannot be read', async () => {
    mockEnabled = new Error('locked db');
    await syncBackgroundTaskRegistration();
    expect(calls).toContain(`register:${BACKGROUND_TASK}:60`);
  });
});
