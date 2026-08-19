/**
 * The free-tier paywall chokepoint honors the S10 email-before-checkout gate:
 * a dismissed sheet means NO paywall (and nothing refreshed); a passed gate
 * proceeds to RevenueCat exactly as before.
 */

const mockEnsureEmail = jest.fn(async () => true);
jest.mock('@/lib/subscription/email-capture', () => ({
    ensureEmailBeforeCheckout: () => mockEnsureEmail(),
}));

const mockPresentPaywall = jest.fn(async (..._a: unknown[]) => 'CANCELLED');
jest.mock('react-native-purchases-ui', () => ({
    __esModule: true,
    default: { presentPaywall: (...a: unknown[]) => mockPresentPaywall(...a) },
    PAYWALL_RESULT: { PURCHASED: 'PURCHASED', RESTORED: 'RESTORED', CANCELLED: 'CANCELLED' },
}));

jest.mock('@/lib/revenuecat', () => ({ getOfferingSafe: jest.fn(async () => null) }));
jest.mock('@/lib/billing-service', () => ({
    refreshUserBillingAfterPurchase: jest.fn(async () => ({ billing: null, confirmed: false })),
}));
jest.mock('@/lib/stores/subscription-store', () => ({
    useSubscriptionStore: { getState: () => ({ serverTier: 'none', setServerBilling: jest.fn() }) },
}));
const mockSyncEntitlement = jest.fn(async (..._a: unknown[]) => {});
jest.mock('@/lib/subscription/entitlement-sync', () => ({
    syncEntitlement: (...a: unknown[]) => mockSyncEntitlement(...a),
}));
jest.mock('@/lib/subscription/activation-toast', () => ({ showSubscriptionActivatedToast: jest.fn() }));
jest.mock('@/lib/subscription/last-known-tier', () => ({ rememberLastKnownTier: jest.fn() }));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
}));

import { presentFreeTierPaywall } from '../present-free-tier-paywall';

beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureEmail.mockResolvedValue(true);
});

it('a dismissed email gate aborts: no paywall, no sync', async () => {
    mockEnsureEmail.mockResolvedValue(false);
    await presentFreeTierPaywall('test');
    expect(mockPresentPaywall).not.toHaveBeenCalled();
    expect(mockSyncEntitlement).not.toHaveBeenCalled();
});

it('a passed gate presents the paywall as before', async () => {
    await presentFreeTierPaywall('test');
    expect(mockEnsureEmail).toHaveBeenCalledTimes(1);
    expect(mockPresentPaywall).toHaveBeenCalledTimes(1);
});
