// jwt-subscription-gate.test.ts — the /token 403 must be TERMINAL, and only the
// /token 403.
//
// Measured on staging: an unsubscribed device asked for the Mera-bubble JWT
// every ~5s forever and rate-limited its own /get-session into 429s. The two
// directions this file guards are equally important:
//   • too broad  → a lapsed session (401) never recovers, because we stopped
//                  asking.
//   • too narrow → the storm continues.
//
// The real subscription store is used here (with @/lib/revenuecat mocked, the
// only reason the other suites stub it) because the CLEAR path is the point: it
// has to be driven by the same `setServerBilling` a real entitlement sync calls,
// not by a hand-rolled double.

// Partial module mock: `entitlement-sync` (exercised further down) also calls
// `syncRevenueCatAttributes` on its success path, and an unmocked export in a
// factory mock is `undefined`, not the real function — so it has to be listed
// here even though nothing in this suite asserts on it.
jest.mock('@/lib/revenuecat', () => ({
    getActiveTier: jest.fn(() => null),
    syncRevenueCatAttributes: jest.fn(async () => {}),
}));

const mockRecordAiLocked = jest.fn();
jest.mock('../ai-lock', () => ({ recordAiLocked: (...a: any[]) => mockRecordAiLocked(...a) }));

const mockFetchUserBilling = jest.fn();
const mockFetchUserBillingLapseState = jest.fn(async () => null);
jest.mock('@/lib/billing-service', () => ({
    fetchUserBilling: (...a: any[]) => mockFetchUserBilling(...a),
    fetchUserBillingLapseState: (...a: any[]) => mockFetchUserBillingLapseState(...(a as [])),
}));

import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { resetEntitlementSyncState, syncEntitlement } from '../entitlement-sync';
import {
    _resetJwtSubscriptionGateForTests,
    clearJwtSubscriptionLock,
    isJwtSubscriptionLocked,
    isSubscriptionRequiredAuthError,
    recordJwtSubscriptionLocked,
} from '../jwt-subscription-gate';

beforeEach(() => {
    jest.clearAllMocks();
    _resetJwtSubscriptionGateForTests();
    resetEntitlementSyncState();
    useSubscriptionStore.getState().reset();
    // reset() itself clears the latch — re-arm from a known-clean base.
    _resetJwtSubscriptionGateForTests();
});

describe('isSubscriptionRequiredAuthError', () => {
    // The shape better-fetch actually returns on the non-throwing path: the
    // parsed JSON body spread, with `status`/`statusText` stamped on.
    const observed = {
        code: 'SUBSCRIPTION_REQUIRED',
        message: 'Active subscription required',
        status: 403,
        statusText: 'FORBIDDEN',
    };

    it('matches the shape the auth client actually surfaces', () => {
        expect(isSubscriptionRequiredAuthError(observed)).toBe(true);
    });

    it('matches a thrown BetterFetchError (status outside, body inside `error`)', () => {
        expect(
            isSubscriptionRequiredAuthError({
                status: 403,
                statusText: 'FORBIDDEN',
                error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Active subscription required' },
            }),
        ).toBe(true);
    });

    it('matches a raw better-call APIError (`body.code`)', () => {
        expect(
            isSubscriptionRequiredAuthError({
                statusCode: 403,
                body: { code: 'SUBSCRIPTION_REQUIRED' },
            }),
        ).toBe(true);
    });

    // THE regression guard. An expired session must stay retryable, or a user
    // whose cookie lapsed never gets back in without a reinstall.
    it('does NOT match a generic 401 (expired session)', () => {
        expect(
            isSubscriptionRequiredAuthError({
                code: 'UNAUTHORIZED',
                message: 'Unauthorized',
                status: 401,
            }),
        ).toBe(false);
    });

    it('does NOT match a bare 403 with no code', () => {
        expect(isSubscriptionRequiredAuthError({ status: 403, message: 'Forbidden' })).toBe(false);
    });

    it('does NOT match a 401 that somehow carries the code (status disagrees)', () => {
        expect(
            isSubscriptionRequiredAuthError({ status: 401, code: 'SUBSCRIPTION_REQUIRED' }),
        ).toBe(false);
    });

    it('tolerates a missing status when the code is present', () => {
        expect(isSubscriptionRequiredAuthError({ code: 'SUBSCRIPTION_REQUIRED' })).toBe(true);
    });

    it('is false for nullish / non-object inputs', () => {
        expect(isSubscriptionRequiredAuthError(null)).toBe(false);
        expect(isSubscriptionRequiredAuthError(undefined)).toBe(false);
        expect(isSubscriptionRequiredAuthError('403')).toBe(false);
        expect(isSubscriptionRequiredAuthError(new Error('Forbidden'))).toBe(false);
    });
});

describe('the latch', () => {
    it('records the lock through the EXISTING shared mechanism, not a parallel flag', () => {
        recordJwtSubscriptionLocked();
        expect(isJwtSubscriptionLocked()).toBe(true);
        expect(mockRecordAiLocked).toHaveBeenCalledWith('token');
    });

    it('is idempotent — a second refusal costs nothing', () => {
        recordJwtSubscriptionLocked();
        recordJwtSubscriptionLocked();
        expect(mockRecordAiLocked).toHaveBeenCalledTimes(1);
    });

    it('clears explicitly', () => {
        recordJwtSubscriptionLocked();
        clearJwtSubscriptionLock();
        expect(isJwtSubscriptionLocked()).toBe(false);
    });
});

describe('clearing on a successful entitlement sync', () => {
    const billing = (subscriptionTier: string | null) => ({
        subscriptionTier,
        dailyArticleLimit: 100,
        articlesUsedToday: 0,
        entitlementExpiresAt: null,
        resetAt: null,
    });

    it('lifts the lock when the server reports a paid tier — no app restart', async () => {
        recordJwtSubscriptionLocked();
        expect(isJwtSubscriptionLocked()).toBe(true);

        mockFetchUserBilling.mockResolvedValueOnce(billing('starter'));
        await syncEntitlement({ force: true });

        expect(isJwtSubscriptionLocked()).toBe(false);
    });

    it('leaves the lock in place when the server still says "none"', async () => {
        recordJwtSubscriptionLocked();

        mockFetchUserBilling.mockResolvedValueOnce(billing('none'));
        await syncEntitlement({ force: true });

        expect(isJwtSubscriptionLocked()).toBe(true);
    });

    it('is not lifted by a snapshot that does not select subscriptionTier', () => {
        recordJwtSubscriptionLocked();
        // What the lapse-state query returns: the tier field is simply absent,
        // which means "unknown", never "paid".
        useSubscriptionStore.getState().setServerBilling({ hasEverSubscribed: true });
        expect(isJwtSubscriptionLocked()).toBe(true);
    });

    it('is not lifted by markServerLocked (a 402 is a refusal, not a lift)', () => {
        recordJwtSubscriptionLocked();
        useSubscriptionStore.getState().markServerLocked();
        expect(isJwtSubscriptionLocked()).toBe(true);
    });

    it('is cleared on logout / user switch so user B never inherits it', () => {
        recordJwtSubscriptionLocked();
        useSubscriptionStore.getState().reset();
        expect(isJwtSubscriptionLocked()).toBe(false);
    });
});
