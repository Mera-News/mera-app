// Process-lifetime scheduler state that dispose() cannot reset: the once-per-process keychain
// migration and the permanent `suspended` flag. This file owns both, so it is its own module
// registry; the suspend tests come last because nothing can lift a suspension.
import '@/test/helpers';

import { LAST_FOREGROUND_AT_KEY } from '@/lib/background/bg-refresh-settings';
import { getSetting, deleteSetting } from '@/lib/database/services/setting-service';
import { KEYCHAIN_AFU_MIGRATION_KEY } from '@/lib/utils/keychain-accessibility-migration';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { advanceUntilDone, setAppState, useFakeClock } from '@/test/helpers';

import { addTask, jobRows, resetScheduler, settle } from './support';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

beforeEach(() => {
  useFakeClock(T0);
  resetScheduler();
});

afterEach(() => {
  AppScheduler.dispose();
});

const init = () => advanceUntilDone(AppScheduler.init());

describe('a real activation', () => {
  it('records last_foreground_at, and starts the keychain migration only once per process', async () => {
    await init();
    expect(await getSetting(LAST_FOREGROUND_AT_KEY)).toBeNull();

    setAppState('background');
    setAppState('active');
    await settle(500);

    expect(Number(await getSetting(LAST_FOREGROUND_AT_KEY))).toBeGreaterThanOrEqual(T0);
    expect(await getSetting(KEYCHAIN_AFU_MIGRATION_KEY)).not.toBeNull();

    // Second activation: the foreground stamp moves, the migration does not run again.
    await deleteSetting(KEYCHAIN_AFU_MIGRATION_KEY);
    jest.setSystemTime(T0 + 60_000);
    setAppState('background');
    setAppState('active');
    await settle(500);

    expect(Number(await getSetting(LAST_FOREGROUND_AT_KEY))).toBeGreaterThanOrEqual(T0 + 60_000);
    expect(await getSetting(KEYCHAIN_AFU_MIGRATION_KEY)).toBeNull();
  });

  it('is not recorded for a backgrounding, only for an activation', async () => {
    await init();

    setAppState('background');
    await settle(500);

    expect(await getSetting(LAST_FOREGROUND_AT_KEY)).toBeNull();
  });
});

describe('suspend (the mandatory-update gate)', () => {
  it('during init leaves no tick, no listener and no run armed', async () => {
    const task = addTask({ frequency: 10_000, triggers: ['app-foreground', 'network-reconnect'] });

    const initializing = AppScheduler.init();
    AppScheduler.suspend();
    await advanceUntilDone(initializing);

    setAppState('background');
    setAppState('active');
    await settle(30_000);

    expect(task.runs).toHaveLength(0);
    expect(useSchedulerStore.getState().status).toBe('paused');
  });

  it('turns a later init into a no-op and a later trigger into a run that never starts', async () => {
    const task = addTask({ frequency: 10_000 });

    await init();
    await settle(30_000);
    expect(task.runs).toHaveLength(0);
    expect(useSchedulerStore.getState().status).not.toBe('running');

    await expect(advanceUntilDone(AppScheduler.trigger(task.name))).resolves.toBe('ran');
    expect(task.runs).toHaveLength(0);
    expect(await jobRows(task.name)).toHaveLength(0);
  });
});
