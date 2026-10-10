// The feed-sync task's condition list, read from the definition it hands to AppScheduler.register
// (a call-through spy on a fresh scheduler module, so nothing private is read). The behaviour tests
// in machine/task.test.ts cannot see this: a custom condition that always passes is invisible to
// them, so only the COUNT pins "no custom condition at all": no tier gate and no daily-cap gate
// (owner ruling: followed stories keep updating after the cap; the machine drops the metered ids).
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import { useForYouStore } from '@/lib/stores/for-you-store';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
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
    useSubscriptionStore.getState().reset();
  });

  it('has exactly network, authenticated and db-ready, and no custom condition', () => {
    const { conditions = [] } = registeredDefinition();

    expect(conditions.map((c) => c.type).sort()).toEqual(['authenticated', 'db-ready', 'network']);
    expect(conditions).toHaveLength(3);
  });

  // DA42: the cap latch (`dailyLimitResetAt`, written only by FeedSyncMachine) was never cleared, so a
  // reader who paid after hitting the cap stayed held until the reset time. The paid billing arrives
  // the way the app delivers it after a confirmed purchase: `refreshUserBillingAfterPurchase` -> `setServerBilling` (the fields below are the server's
  // `userBilling` shape; the store keeps the tier and drops the counters).
  describe('a paid upgrade after the daily cap', () => {
    test('DA42: a paid upgrade after the cap lifts the hold before the reset time', () => {
      useForYouStore.setState({ dailyLimitResetAt: NOW + 60_000 }); // the cap latched

      const paid = { subscriptionTier: 'professional', dailyArticleLimit: 1000, articlesUsedToday: 250 };
      useSubscriptionStore.getState().setServerBilling(paid);

      expect(useForYouStore.getState().dailyLimitResetAt).toBeNull();
    });

    test('DA42: a Starter billing write keeps the hold, a paid one clears it', () => {
      useForYouStore.setState({ dailyLimitResetAt: NOW + 60_000 });

      useSubscriptionStore.getState().setServerBilling({ subscriptionTier: 'starter' });
      expect(useForYouStore.getState().dailyLimitResetAt).toBe(NOW + 60_000);

      useSubscriptionStore.getState().setServerBilling({ subscriptionTier: 'individual' });
      expect(useForYouStore.getState().dailyLimitResetAt).toBeNull();
    });
  });
});
