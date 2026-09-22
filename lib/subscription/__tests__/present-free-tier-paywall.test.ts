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
// The real module reaches `web-browser-utils` lazily, so nothing DB-shaped is
// loaded here — but the hold's release is timer-owned and this suite has no
// business advancing five minutes of clock to observe it. Stubbed so the two
// halves (taken before the email gate, never released by this function) can be
// asserted directly. `lib/subscriptions/__tests__/subscribe-flow.test.ts` owns
// the release semantics against the REAL `activeHolds()`.
const mockReleaseHold = jest.fn();
const mockHoldRestartAcrossPurchase = jest.fn((_label: string) => mockReleaseHold);
jest.mock('@/lib/subscriptions/subscribe-flow', () => ({
    holdRestartAcrossPurchase: (label: string) => mockHoldRestartAcrossPurchase(label),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
}));

import { presentFreeTierPaywall } from '../present-free-tier-paywall';

beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureEmail.mockResolvedValue(true);
    mockPresentPaywall.mockResolvedValue('CANCELLED');
    mockHoldRestartAcrossPurchase.mockReturnValue(mockReleaseHold);
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

// THE MONEY-PATH HOLD. The email gate sends the user to their mail app for a
// code and the hosted paywall hands off to the store's purchase sheet; every
// true background -> foreground return restarts the app, and a restart on
// either return destroys the completion path. The hold is asserted on the
// EARLY-RETURN path specifically, because that is the one a `finally`-owned
// release would get wrong and the one that looks safe to skip.
describe('the restart hold', () => {
    it('is taken before the email gate, not just before the sheet', async () => {
        await presentFreeTierPaywall('test');
        expect(mockHoldRestartAcrossPurchase).toHaveBeenCalledWith('purchase');
        expect(mockHoldRestartAcrossPurchase.mock.invocationCallOrder[0]).toBeLessThan(
            mockEnsureEmail.mock.invocationCallOrder[0],
        );
    });

    it('is still held when a dismissed email gate aborts checkout', async () => {
        mockEnsureEmail.mockResolvedValue(false);
        await presentFreeTierPaywall('test');
        expect(mockHoldRestartAcrossPurchase).toHaveBeenCalledTimes(1);
        // Timer-owned, never released by this function on any path. Releasing
        // here would release on the very return the mail-app trip produced.
        expect(mockReleaseHold).not.toHaveBeenCalled();
    });

    it('is not released after a confirmed purchase either', async () => {
        mockPresentPaywall.mockResolvedValue('PURCHASED');
        await presentFreeTierPaywall('test');
        // `refreshUserBillingAfterPurchase` is still retrying when this
        // resolves; a `finally` here would release inside that window.
        expect(mockReleaseHold).not.toHaveBeenCalled();
    });

    it('is not released when the paywall throws', async () => {
        mockPresentPaywall.mockRejectedValue(new Error('sheet failed'));
        await expect(presentFreeTierPaywall('test')).resolves.toBeUndefined();
        expect(mockReleaseHold).not.toHaveBeenCalled();
    });
});
