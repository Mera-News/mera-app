import { useSubscriptionStore } from '@/lib/stores/subscription-store';

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
