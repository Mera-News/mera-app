// entitlement-sync.test.ts — the 60s debounce and the `force` bypass.
//
// The module's clock is deliberately unseeded (Date.now() read at call time,
// no injectable clock), so we drive it with jest.spyOn(Date, 'now') rather
// than fake timers — the function `await`s real (queue-microtask) promises,
// and fake timers would only complicate that for no benefit here.
//
// @/lib/stores/subscription-store is mocked rather than used for real: the
// real store imports @/lib/revenuecat, which drags in react-native-purchases.

const mockSetServerBilling = jest.fn();

jest.mock('@/lib/stores/subscription-store', () => ({
    useSubscriptionStore: {
        getState: jest.fn(() => ({
            setServerBilling: mockSetServerBilling,
        })),
    },
}));

const mockFetchUserBilling = jest.fn();
const mockFetchUserBillingLapseState = jest.fn();

jest.mock('@/lib/billing-service', () => ({
    fetchUserBilling: (...a: any[]) => mockFetchUserBilling(...a),
    fetchUserBillingLapseState: (...a: any[]) => mockFetchUserBillingLapseState(...a),
}));

// The device-local tier memory. Mocked rather than exercised for real: it reads
// and writes WatermelonDB, and this suite is about the debounce.
const mockRememberLastKnownTier = jest.fn(async () => {});
jest.mock('@/lib/subscription/last-known-tier', () => ({
    rememberLastKnownTier: (...a: any[]) => mockRememberLastKnownTier(...(a as [])),
}));

import { syncEntitlement, resetEntitlementSyncState } from '../entitlement-sync';

const billing = (subscriptionTier: string) => ({
    subscriptionTier,
    dailyArticleLimit: 100,
    articlesUsedToday: 3,
    entitlementExpiresAt: null,
    resetAt: null,
});

describe('syncEntitlement', () => {
    let nowSpy: jest.SpyInstance;
    let now = 1_000_000;

    beforeEach(() => {
        jest.clearAllMocks();
        resetEntitlementSyncState();
        now = 1_000_000;
        nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
        mockFetchUserBilling.mockResolvedValue(billing('individual'));
        mockFetchUserBillingLapseState.mockResolvedValue(null);
    });

    afterEach(() => {
        nowSpy.mockRestore();
    });

    it('fetches on the very first call (no debounce clock has started yet)', async () => {
        await syncEntitlement();
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(1);
        expect(mockSetServerBilling).toHaveBeenCalledWith(billing('individual'));
    });

    // ── The last-known-tier write (2026-08-06) ───────────────────────────────
    //
    // This is the highest-coverage write site for the device's memory of its own
    // tier — foreground, login, purchase and a 402 all funnel through here — and
    // that memory is what the pre-onboarding entitlement gate falls back on when
    // billing cannot be reached on a cold start.
    it('records the resolved tier on the device', async () => {
        await syncEntitlement();
        expect(mockRememberLastKnownTier).toHaveBeenCalledWith('individual');
    });

    it("records 'none' when the server answers with no tier — that IS a resolution", async () => {
        // Distinguishing this from "never resolved" is the whole point: a
        // never-resolved device is the only one that may fall through to the
        // paywall on an unresolvable verdict.
        mockFetchUserBilling.mockResolvedValue({ ...billing('none'), subscriptionTier: null });
        await syncEntitlement();
        expect(mockRememberLastKnownTier).toHaveBeenCalledWith('none');
    });

    it('records nothing when the fetch failed — a silent server is not a resolution', async () => {
        mockFetchUserBilling.mockResolvedValue(null);
        await syncEntitlement();
        expect(mockRememberLastKnownTier).not.toHaveBeenCalled();
    });

    it('debounces a second call inside the 60s window', async () => {
        await syncEntitlement();
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(1);

        now += 30_000; // still inside the 60s window
        await syncEntitlement();
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(1);
    });

    it('fetches again once the 60s window has elapsed', async () => {
        await syncEntitlement();
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(1);

        now += 60_000; // exactly at the window edge — not "< 60_000" anymore
        await syncEntitlement();
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(2);
    });

    it('`force: true` bypasses the debounce window entirely', async () => {
        await syncEntitlement();
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(1);

        now += 1_000; // well inside the window
        await syncEntitlement({ force: true });
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(2);
    });

    it('a failed fetch (billing resolves null) does not start the debounce clock — the next call still fetches', async () => {
        mockFetchUserBilling.mockResolvedValueOnce(null);
        await syncEntitlement();
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(1);
        expect(mockSetServerBilling).not.toHaveBeenCalled();

        now += 1_000; // well inside what would otherwise be the debounce window
        mockFetchUserBilling.mockResolvedValueOnce(billing('individual'));
        await syncEntitlement();
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(2);
        expect(mockSetServerBilling).toHaveBeenCalledWith(billing('individual'));
    });

    it('concurrent calls without force share the same in-flight fetch', async () => {
        let resolveFetch: (v: any) => void;
        mockFetchUserBilling.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveFetch = resolve;
            }),
        );

        const p1 = syncEntitlement();
        const p2 = syncEntitlement();
        resolveFetch!(billing('professional'));
        await Promise.all([p1, p2]);

        expect(mockFetchUserBilling).toHaveBeenCalledTimes(1);
    });

    it('pushes the lapse-state snapshot separately when present', async () => {
        mockFetchUserBillingLapseState.mockResolvedValueOnce({
            hasEverSubscribed: true,
            showLapseInterstitial: true,
        });
        await syncEntitlement();
        expect(mockSetServerBilling).toHaveBeenCalledWith(billing('individual'));
        expect(mockSetServerBilling).toHaveBeenCalledWith({
            hasEverSubscribed: true,
            showLapseInterstitial: true,
        });
    });

    it('resetEntitlementSyncState() clears the debounce window and in-flight latch', async () => {
        await syncEntitlement();
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(1);

        resetEntitlementSyncState();
        now += 1_000; // inside what would otherwise still be the debounce window
        await syncEntitlement();
        expect(mockFetchUserBilling).toHaveBeenCalledTimes(2);
    });
});

export {};
