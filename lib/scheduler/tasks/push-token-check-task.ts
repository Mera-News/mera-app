import { checkPushTokenRevocation } from '@/lib/notification-service';
import { AppScheduler } from '../AppScheduler';
import { getCurrentPathname } from '@/lib/nav-state';

AppScheduler.register({
  name: 'push-token-check',
  displayName: 'Push Token Check',
  frequency: 60 * 60 * 1000,
  triggers: ['app-foreground'],
  conditions: [
    { type: 'network' },
    { type: 'authenticated' },
    // Skip while gated behind the paywall (server calls would 402).
    {
      type: 'custom',
      check: () => !getCurrentPathname().includes('not-subscribed'),
    },
  ],
  timeout: 10_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async () => {
    await checkPushTokenRevocation();
  },
});
