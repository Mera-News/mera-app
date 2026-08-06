import { syncRevenueCatAttributes } from '@/lib/revenuecat';
import { syncEntitlement } from '@/lib/subscription/entitlement-sync';
import { AppScheduler } from '../AppScheduler';

// Keeps the server's entitlement verdict fresh while the app is in use. A
// subscription can lapse, renew, or be restored on another device with nothing
// happening in this process to notice — foreground is the moment that matters,
// since it is when the user is about to look at the result.
//
// Deliberately NOT gated on the paywall route (unlike feed-sync/push-token):
// `userBilling` is one of the queries that stays ungated server-side precisely
// so a locked user can find out they are no longer locked. Skipping it there
// would strand a user who just subscribed on the paywall screen.
AppScheduler.register({
  name: 'entitlement-sync',
  displayName: 'Entitlement Sync',
  frequency: 15 * 60 * 1000,
  triggers: ['app-foreground', 'network-reconnect'],
  conditions: [{ type: 'network' }, { type: 'authenticated' }],
  timeout: 30_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async () => {
    // `syncEntitlement` has its own 60s debounce, so a foreground trigger
    // arriving right after a login/purchase sync is a cheap no-op.
    await syncEntitlement();

    // Also here, not only inside syncEntitlement's success path, precisely
    // BECAUSE of that debounce: a debounced-out sync never reaches its success
    // path, so this foreground seam would otherwise go silent for exactly the
    // values that move mid-session. One set at login is not enough —
    // `app_version` and `ota_update_id` change under the user when an OTA
    // applies, and `onboarding_stage` / `app_language` change while the app is
    // open. Unchanged payloads are skipped inside, so the repeat is free.
    await syncRevenueCatAttributes();
  },
});
