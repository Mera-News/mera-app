// The feed-sync task's condition list, read from the definition it hands to AppScheduler.register
// (a call-through spy on a fresh scheduler module, so nothing private is read). The behaviour tests
// in machine/task.test.ts cannot see this: a custom condition that always passes is invisible to
// them, so only the COUNT pins "exactly one custom condition and no tier gate".
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import { useForYouStore } from '@/lib/stores/for-you-store';
import type { TaskDefinition } from '@/lib/scheduler/scheduler-types';
import { useFakeClock } from '@/test/helpers';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

/** Loads the task module against a fresh scheduler and returns the definition it registered. */
function registeredDefinition(): TaskDefinition<unknown> {
  let definition: TaskDefinition<unknown> | undefined;
  jest.isolateModules(() => {
    const { AppScheduler } = require('@/lib/scheduler/AppScheduler') as typeof import('@/lib/scheduler/AppScheduler');
    const register = jest.spyOn(AppScheduler, 'register'); // call-through: the real registration still runs
    require('@/lib/scheduler/tasks/feed-sync-task');
    expect(register).toHaveBeenCalledTimes(1);
    definition = register.mock.calls[0][0] as TaskDefinition<unknown>;
  });
  return definition as TaskDefinition<unknown>;
}

describe('feed-sync task conditions', () => {
  beforeEach(() => {
    useFakeClock(NOW);
    useForYouStore.setState({ dailyLimitResetAt: null });
  });

  it('has exactly network, authenticated, db-ready and ONE custom condition', () => {
    const { conditions = [] } = registeredDefinition();

    expect(conditions.map((c) => c.type).sort()).toEqual(['authenticated', 'custom', 'db-ready', 'network']);
    expect(conditions).toHaveLength(4);
  });

  it('the custom condition holds the sync back until dailyLimitResetAt, and lets it through after', () => {
    const custom = (registeredDefinition().conditions ?? []).filter((c) => c.type === 'custom');
    expect(custom).toHaveLength(1);
    const check = (custom[0] as { check: () => boolean }).check;

    expect(check()).toBe(true); // no cap learned yet
    useForYouStore.setState({ dailyLimitResetAt: NOW + 60_000 });
    expect(check()).toBe(false);
    jest.setSystemTime(NOW + 59_999);
    expect(check()).toBe(false);
    jest.setSystemTime(NOW + 60_000);
    expect(check()).toBe(true);
  });
});
