import { useUserStore } from '@/lib/stores/user-store';
import { feedSyncMachine } from '../feed-sync/FeedSyncMachine';
import { AppScheduler } from '../AppScheduler';
import { getCurrentPathname } from '@/lib/nav-state';
import logger from '@/lib/logger';

AppScheduler.register({
  name: 'feed-sync',
  displayName: 'Feed Sync',
  frequency: 10 * 1000,
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
