import { evictExpiredApolloCache } from '@/lib/apollo-client';
import { AppScheduler } from '../AppScheduler';

AppScheduler.register({
  name: 'apollo-cache-evict',
  displayName: 'Apollo Cache Eviction',
  frequency: 10 * 60 * 1000,
  triggers: ['app-foreground'],
  conditions: [],
  timeout: 5_000,
  maxAttempts: 1,
  exclusive: false,
  handler: async () => {
    evictExpiredApolloCache();
  },
});
