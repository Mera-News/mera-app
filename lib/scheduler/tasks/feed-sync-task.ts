import { useUserStore } from '@/lib/stores/user-store';
import { feedSyncMachine } from '../feed-sync/FeedSyncMachine';
import { AppScheduler } from '../AppScheduler';
import logger from '@/lib/logger';

AppScheduler.register({
  name: 'feed-sync',
  displayName: 'Feed Sync',
  frequency: 60 * 1000,
  triggers: ['app-foreground', 'network-reconnect'],
  conditions: [
    { type: 'network' },
    { type: 'authenticated' },
    { type: 'db-ready' },
    // NO TIER CONDITION HERE, deliberately — see below before adding one back.
    //
    // This used to be `getAiAccess() !== 'locked'`, because all four queries
    // this task runs sat behind SubscriptionGuard and a locked device would
    // fire four 402s a minute forever. Mera News Free removes that guard: a
    // free device is entitled to a metered daily allowance, so 'locked' now
    // means "free", not "no access", and skipping the sync would leave every
    // free user with a permanently empty Dashboard.
    //
    // REQUIRES THE SERVER HALF. Cap-reached now answers HTTP 200 with
    // `dailyLimitReached: true` instead of throwing 402. If SubscriptionGuard
    // is ever restored on those queries without restoring a condition here,
    // this task goes back to a 402 loop.
    //
    // "Skip a pointless round trip" and "skip the sync" are NOT the same
    // predicate, which is the trap to avoid if you reintroduce a gate. A free
    // user with zero unlocked topics still has work to do: they degrade to
    // headline scopes plus geo inside `stepFetchTopicIds` and get a real feed.
    // A tier condition that blocks them outright would delete that path
    // silently.
    //
    // Enforcement of the free-tier limits is NOT here and must not move here.
    // `trigger()` bypasses `_conditionsMet` entirely, so pull-to-refresh and
    // the tab re-tap run this task with none of its conditions applied —
    // anything gated only here is ungated on the manual path. The topic filter
    // lives in `stepFetchTopicIds`, which is on both paths.
    // `aiAccessForSchedulerCondition()` exists for a future condition that
    // genuinely only saves a round trip; nothing here qualifies today.

    // Don't burn a round trip every 60s once the daily cap has clipped a run:
    // the server will just clip again until the reset. Gating here rather than
    // inside the machine also stops the wasted request, not merely the notice.
    //
    // This gates ONLY the scheduled path. Pull-to-refresh and the tab-icon
    // re-tap both go through `useFeedSyncRefresh` -> `trigger()`, which
    // deliberately bypasses `_conditionsMet` — so a user asking for a refresh
    // still gets a real attempt and can see the cap lift the moment it does.
    //
    // `dailyLimitResetAt` is in-memory only, so after a cold start one sync
    // runs before the cap is re-learned. That is intentional: the persisted
    // `dailyLimitNoticeDay` keeps that run from re-notifying, and re-learning
    // beats persisting a reset time that may have been superseded server-side.
    {
      type: 'custom',
      check: () => {
        // Lazily required, not imported at module scope: `for-you-store` pulls
        // in article-suggestion-service -> the WatermelonDB SQLite adapter,
        // which needs native JSI. Registering a scheduler task must not depend
        // on the database being constructible, or this file cannot be imported
        // outside a running app (it breaks feed-sync-task's own test suite).
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate, see above.
        const { useForYouStore } = require('@/lib/stores/for-you-store') as typeof import('@/lib/stores/for-you-store');
        const resetAt = useForYouStore.getState().dailyLimitResetAt;
        return resetAt === null || Date.now() >= resetAt;
      },
    },
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
