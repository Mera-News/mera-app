import { checkPushTokenRevocation } from '@/lib/notification-service';
import { AppScheduler } from '../AppScheduler';

AppScheduler.register({
  name: 'push-token-check',
  displayName: 'Push Token Check',
  frequency: 60 * 60 * 1000,
  triggers: ['app-foreground'],
  conditions: [{ type: 'authenticated' }],
  timeout: 10_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async () => {
    await checkPushTokenRevocation();
  },
});
