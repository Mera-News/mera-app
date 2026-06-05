import { useUserStore } from '@/lib/stores/user-store';
import { feedSyncMachine } from '../feed-sync/FeedSyncMachine';
import { AppScheduler } from '../AppScheduler';

AppScheduler.register({
  name: 'feed-sync',
  displayName: 'Feed Sync',
  frequency: 5 * 60 * 1000,
  triggers: ['app-foreground', 'network-reconnect'],
  conditions: [
    { type: 'network' },
    { type: 'authenticated' },
    { type: 'db-ready' },
  ],
  timeout: 3 * 60 * 1000,
  maxAttempts: 3,
  exclusive: true,
  handler: async (_input, ctx) => {
    const personaId = useUserStore.getState().userPersona?._id;
    if (!personaId) throw new Error('UserPersona not found');
    await feedSyncMachine.start(personaId, ctx);
  },
});
