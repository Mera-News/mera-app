// The event paths into the scheduler: a foreground return, the post-hydration boot kick (cold,
// restart and background-wake cases) and a network reconnect. Real singleton, runner, persistence,
// store and settings rows; only the clock and AppState are faked.
//
// The discriminating task throughout is `frequency: 5 min` with a `lastRun` between the 5s cold
// floor and the 60s warm floor. A task under 60s collapses both floors to its own frequency, and
// the cold case passes whichever way the flag goes, so the WARM case is asserted positively (it
// does NOT run).
import '@/test/helpers';

import { RESTART_MARKER_KEY, initRestartContext } from '@/lib/app-restart';
import { setSetting } from '@/lib/database/services/setting-service';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import * as persistence from '@/lib/scheduler/scheduler-persistence';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { advanceUntilDone, setAppState, useFakeClock } from '@/test/helpers';

import { addTask, resetScheduler, settle } from './support';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

beforeEach(() => {
  useFakeClock(T0);
  resetScheduler();
});

afterEach(() => {
  AppScheduler.dispose();
});

/** A foreground task last run `agoMs` ago, persisted so init loads it. */
async function foregroundTask(agoMs: number | null, extra: Parameters<typeof addTask>[0] = {}) {
  const task = addTask({ frequency: 5 * 60_000, triggers: ['app-foreground'], ...extra });
  if (agoMs !== null) await persistence.saveLastRun(task.name, T0 - agoMs);
  return task;
}

const init = () => advanceUntilDone(AppScheduler.init());

/** What `requestRestart` leaves behind for the next boot, then the boot's `initRestartContext()`. */
async function bootAfterRestart(): Promise<void> {
  await setSetting(
    RESTART_MARKER_KEY,
    JSON.stringify({ reason: 'ota', at: T0 - 5_000, backgroundedAt: T0 - 8_000, lastForegroundAt: T0 - 9_000 }),
  );
  await advanceUntilDone(initRestartContext());
}

const backgroundThenForeground = async () => {
  setAppState('background');
  setAppState('active');
  await settle(500);
};

describe('foreground return', () => {
  it('runs only the tasks that declare the app-foreground trigger', async () => {
    const onForeground = await foregroundTask(120_000);
    const onReconnect = addTask({ frequency: 5 * 60_000, triggers: ['network-reconnect'] });
    const timerOnly = addTask({ frequency: 5 * 60_000 });
    await persistence.saveLastRun(onReconnect.name, T0 - 120_000);
    await persistence.saveLastRun(timerOnly.name, T0 - 120_000);
    await init();

    await backgroundThenForeground();

    expect(onForeground.runs).toHaveLength(1);
    expect(onReconnect.runs).toHaveLength(0);
    expect(timerOnly.runs).toHaveLength(0);
  });

  it('holds the 60s warm floor: a 5 minute task that ran 30s ago does NOT run', async () => {
    const task = await foregroundTask(30_000);
    await init();

    await backgroundThenForeground();

    expect(task.runs).toHaveLength(0);
  });

  it('runs a 5 minute task that last ran 2 minutes ago, well inside its own cadence', async () => {
    const task = await foregroundTask(120_000);
    await init();

    await backgroundThenForeground();

    expect(task.runs).toHaveLength(1);
  });

  it('does not gate the foreground on a recent failure, though the tick does', async () => {
    const task = await foregroundTask(null, { maxAttempts: 1, failWith: new Error('boom') });
    await init();
    await settle(500);
    expect(task.runs).toHaveLength(1);

    await settle(1_000);
    await backgroundThenForeground();

    expect(task.runs).toHaveLength(2);
  });

  it('keeps a frequency 0 task always due on foreground', async () => {
    const task = addTask({ frequency: 0, triggers: ['app-foreground'] });
    await init();

    await backgroundThenForeground();
    await backgroundThenForeground();

    expect(task.runs).toHaveLength(2);
  });

  it('skips an exclusive task that is already running', async () => {
    const task = await foregroundTask(null, { exclusive: true, hang: true });
    await init();
    await settle(500);
    expect(task.runs).toHaveLength(1);

    await backgroundThenForeground();

    expect(task.runs).toHaveLength(1);
    task.release();
    await settle(500);
  });

  it('skips a paused task', async () => {
    const task = await foregroundTask(120_000);
    AppScheduler.pauseTask(task.name);
    await init();

    await backgroundThenForeground();

    expect(task.runs).toHaveLength(0);
  });

  it('skips a task whose condition fails (conditions bind the foreground path)', async () => {
    const task = await foregroundTask(120_000, { conditions: [{ type: 'custom', check: () => false }] });
    await init();

    await backgroundThenForeground();

    expect(task.runs).toHaveLength(0);
  });

  describe('a stale running flag', () => {
    // timeout 30s -> the flag counts as stale once older than timeout + 30s = 60s.
    it('older than timeout + 30s is cleared on foreground, so the task runs again', async () => {
      const task = await foregroundTask(null, { exclusive: true, hang: true, timeout: 30_000 });
      await init();
      await settle(500);
      await settle(70_000);
      expect(task.runs).toHaveLength(1);
      expect(useSchedulerStore.getState().isRunning(task.name)).toBe(true);

      await backgroundThenForeground();

      expect(task.runs).toHaveLength(2);
      task.release();
      await settle(500);
    });

    it('inside timeout + 30s is kept: a genuinely running task is not run twice', async () => {
      const task = await foregroundTask(null, { exclusive: true, hang: true, timeout: 30_000 });
      await init();
      await settle(500);
      await settle(40_000);

      await backgroundThenForeground();

      expect(task.runs).toHaveLength(1);
      task.release();
      await settle(500);
    });
  });
});

describe('onStoresHydrated', () => {
  it('on a cold boot uses the 5s floor, so a task that ran 30s ago runs, after the 200ms yield and 250ms settle', async () => {
    const task = await foregroundTask(30_000);
    await init();

    AppScheduler.onStoresHydrated();
    await settle(100);
    expect(task.runs).toHaveLength(0);
    await settle(400);

    expect(task.runs).toHaveLength(1);
  });

  it('on a restart boot (marker present) is warm: the 60s floor holds a task that ran 30s ago', async () => {
    const task = await foregroundTask(30_000);
    await bootAfterRestart();
    await init();

    AppScheduler.onStoresHydrated();
    await settle(1_000);

    expect(task.runs).toHaveLength(0);
  });

  it('on a restart boot still runs a task that ran 2 minutes ago', async () => {
    const task = await foregroundTask(120_000);
    await bootAfterRestart();
    await init();

    AppScheduler.onStoresHydrated();
    await settle(1_000);

    expect(task.runs).toHaveLength(1);
  });

  it('is synchronous: it returns undefined, not a Promise', async () => {
    await init();

    expect(AppScheduler.onStoresHydrated()).toBeUndefined();
    // Let the deferred kick finish inside this test rather than leak into the next.
    await settle(1_000);
  });

  it('runs at once while the app is merely inactive (a launch in progress)', async () => {
    const task = await foregroundTask(30_000);
    await init();
    setAppState('inactive');

    AppScheduler.onStoresHydrated();
    await settle(1_000);

    expect(task.runs).toHaveLength(1);
  });

  describe('while the app is in the background (an OS wake)', () => {
    it('runs nothing, and replays the held kick on the first activation with its COLD floor', async () => {
      const task = await foregroundTask(30_000);
      setAppState('background');
      await init();

      AppScheduler.onStoresHydrated();
      await settle(5_000);
      expect(task.runs).toHaveLength(0);

      setAppState('active');
      await settle(500);

      // 30s ago: only the cold 5s floor lets it through (the warm one would hold it).
      expect(task.runs).toHaveLength(1);
    });

    it('replays a held restart boot with the WARM floor', async () => {
      const task = await foregroundTask(30_000);
      await bootAfterRestart();
      setAppState('background');
      await init();

      AppScheduler.onStoresHydrated();
      setAppState('active');
      await settle(1_000);

      expect(task.runs).toHaveLength(0);
    });

    it('does not replay the held kick a second time on a later activation', async () => {
      const task = await foregroundTask(30_000);
      setAppState('background');
      await init();
      AppScheduler.onStoresHydrated();
      setAppState('active');
      await settle(500);
      expect(task.runs).toHaveLength(1);

      // 10s on: past the cold 5s floor, inside the warm 60s one. A kick that was never cleared
      // would still carry the cold floor and run the task again.
      await settle(10_000);
      await backgroundThenForeground();

      expect(task.runs).toHaveLength(1);
    });
  });
});

describe('network reconnect', () => {
  const flap = async () => {
    useNetworkStore.getState().setIsConnected(false);
    useNetworkStore.getState().setIsConnected(true);
    await settle(500);
  };

  async function reconnectTask(agoMs: number | null, extra: Parameters<typeof addTask>[0] = {}) {
    const task = addTask({ frequency: 5 * 60_000, triggers: ['network-reconnect'], ...extra });
    if (agoMs !== null) await persistence.saveLastRun(task.name, T0 - agoMs);
    return task;
  }

  it('runs a network-reconnect task whose last run is at least 60s old', async () => {
    const task = await reconnectTask(120_000);
    await init();

    await flap();

    expect(task.runs).toHaveLength(1);
  });

  it('does not run it when it ran 30s ago (a flapping link is one reconnect, not four)', async () => {
    const task = await reconnectTask(30_000);
    await init();

    await flap();

    expect(task.runs).toHaveLength(0);
  });

  it('does not run it on the link going DOWN', async () => {
    const task = await reconnectTask(120_000);
    await init();

    useNetworkStore.getState().setIsConnected(false);
    await settle(500);

    expect(task.runs).toHaveLength(0);
  });

  it('waits 15s after a failure, then runs on the next reconnect (the tunnel-exit case)', async () => {
    const task = await reconnectTask(null, { maxAttempts: 1, failWith: new Error('offline') });
    // Fires from the tick at init and fails.
    await init();
    await settle(500);
    expect(task.runs).toHaveLength(1);

    await settle(4_500);
    await flap();
    expect(task.runs).toHaveLength(1);

    await settle(15_000);
    await flap();
    expect(task.runs).toHaveLength(2);
  });

  it('keeps a frequency 0 task always due', async () => {
    const task = addTask({ frequency: 0, triggers: ['network-reconnect'] });
    await init();

    await flap();
    await flap();

    expect(task.runs).toHaveLength(2);
  });

  it('skips an exclusive task that is already running, a paused task and a failing condition', async () => {
    const running = await reconnectTask(120_000, { exclusive: true, hang: true });
    const paused = await reconnectTask(120_000);
    const gated = await reconnectTask(120_000, { conditions: [{ type: 'custom', check: () => false }] });
    await init();
    // Start the exclusive task's long run through the manual path.
    void AppScheduler.trigger(running.name);
    await settle(500);
    AppScheduler.pauseTask(paused.name);

    await flap();

    expect(running.runs).toHaveLength(1);
    expect(paused.runs).toHaveLength(0);
    expect(gated.runs).toHaveLength(0);
    running.release();
    await settle(500);
  });

  it('does nothing while the app is backgrounded', async () => {
    const task = await reconnectTask(120_000);
    await init();
    setAppState('background');

    await flap();

    expect(task.runs).toHaveLength(0);
  });
});
