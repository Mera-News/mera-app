// present-free-tier-paywall.test.ts — the success toast must follow the SERVER,
// not the store.
//
// `PAYWALL_RESULT.PURCHASED` only means Apple took the money; our server learns
// about it via the RevenueCat webhook seconds later. That gap is the whole
// reason `refreshUserBillingAfterPurchase` returns `{ billing, confirmed }` and
// the callers refuse to commit an unconfirmed snapshot. A toast on the Apple
// result would announce a plan while the app still renders the previous one.

const mockPresentPaywall = jest.fn();
jest.mock('react-native-purchases-ui', () => ({
    __esModule: true,
    default: { presentPaywall: (...a: any[]) => mockPresentPaywall(...a) },
    PAYWALL_RESULT: {
        PURCHASED: 'PURCHASED',
        RESTORED: 'RESTORED',
        CANCELLED: 'CANCELLED',
        ERROR: 'ERROR',
        NOT_PRESENTED: 'NOT_PRESENTED',
    },
}));

jest.mock('@/lib/revenuecat', () => ({ getOfferingSafe: jest.fn(async () => null) }));

const mockRefresh = jest.fn();
jest.mock('@/lib/billing-service', () => ({
    refreshUserBillingAfterPurchase: (...a: any[]) => mockRefresh(...a),
}));

const mockSetServerBilling = jest.fn();
jest.mock('@/lib/stores/subscription-store', () => ({
    useSubscriptionStore: {
        getState: jest.fn(() => ({
            serverTier: 'none',
            setServerBilling: mockSetServerBilling,
        })),
    },
}));

const mockSyncEntitlement = jest.fn(async () => {});
jest.mock('@/lib/subscription/entitlement-sync', () => ({
    syncEntitlement: (...a: any[]) => mockSyncEntitlement(...(a as [])),
}));

const mockShowToast = jest.fn();
jest.mock('@/lib/subscription/activation-toast', () => ({
    showSubscriptionActivatedToast: (...a: any[]) => mockShowToast(...a),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
}));

import { presentFreeTierPaywall } from '../present-free-tier-paywall';

const billing = (subscriptionTier: string) => ({
    subscriptionTier,
    dailyArticleLimit: 100,
    articlesUsedToday: 0,
    entitlementExpiresAt: null,
    resetAt: null,
});

beforeEach(() => jest.clearAllMocks());

describe('presentFreeTierPaywall', () => {
    it('toasts on confirmed:true, naming the tier the SERVER reported', async () => {
        mockPresentPaywall.mockResolvedValueOnce('PURCHASED');
        mockRefresh.mockResolvedValueOnce({ billing: billing('starter'), confirmed: true });

        await presentFreeTierPaywall('FreeTierCard');

        expect(mockSetServerBilling).toHaveBeenCalledWith(billing('starter'));
        expect(mockShowToast).toHaveBeenCalledTimes(1);
        expect(mockShowToast).toHaveBeenCalledWith('starter');
    });

    it('does NOT toast on confirmed:false — that snapshot is the PRE-purchase tier', async () => {
        mockPresentPaywall.mockResolvedValueOnce('PURCHASED');
        mockRefresh.mockResolvedValueOnce({ billing: billing('none'), confirmed: false });

        await presentFreeTierPaywall('FreeTierCard');

        expect(mockShowToast).not.toHaveBeenCalled();
        // Still self-heals on the next successful read.
        expect(mockSyncEntitlement).toHaveBeenCalledWith({ force: true });
        expect(mockSetServerBilling).not.toHaveBeenCalled();
    });

    it('does NOT toast when the sheet was dismissed without a purchase', async () => {
        mockPresentPaywall.mockResolvedValueOnce('CANCELLED');

        await presentFreeTierPaywall('FreeTierCard');

        expect(mockShowToast).not.toHaveBeenCalled();
        expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('does NOT toast when presenting throws', async () => {
        mockPresentPaywall.mockRejectedValueOnce(new Error('sheet blew up'));

        await expect(presentFreeTierPaywall('FreeTierCard')).resolves.toBeUndefined();

        expect(mockShowToast).not.toHaveBeenCalled();
    });
});
