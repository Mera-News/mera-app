import { useUserStore } from '@/lib/stores/user-store';
import { feedSyncMachine } from '../feed-sync/FeedSyncMachine';
import { AppScheduler } from '../AppScheduler';
import logger from '@/lib/logger';

AppScheduler.register({
  name: 'feed-sync',
  displayName: 'Feed Sync',
  // 5 MINUTES, not 60s. A steady-state run is two uncached round trips
  // (articleIdsForPersona + recentArticleCount) that return nothing new, so at
  // 60s a reader who leaves the app open costs 120 requests an hour to learn
  // nothing. The pipeline itself only produces on the :00/:10/:20/:40 crons, so
  // polling faster than the data changes buys latency that does not exist.
  // Pull-to-refresh, the tab re-tap and every app-open still bypass this.
  frequency: 5 * 60 * 1000,
  triggers: ['app-foreground', 'network-reconnect'],
  conditions: [
    { type: 'network' },
    { type: 'authenticated' },
    { type: 'db-ready' },
    // NO TIER CONDITION HERE, deliberately — read this before adding one back.
    //
    // Every account syncs. An account with no subscription is a Starter
    // account, not a locked one, so there is no tier for which skipping the
    // sync is correct: gating here would leave those users with a permanently
    // empty Dashboard while the server was willing to answer all along.
    //
    // The condition this replaced (`getAiAccess() !== 'locked'`) existed
    // because the four queries sat behind SubscriptionGuard and a locked device
    // fired four 402s a minute forever. Those guards are gone and the queries
    // answer for everyone.
    //
    // "Skip a pointless round trip" and "skip the sync" are NOT the same
    // predicate, which is the trap if you ever reintroduce a gate here. The
    // task's own test asserts the COUNT of custom conditions precisely so a
    // reintroduced tier gate fails rather than shipping green.
    //
    // And enforcement of anything must NOT live in a condition. `trigger()`
    // bypasses `_conditionsMet` entirely, so pull-to-refresh and the tab re-tap
    // run this task with none of its conditions applied — a check placed only
    // here is ungated on the manual path. Put it in the task's steps.
  ],
  timeout: 3 * 60 * 1000,
  maxAttempts: 3,
  exclusive: true,
  handler: async (_input, ctx) => {
    const userStore = useUserStore.getState();
    const personaId = userStore.userPersona?._id;
    logger.debug(`[feed-sync-task] handler start — userId=${userStore.userId ?? 'null'} personaId=${personaId ?? 'null'} attempt=${ctx.attempt}`);
    if (!personaId) throw new Error('UserPersona not found');
    await feedSyncMachine.start(personaId, ctx);
  },
});
