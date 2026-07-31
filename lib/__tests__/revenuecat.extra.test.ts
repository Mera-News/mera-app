// Probe helper for the deferred-plan-change investigation — see
// POWER_USER_FOLLOWUPS #12. `react-native-purchases`' CustomerInfo exposes no
// field naming a *future* product, so before any "Professional starts on X"
// notice can ship we need to know what (if anything) the store actually records
// client-side while a deferred change is pending. describeSubscriptions() is
// what gets logged to answer that.

const load = () => require('@/lib/revenuecat');

const sub = (overrides: Record<string, unknown> = {}) => ({
    productIdentifier: 'mera_news_individual_monthly',
    purchaseDate: '2026-07-01T00:00:00Z',
    originalPurchaseDate: '2026-06-01T00:00:00Z',
    expiresDate: '2026-08-01T00:00:00Z',
    store: 'APP_STORE',
    unsubscribeDetectedAt: null,
    isSandbox: false,
    billingIssuesDetectedAt: null,
    gracePeriodExpiresDate: null,
    ownershipType: 'PURCHASED',
    periodType: 'NORMAL',
    refundedAt: null,
    storeTransactionId: 'txn-1',
    isActive: true,
    willRenew: true,
    ...overrides,
});

describe('describeSubscriptions', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('returns an empty list for null/undefined customer info', () => {
        const rc = load();
        expect(rc.describeSubscriptions(null)).toEqual([]);
        expect(rc.describeSubscriptions(undefined)).toEqual([]);
    });

    it('returns an empty list when the customer has no subscriptions', () => {
        const rc = load();
        expect(
            rc.describeSubscriptions({ subscriptionsByProductIdentifier: {} }),
        ).toEqual([]);
    });

    it('flattens every subscription row to the fields that would reveal a pending plan change', () => {
        const rc = load();
        const rows = rc.describeSubscriptions({
            subscriptionsByProductIdentifier: {
                mera_news_individual_monthly: sub(),
                // If the App Store records the deferred Professional purchase at
                // all, it would show up as a second, not-yet-active row.
                mera_news_professional_monthly: sub({
                    productIdentifier: 'mera_news_professional_monthly',
                    isActive: false,
                    willRenew: true,
                    purchaseDate: '2026-08-01T00:00:00Z',
                    expiresDate: null,
                }),
            },
        });

        expect(rows).toEqual([
            {
                productIdentifier: 'mera_news_individual_monthly',
                isActive: true,
                willRenew: true,
                periodType: 'NORMAL',
                store: 'APP_STORE',
                purchaseDate: '2026-07-01T00:00:00Z',
                expiresDate: '2026-08-01T00:00:00Z',
                unsubscribeDetectedAt: null,
            },
            {
                productIdentifier: 'mera_news_professional_monthly',
                isActive: false,
                willRenew: true,
                periodType: 'NORMAL',
                store: 'APP_STORE',
                purchaseDate: '2026-08-01T00:00:00Z',
                expiresDate: null,
                unsubscribeDetectedAt: null,
            },
        ]);
    });

    it('keys each row by the map key, not the nested productIdentifier', () => {
        const rc = load();
        const rows = rc.describeSubscriptions({
            subscriptionsByProductIdentifier: {
                'mera_news_subscriptions:mera-news-individual-monthly': sub(),
            },
        });
        expect(rows[0].productIdentifier).toBe(
            'mera_news_subscriptions:mera-news-individual-monthly',
        );
    });
});
