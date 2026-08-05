// Mock apollo-client BEFORE imports — the module is side-effectful.
const mockQuery = jest.fn();

jest.mock('@/lib/apollo-client', () => ({
    __esModule: true,
    default: {
        query: (...a: any[]) => mockQuery(...a),
    },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        captureMessage: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import { fetchUserBilling, refreshUserBillingAfterPurchase } from '../billing-service';

const billing = (subscriptionTier: string) => ({
    subscriptionTier,
    dailyArticleLimit: 100,
    articlesUsedToday: 3,
    entitlementExpiresAt: null,
    resetAt: null,
});

const resolvesWith = (tier: string) =>
    mockQuery.mockResolvedValueOnce({ data: { userBilling: billing(tier) } });

/** Flush pending microtasks + advance the fake clock past one poll interval. */
async function tick(ms: number) {
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
}

describe('fetchUserBilling', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the billing row', async () => {
        resolvesWith('individual');
        expect(await fetchUserBilling()).toEqual(billing('individual'));
    });

    it('returns null when the query throws', async () => {
        mockQuery.mockRejectedValueOnce(new Error('offline'));
        expect(await fetchUserBilling()).toBeNull();
    });
});

describe('refreshUserBillingAfterPurchase', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });
    afterEach(() => jest.useRealTimers());

    it('returns on the first attempt when the tier already changed', async () => {
        resolvesWith('professional');
        const promise = refreshUserBillingAfterPurchase('individual', { intervalMs: 10 });
        await tick(0);
        await expect(promise).resolves.toEqual({ billing: billing('professional'), confirmed: true });
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('keeps polling while the webhook has not landed, then returns the new tier', async () => {
        resolvesWith('individual');
        resolvesWith('individual');
        resolvesWith('professional');
        const promise = refreshUserBillingAfterPurchase('individual', {
            attempts: 5,
            intervalMs: 10,
        });
        await tick(10_000);
        await tick(10_000);
        await tick(10_000);
        await expect(promise).resolves.toEqual({ billing: billing('professional'), confirmed: true });
        expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it('gives up after the attempt budget and reports unconfirmed — the deferred-plan-change case, where the tier never changes', async () => {
        for (let i = 0; i < 3; i++) resolvesWith('individual');
        const promise = refreshUserBillingAfterPurchase('individual', {
            attempts: 3,
            intervalMs: 10,
        });
        await tick(10_000);
        await tick(10_000);
        await tick(10_000);
        // Still the OLD tier — and now explicitly flagged as unresolved, so the
        // caller can refuse to commit it instead of silently showing stale data.
        await expect(promise).resolves.toEqual({
            billing: billing('individual'),
            confirmed: false,
        });
        // Bounded: exactly `attempts` fetches, never an unbounded poll.
        expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it('treats a missing tier and "none" as the same starting point', async () => {
        resolvesWith('none');
        resolvesWith('starter');
        const promise = refreshUserBillingAfterPurchase(null, { attempts: 3, intervalMs: 10 });
        await tick(10_000);
        await tick(10_000);
        await expect(promise).resolves.toEqual({ billing: billing('starter'), confirmed: true });
        expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('survives a failing fetch mid-poll and still returns the eventual snapshot', async () => {
        mockQuery.mockRejectedValueOnce(new Error('offline'));
        resolvesWith('professional');
        const promise = refreshUserBillingAfterPurchase('individual', {
            attempts: 3,
            intervalMs: 10,
        });
        await tick(10_000);
        await tick(10_000);
        await expect(promise).resolves.toEqual({ billing: billing('professional'), confirmed: true });
    });

    it('reports unconfirmed with a null snapshot when every attempt fails', async () => {
        for (let i = 0; i < 2; i++) mockQuery.mockRejectedValueOnce(new Error('offline'));
        const promise = refreshUserBillingAfterPurchase('individual', {
            attempts: 2,
            intervalMs: 10,
        });
        await tick(10_000);
        await tick(10_000);
        await expect(promise).resolves.toEqual({ billing: null, confirmed: false });
    });
});
