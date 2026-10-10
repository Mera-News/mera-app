// The E2E build's stubbed paywall (lib/e2e/purchases-ui.ts) against the mock backend's scenario:
// the device flow .maestro/dev/manage-subscription-captures.yaml relies on exactly this.
import RevenueCatUI, { PAYWALL_RESULT } from '@/lib/e2e/purchases-ui';
import { fetchUserBilling } from '@/lib/billing-service';
import { advanceUntilDone, setScenario, signInFixtureAccount, useFakeClock } from '@/test/helpers';

const T0 = Date.parse('2026-10-10T09:00:00Z');
const tier = async () => (await advanceUntilDone(fetchUserBilling()))?.subscriptionTier;

beforeEach(async () => {
  await signInFixtureAccount();
  useFakeClock(T0);
});

it('resolves CANCELLED by default and leaves billing alone', async () => {
  await expect(advanceUntilDone(RevenueCatUI.presentPaywall())).resolves.toBe(PAYWALL_RESULT.CANCELLED);
  expect(await tier()).toBe('starter');
});

it('a scripted purchase reports the paid tier only once confirmAfterMs has passed', async () => {
  setScenario({ paywall: { result: 'PURCHASED', upgradeTo: 'individual', confirmAfterMs: 45_000 } });
  await expect(advanceUntilDone(RevenueCatUI.presentPaywall())).resolves.toBe(PAYWALL_RESULT.PURCHASED);
  expect(await tier()).toBe('starter');

  jest.setSystemTime(T0 + 45_000);
  const billing = await advanceUntilDone(fetchUserBilling());
  expect(billing).toMatchObject({ subscriptionTier: 'individual' });
  expect(billing?.entitlementExpiresAt).toEqual(expect.any(String));
});

it('a purchase with no upgrade keeps billing on the scenario tier (the timeout card)', async () => {
  setScenario({ paywall: { result: 'PURCHASED', upgradeTo: null, confirmAfterMs: 0 } });
  await advanceUntilDone(RevenueCatUI.presentPaywall());
  jest.setSystemTime(T0 + 10 * 60_000);
  expect(await tier()).toBe('starter');
});
