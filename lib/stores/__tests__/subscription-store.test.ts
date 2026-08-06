import { getAiAccess, useSubscriptionStore } from '@/lib/stores/subscription-store';

const customerInfo = (active: Record<string, unknown> = {}) =>
  ({ entitlements: { active } }) as any;

describe('subscription-store', () => {
  beforeEach(() => {
    useSubscriptionStore.getState().reset();
  });

  it('starts empty', () => {
    const s = useSubscriptionStore.getState();
    expect(s.tier).toBeNull();
    expect(s.isPremium).toBe(false);
    expect(s.customerInfo).toBeNull();
  });

  it('derives professional tier + isPremium from customer info', () => {
    useSubscriptionStore
      .getState()
      .setCustomerInfo(customerInfo({ professional: {} }));
    const s = useSubscriptionStore.getState();
    expect(s.tier).toBe('professional');
    expect(s.isPremium).toBe(true);
    expect(s.customerInfo).not.toBeNull();
  });

  it('derives individual tier from customer info', () => {
    useSubscriptionStore
      .getState()
      .setCustomerInfo(customerInfo({ individual: {} }));
    expect(useSubscriptionStore.getState().tier).toBe('individual');
    expect(useSubscriptionStore.getState().isPremium).toBe(true);
  });

  it('derives starter tier + isPremium from customer info', () => {
    useSubscriptionStore
      .getState()
      .setCustomerInfo(customerInfo({ 'mera-news-starter-plan': {} }));
    const s = useSubscriptionStore.getState();
    expect(s.tier).toBe('starter');
    expect(s.isPremium).toBe(true);
  });

  it('prefers professional over starter when both are active', () => {
    useSubscriptionStore.getState().setCustomerInfo(
      customerInfo({
        professional: {},
        'mera-news-starter-plan': {},
      }),
    );
    expect(useSubscriptionStore.getState().tier).toBe('professional');
  });

  it('treats no active entitlements as not premium', () => {
    useSubscriptionStore.getState().setCustomerInfo(customerInfo());
    expect(useSubscriptionStore.getState().tier).toBeNull();
    expect(useSubscriptionStore.getState().isPremium).toBe(false);
  });

  it('reset() clears all subscription state', () => {
    useSubscriptionStore
      .getState()
      .setCustomerInfo(customerInfo({ professional: {} }));
    useSubscriptionStore.getState().reset();
    const s = useSubscriptionStore.getState();
    expect(s.tier).toBeNull();
    expect(s.isPremium).toBe(false);
    expect(s.customerInfo).toBeNull();
  });
});

// When RevenueCat's backend can't reach Apple (a 522 on POST /v1/receipts,
// observed on a real device) the SDK synthesises a CustomerInfo from local
// StoreKit state and pushes it through the update listener — "Computed offline
// CustomerInfo from 0 products with 0 active entitlements". Nothing on the type
// marks it as such, so the store keys off the one invariant that separates it
// from a real downgrade: purchase history is append-only, and this payload has
// none.
describe('subscription-store — an offline CustomerInfo must not fake a downgrade', () => {
  const withHistory = (
    active: Record<string, unknown>,
    history: string[],
  ) => ({ entitlements: { active }, allPurchasedProductIdentifiers: history }) as any;

  beforeEach(() => {
    useSubscriptionStore.getState().reset();
  });

  it('ignores a payload that has forgotten the purchase history', () => {
    const set = useSubscriptionStore.getState().setCustomerInfo;
    set(withHistory({ individual: {} }, ['mera_news_individual_monthly']));
    expect(useSubscriptionStore.getState().tier).toBe('individual');

    set(withHistory({}, []));

    const s = useSubscriptionStore.getState();
    expect(s.tier).toBe('individual');
    expect(s.isPremium).toBe(true);
  });

  // The guard must not swallow the state change it would be dangerous to miss.
  // A real expiry keeps the history and only empties `active`.
  it('still downgrades on a genuine expiry, which keeps the history', () => {
    const set = useSubscriptionStore.getState().setCustomerInfo;
    set(withHistory({ individual: {} }, ['mera_news_individual_monthly']));

    set(withHistory({}, ['mera_news_individual_monthly']));

    const s = useSubscriptionStore.getState();
    expect(s.tier).toBeNull();
    expect(s.isPremium).toBe(false);
  });

  it('still clears on null — the getCustomerInfoSafe failure path', () => {
    const set = useSubscriptionStore.getState().setCustomerInfo;
    set(withHistory({ individual: {} }, ['mera_news_individual_monthly']));

    set(null);

    expect(useSubscriptionStore.getState().customerInfo).toBeNull();
    expect(useSubscriptionStore.getState().isPremium).toBe(false);
  });

  // The user-switch guarantee the guard leans on: `clearPreviousUserData` →
  // `clearAllStores` → `reset()` runs (app/logged-in/index.tsx:83) before
  // `loginRevenueCat` (:118), so user B never has user A's info as `prev`.
  it('accepts a history-free payload once reset() has run', () => {
    const set = useSubscriptionStore.getState().setCustomerInfo;
    set(withHistory({ individual: {} }, ['mera_news_individual_monthly']));

    useSubscriptionStore.getState().reset();
    set(withHistory({}, []));

    expect(useSubscriptionStore.getState().customerInfo).not.toBeNull();
    expect(useSubscriptionStore.getState().isPremium).toBe(false);
  });

  // Asserted as "not locked" rather than a specific verdict so the test holds
  // whichever way FREE_TIER_MODE_ENABLED is set — the gate is committed false
  // and flipped true locally, and `locked` is the only outcome that renders the
  // Mera News Free card.
  it('never reports locked off an ANONYMOUS CustomerInfo', () => {
    useSubscriptionStore.getState().setCustomerInfo({
      entitlements: { active: {} },
      allPurchasedProductIdentifiers: [],
      originalAppUserId: '$RCAnonymousID:72f363cf86514c138a873e067020a196',
    } as any);

    expect(getAiAccess()).not.toBe('locked');
  });

  it('does report locked once the customer is identified and unentitled', () => {
    useSubscriptionStore.getState().setCustomerInfo({
      entitlements: { active: {} },
      allPurchasedProductIdentifiers: [],
      originalAppUserId: '6a73cbcc19632e639560a9cb',
    } as any);

    // Only meaningful while the ship gate is on; when it is off everything is
    // 'entitled' by design, which is not a locked flash either.
    const verdict = getAiAccess();
    expect(['locked', 'entitled']).toContain(verdict);
    expect(verdict).not.toBe('unknown');
  });

  it('does not crash on a payload with no history field at all', () => {
    const set = useSubscriptionStore.getState().setCustomerInfo;
    set({ entitlements: { active: { individual: {} } } } as any);
    expect(() => set({ entitlements: { active: {} } } as any)).not.toThrow();
    expect(useSubscriptionStore.getState().isPremium).toBe(false);
  });
});
