// The scheduled backup as the second step of the wake, on the REAL backup stack: settings mirror,
// key store over the stateful keychain, the real export from the in-memory DB, the iCloud provider
// over the cloud-storage fake. Only the native edges (RNFS, cloud storage, expo-file-system, NetInfo,
// the OS task status) are stand-ins.
//
// Replaces lib/background/__tests__/backup-task.test.ts. That suite mocked the backup settings, the
// backup service and both providers; "backs up and stamps the run" asserted two mock calls. Here a
// blob really arrives on the remote and the run stamp is read back from the settings table.
// Not carried over: "delegates registration to the one-task reconciler" lives in registration.test.ts.
jest.mock('expo-task-manager', () => require('./native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('./native-fakes').backgroundTaskModule);
jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@dr.pogodin/react-native-fs', () => require('../backup/fakes').rnfsModule);
jest.mock('react-native-cloud-storage', () => require('../backup/fakes').cloudStorageModule);

import NetInfo from '@react-native-community/netinfo';
import * as Sentry from '@sentry/react-native';

import {
  BACKUP_CADENCE_KEY,
  BACKUP_LAST_FAILED_KEY,
  BACKUP_LAST_RUN_KEY,
  BACKUP_PROVIDER_KEY,
  BACKUP_WIFI_ONLY_KEY,
  hydrateBackupSettings,
} from '@/lib/backup/backup-settings';
import { ensureBackupKey, markRecoveryCodeConfirmed } from '@/lib/backup/key-store';
import { runScheduledBackup, backgroundBackupIsAvailable } from '@/lib/background/backup-task';
import { runBackgroundWake } from '@/lib/background/background-task';
import { BG_REFRESH_ENABLED_KEY } from '@/lib/background/bg-refresh-settings';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { addFact } from '@/lib/database/services/fact-service';
import { advanceUntilDone } from '@/test/helpers';
import { resetFileSystem } from '@/test/helpers/fs';

import { remoteNames, resetFakes, shared } from '../backup/fakes';
import { BackgroundTaskResult, resetNativeTasks, setBackgroundStatus } from './native-fakes';
import { HOUR, NOW, breadcrumbs, failBatchWhere, wakeCleanup, wakeWorld } from './support';

jest.setTimeout(60_000);

const DAY = 24 * HOUR;

beforeEach(async () => {
  resetNativeTasks();
  resetFakes();
  resetFileSystem();
  // NetInfo's setup mock is a plain jest.fn: back to its default answer, which names no connection type.
  (NetInfo.fetch as jest.Mock).mockReset().mockResolvedValue({ isConnected: true, isInternetReachable: true });
  await wakeWorld();
  // The OS may start the process just for this: the mirror is empty until the step hydrates it.
});
afterEach(wakeCleanup);

/** A device that has finished backup setup and asked for a daily iCloud backup, on Wi-Fi. */
async function setUpBackup(over: { cadence?: string; wifiOnly?: boolean; lastRunAt?: number; confirmed?: boolean } = {}): Promise<void> {
  await ensureBackupKey();
  if (over.confirmed !== false) await markRecoveryCodeConfirmed();
  await setSetting(BACKUP_CADENCE_KEY, over.cadence ?? 'daily');
  await setSetting(BACKUP_PROVIDER_KEY, 'icloud');
  if (over.wifiOnly !== undefined) await setSetting(BACKUP_WIFI_ONLY_KEY, over.wifiOnly ? '1' : '0');
  if (over.lastRunAt !== undefined) await setSetting(BACKUP_LAST_RUN_KEY, String(over.lastRunAt));
  await addFact('I follow racing');
}
const connection = (type: string) => (NetInfo.fetch as jest.Mock).mockResolvedValue({ type, isConnected: true });
const onWifi = () => connection('wifi');
const onCellular = () => connection('cellular');
const run = () => advanceUntilDone(runScheduledBackup());
const captured = () => (Sentry.captureException as jest.Mock).mock.calls;

describe('the run', () => {
  it('hydrates its own settings first (nothing else has), backs up, and stamps the run', async () => {
    await setUpBackup();
    await hydrateBackupSettings();
    expect((await getSetting(BACKUP_LAST_RUN_KEY))).toBeNull();
    onWifi();

    await run();

    expect(remoteNames()).toHaveLength(1);
    expect(await getSetting(BACKUP_LAST_RUN_KEY)).toBe(String(NOW));
    expect(await getSetting(BACKUP_LAST_FAILED_KEY)).toBeNull();
    expect(captured()).toEqual([]);
  });

  it('does nothing when it is not yet due, so an hourly wake still backs up on its own cadence', async () => {
    await setUpBackup({ lastRunAt: NOW - HOUR });
    onWifi();

    await run();

    expect(remoteNames()).toEqual([]);
    expect(await getSetting(BACKUP_LAST_RUN_KEY)).toBe(String(NOW - HOUR));
  });

  it('weekly: due only after 7 days', async () => {
    await setUpBackup({ cadence: 'weekly', lastRunAt: NOW - 6 * DAY });
    onWifi();
    await run();
    expect(remoteNames()).toEqual([]);

    await setSetting(BACKUP_LAST_RUN_KEY, String(NOW - 7 * DAY));
    onWifi();
    await run();
    expect(remoteNames()).toHaveLength(1);
  });

  it('waits for Wi-Fi rather than spending mobile data: no upload, and not a failure', async () => {
    await setUpBackup();
    onCellular();

    await run();

    expect(remoteNames()).toEqual([]);
    expect(await getSetting(BACKUP_LAST_FAILED_KEY)).toBeNull();
    expect(captured()).toEqual([]);
  });

  it('backs up over mobile data when the reader allowed it', async () => {
    await setUpBackup({ wifiOnly: false });
    onCellular();

    await run();

    expect(remoteNames()).toHaveLength(1);
  });

  it('does nothing when backup is not configured: off, manual, or no destination', async () => {
    await setUpBackup({ cadence: 'off' });
    onWifi();
    await run();
    await setSetting(BACKUP_CADENCE_KEY, 'manual');
    onWifi();
    await run();
    await setSetting(BACKUP_CADENCE_KEY, 'daily');
    await setSetting(BACKUP_PROVIDER_KEY, 'dropbox');
    onWifi();
    await run();

    expect(remoteNames()).toEqual([]);
    expect(await getSetting(BACKUP_LAST_RUN_KEY)).toBeNull();
  });
});

describe('when it goes wrong', () => {
  it('leaves the run stamp alone and stamps the failure, without throwing; any other failure is captured', async () => {
    await setUpBackup();
    shared.icloudAvailable = false; // the provider refuses: not a "not set up" state
    onWifi();

    await expect(run()).resolves.toBeUndefined();

    expect(await getSetting(BACKUP_LAST_RUN_KEY)).toBeNull();
    expect(await getSetting(BACKUP_LAST_FAILED_KEY)).toBe(String(NOW));
    expect(captured()).toHaveLength(1);
    expect(captured()[0][1].tags).toEqual({ service: 'backup-task' });
  });

  it('a device with no backup key stamps the failure but files no Sentry event (MERA-APP-7Z), only a breadcrumb', async () => {
    await setSetting(BACKUP_CADENCE_KEY, 'daily');
    await setSetting(BACKUP_PROVIDER_KEY, 'icloud');
    onWifi();

    await run();

    expect(captured()).toEqual([]);
    expect(breadcrumbs()).toContain('backup: not set up on this device');
    expect(await getSetting(BACKUP_LAST_FAILED_KEY)).toBe(String(NOW));
    expect(await getSetting(BACKUP_LAST_RUN_KEY)).toBeNull();
  });

  it('a recovery code the reader never confirmed is the same quiet state', async () => {
    await setUpBackup({ confirmed: false });
    onWifi();

    await run();

    expect(captured()).toEqual([]);
    expect(breadcrumbs()).toContain('backup: not set up on this device');
    expect(await getSetting(BACKUP_LAST_FAILED_KEY)).toBe(String(NOW));
    expect(remoteNames()).toEqual([]);
  });

  it('never throws even when the failure stamp fails too', async () => {
    await setUpBackup();
    shared.icloudAvailable = false;
    failBatchWhere((op) => op.table === 'settings' && op.raw?.key === BACKUP_LAST_FAILED_KEY);
    onWifi();

    await expect(run()).resolves.toBeUndefined();

    expect(await getSetting(BACKUP_LAST_RUN_KEY)).toBeNull();
  });
});

describe('a provider id this build does not know', () => {
  it('a restored settings row naming one is read as no destination: nothing runs, nothing is stamped', async () => {
    await setUpBackup();
    await setSetting(BACKUP_PROVIDER_KEY, 'onedrive');
    onWifi();

    await run();

    expect(remoteNames()).toEqual([]);
    expect(await getSetting(BACKUP_LAST_RUN_KEY)).toBeNull();
    expect(await getSetting(BACKUP_LAST_FAILED_KEY)).toBeNull();
    expect(captured()).toEqual([]);
  });
});

describe('the Drive destination', () => {
  it('is resolved from the setting, not the iCloud provider: nothing reaches iCloud, and the run never throws', async () => {
    await setUpBackup();
    await setSetting(BACKUP_PROVIDER_KEY, 'google-drive');
    onWifi();

    await expect(run()).resolves.toBeUndefined();

    expect(remoteNames('icloud')).toEqual([]);
  });
});

describe('inside the wake', () => {
  it('runs after the refresh, whatever the refresh did, and an hourly wake backs up only when due', async () => {
    await setUpBackup();
    onWifi();

    await advanceUntilDone(runBackgroundWake());
    expect(remoteNames()).toHaveLength(1);
    expect(Number(await getSetting(BACKUP_LAST_RUN_KEY))).toBeGreaterThanOrEqual(NOW);

    jest.setSystemTime(NOW + HOUR);
    await advanceUntilDone(runBackgroundWake());
    expect(remoteNames()).toHaveLength(1); // an hour later it is not due again
  });

  it('backs up on a wake whose refresh is off', async () => {
    await setUpBackup();
    await setSetting(BG_REFRESH_ENABLED_KEY, '0');
    onWifi();

    const result = await advanceUntilDone(runBackgroundWake());

    expect(result).toBe(BackgroundTaskResult.Success);
    expect(remoteNames()).toHaveLength(1);
  });
});

describe('availability', () => {
  it('is true when the OS allows background work, false when it restricts it', async () => {
    expect(await backgroundBackupIsAvailable()).toBe(true);
    setBackgroundStatus(1); // Restricted: the iOS simulator and Expo Go
    expect(await backgroundBackupIsAvailable()).toBe(false);
  });

  it('reports false rather than throwing at a settings screen', async () => {
    setBackgroundStatus(new Error('nope'));
    expect(await backgroundBackupIsAvailable()).toBe(false);
  });
});
