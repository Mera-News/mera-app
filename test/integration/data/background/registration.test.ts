// Registration of the ONE OS task: `syncBackgroundTaskRegistration` against the settings the app
// really keeps (the refresh toggle, the backup cadence and provider) and a stateful OS registry.
//
// Replaces lib/background/__tests__/background-task.test.ts ("registration: one task, one interval"),
// lib/background/__tests__/bg-refresh-settings.test.ts (the toggle re-syncs the OS task, both ways)
// and the registration delegation cases of backup-task.test.ts. The legacy suites mocked the
// settings module and the backup interval; both are real here, so a setter that stops calling the
// reconciler is caught.
jest.mock('expo-task-manager', () => require('./native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('./native-fakes').backgroundTaskModule);

import * as Sentry from '@sentry/react-native';

import { BACKUP_TASK, backupIntervalMinutes, syncBackupTaskRegistration } from '@/lib/background/backup-task';
import { BACKGROUND_TASK, REFRESH_INTERVAL_MINUTES, syncBackgroundTaskRegistration, wantedIntervalMinutes } from '@/lib/background/background-task';
import { BG_REFRESH_ENABLED_KEY, isBgRefreshEnabled, setBgRefreshEnabled } from '@/lib/background/bg-refresh-settings';
import {
  BACKUP_CADENCE_KEY,
  BACKUP_PROVIDER_KEY,
  hydrateBackupSettings,
  setBackupCadence,
  setBackupProviderId,
} from '@/lib/backup/backup-settings';
import { setSetting } from '@/lib/database/services/setting-service';

import { osCalls, preRegister, refuseRegistration, registeredTasks, resetNativeTasks } from './native-fakes';
import { failSettingRead, wakeCleanup, wakeWorld } from './support';

beforeEach(async () => {
  resetNativeTasks();
  await wakeWorld();
});
afterEach(wakeCleanup);

const DAILY = 24 * 60;
const WEEKLY = 7 * 24 * 60;

/** The persisted choices, read into the mirror the way the OS wake and the boot do. */
async function configure(over: { refresh?: boolean; cadence?: 'off' | 'manual' | 'daily' | 'weekly'; provider?: string | null }) {
  if (over.refresh === false) await setSetting(BG_REFRESH_ENABLED_KEY, '0');
  if (over.cadence) await setSetting(BACKUP_CADENCE_KEY, over.cadence);
  if (over.provider) await setSetting(BACKUP_PROVIDER_KEY, over.provider);
  await hydrateBackupSettings();
}

describe('the interval the one task wants', () => {
  it('is 60 minutes while the refresh is on, which is the default of a device never asked', async () => {
    expect(await isBgRefreshEnabled()).toBe(true);
    expect(await wantedIntervalMinutes()).toBe(REFRESH_INTERVAL_MINUTES);
    expect(REFRESH_INTERVAL_MINUTES).toBe(60);
  });

  it('is the backup cadence in MINUTES when the refresh is off', async () => {
    await configure({ refresh: false, cadence: 'daily', provider: 'icloud' });
    expect(backupIntervalMinutes()).toBe(DAILY);
    expect(await wantedIntervalMinutes()).toBe(DAILY);

    await configure({ cadence: 'weekly' });
    expect(await wantedIntervalMinutes()).toBe(WEEKLY);
  });

  it('is none when both are off: off and manual want no wake, and neither does a cadence without a destination', async () => {
    await configure({ refresh: false, cadence: 'off', provider: 'icloud' });
    expect(await wantedIntervalMinutes()).toBeUndefined();
    await configure({ cadence: 'manual' });
    expect(await wantedIntervalMinutes()).toBeUndefined();
    await setSetting(BACKUP_PROVIDER_KEY, 'dropbox'); // not a destination this build offers
    await configure({ cadence: 'daily' });
    expect(backupIntervalMinutes()).toBeUndefined();
  });

  it('keeps the default (on) when the toggle cannot be read', async () => {
    await configure({ refresh: false });
    failSettingRead(BG_REFRESH_ENABLED_KEY);

    expect(await wantedIntervalMinutes()).toBe(REFRESH_INTERVAL_MINUTES);
  });
});

describe('registration: one task, one interval', () => {
  it('registers hourly while the refresh is on', async () => {
    await syncBackgroundTaskRegistration();

    expect(osCalls()).toEqual([`register:${BACKGROUND_TASK}:60`]);
  });

  it('uses the backup cadence when the refresh is off', async () => {
    await configure({ refresh: false, cadence: 'daily', provider: 'icloud' });

    await syncBackgroundTaskRegistration();

    expect(osCalls()).toEqual([`register:${BACKGROUND_TASK}:${DAILY}`]);
  });

  it('unregisters when both are off: a device that said no has no wake at all', async () => {
    preRegister(BACKGROUND_TASK, 60);
    await configure({ refresh: false, cadence: 'off' });

    await syncBackgroundTaskRegistration();

    expect(osCalls()).toEqual([`unregister:${BACKGROUND_TASK}`]);
    expect(registeredTasks()).toEqual([]);
  });

  it('registers nothing for a device that wants nothing and holds nothing', async () => {
    await configure({ refresh: false, cadence: 'off' });

    await syncBackgroundTaskRegistration();

    expect(osCalls()).toEqual([]);
  });

  it('leaves an up-to-date registration alone: cycling would push the next run out', async () => {
    preRegister(BACKGROUND_TASK, 60);

    await syncBackgroundTaskRegistration();
    await syncBackgroundTaskRegistration();

    expect(osCalls()).toEqual([]);
  });

  it('cycles when the interval changed, because re-registering alone changes nothing', async () => {
    preRegister(BACKGROUND_TASK, 60);
    await configure({ refresh: false, cadence: 'daily', provider: 'icloud' });

    await syncBackgroundTaskRegistration();

    expect(osCalls()).toEqual([`unregister:${BACKGROUND_TASK}`, `register:${BACKGROUND_TASK}:${DAILY}`]);
    expect(registeredTasks()).toEqual([{ taskName: BACKGROUND_TASK, options: { minimumInterval: DAILY } }]);
  });

  it('migrates: registers the new task FIRST, then unregisters the retired backup task', async () => {
    preRegister(BACKUP_TASK, DAILY);

    await syncBackgroundTaskRegistration();

    expect(osCalls()).toEqual([`register:${BACKGROUND_TASK}:60`, `unregister:${BACKUP_TASK}`]);
  });

  it('removes the retired backup task even when nothing is wanted', async () => {
    preRegister(BACKUP_TASK, DAILY);
    await configure({ refresh: false, cadence: 'off' });

    await syncBackgroundTaskRegistration();

    expect(osCalls()).toEqual([`unregister:${BACKUP_TASK}`]);
  });

  it('never throws into a settings tap or boot: it is reported once, with its step', async () => {
    refuseRegistration(new Error('denied'));

    await expect(syncBackgroundTaskRegistration()).resolves.toBeUndefined();

    const captured = (Sentry.captureException as jest.Mock).mock.calls;
    expect(captured).toHaveLength(1);
    expect(captured[0][1].tags).toEqual({ service: 'background-task', step: 'register' });
  });
});

describe('the settings that own the registration call the reconciler themselves', () => {
  it('turning the refresh off unregisters the task, and on registers it again', async () => {
    await syncBackgroundTaskRegistration();
    expect(registeredTasks()).toHaveLength(1);

    await setBgRefreshEnabled(false);
    expect(registeredTasks()).toEqual([]);
    expect(await isBgRefreshEnabled()).toBe(false);

    await setBgRefreshEnabled(true);
    expect(registeredTasks()).toEqual([{ taskName: BACKGROUND_TASK, options: { minimumInterval: 60 } }]);
    expect(await isBgRefreshEnabled()).toBe(true);
  });

  it('keeps the saved choice even when the OS refuses the registration change', async () => {
    await syncBackgroundTaskRegistration();
    refuseRegistration(new Error('denied'));

    await expect(setBgRefreshEnabled(false)).resolves.toBeUndefined();

    expect(await isBgRefreshEnabled()).toBe(false);
  });

  it('choosing a backup destination and cadence registers the backup interval once the refresh is off', async () => {
    await setBgRefreshEnabled(false);
    expect(registeredTasks()).toEqual([]);

    await setBackupProviderId('icloud');
    await setBackupCadence('weekly');

    expect(registeredTasks()).toEqual([{ taskName: BACKGROUND_TASK, options: { minimumInterval: WEEKLY } }]);

    await setBackupCadence('manual');
    expect(registeredTasks()).toEqual([]);
  });

  it('the backup module delegates its registration to the one-task reconciler', async () => {
    await syncBackupTaskRegistration();

    expect(osCalls()).toEqual([`register:${BACKGROUND_TASK}:60`]);
  });
});
