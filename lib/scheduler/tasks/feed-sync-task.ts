import { useUserStore } from '@/lib/stores/user-store';
import { feedSyncMachine } from '../feed-sync/FeedSyncMachine';
import { AppScheduler } from '../AppScheduler';
import { getCurrentPathname } from '@/lib/nav-state';
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
    // Don't sync while the user is gated behind the paywall — a non-subscribed
    // user is pinned to /logged-in/not-subscribed, where every server query
    // would just 402 until they have an active subscription.
    {
      type: 'custom',
      check: () => !getCurrentPathname().includes('not-subscribed'),
    },
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
    logger.info(`[feed-sync-task] handler start — userId=${userStore.userId ?? 'null'} personaId=${personaId ?? 'null'} attempt=${ctx.attempt}`);
    if (!personaId) throw new Error('UserPersona not found');
    await feedSyncMachine.start(personaId, ctx);
  },
});
