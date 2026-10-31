// A plan that RevenueCat reports mid-session (a purchase, an offer code, a grant) lifts the read hold
// without waiting for a foreground or the 00:00 UTC reset. Real subscription store, real entitlement sync,
// real read hold and plan-rise, real Apollo client over MSW, in-memory DB. Faked at the edge: the backend
// scenario (MSW) and the CustomerInfo payload the RevenueCat listener would deliver.
//
// ASSUMPTION (mera-server a960cce9, libs/mera-shared/src/billing/reading-meter.ts:110-120): the server's
// `readingUsed` is measured against the plan the account holds NOW, so once the webhook has landed the
// reading read reports the day as not used up and nothing re-arms the hold.
import { waitFor } from '@testing-library/react-native';
import type { CustomerInfo } from 'react-native-purchases';
import * as billingService from '@/lib/billing-service';
import database from '@/lib/database';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { resetEntitlementSyncState } from '@/lib/subscription/entitlement-sync';
import { resetPlanRiseForTests, STORE_RISE_RESYNC_MS } from '@/lib/subscription/plan-rise';
import { isReadHeld, nextUtcMidnight, resetReadHold, setReadHold } from '@/lib/subscription/read-hold';
import { initI18nEn, setScenario, useFakeClock as fakeClock } from '@/test/helpers';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

const info = (active: string[], user = 'user-1'): CustomerInfo =>
    ({
        entitlements: { active: Object.fromEntries(active.map((id) => [id, {}])) },
        allPurchasedProductIdentifiers: active.map((id) => `${id}_monthly`),
        originalAppUserId: user,
    }) as unknown as CustomerInfo;
const FREE = info([]);
const ANON_FREE = info([], '$RCAnonymousID:abc');
const INDIVIDUAL = info(['individual']);
const PROFESSIONAL = info(['professional']);

let fetchSpy: jest.SpyInstance;

async function settleBackgroundWork() {
    if ('clock' in (setTimeout as unknown as object)) await jest.advanceTimersByTimeAsync(200);
    else await new Promise((r) => setTimeout(r, 25));
    await database.write(async () => {});
}

/** The day used up on Starter, with this process's billing read already seen (lastSeen = starter). */
async function heldOnStarter() {
    setScenario({ tier: 'starter', readingUsed: 1 });
    await setReadHold({ resetAt: nextUtcMidnight(Date.now()), used: 1 });
    await billingService.fetchUserBilling();
    fetchSpy.mockClear();
    expect(isReadHeld()).toBe(true);
}

describe('a RevenueCat tier rise lifts the read hold', () => {
    beforeAll(async () => {
        await initI18nEn();
    });

    beforeEach(() => {
        resetEntitlementSyncState();
        useSubscriptionStore.getState().reset();
        resetReadHold();
        resetPlanRiseForTests();
        fetchSpy = jest.spyOn(billingService, 'fetchUserBilling');
    });

    afterEach(async () => {
        resetPlanRiseForTests();
        await settleBackgroundWork();
        fetchSpy.mockRestore();
    });

    it('a free reader (no tier) who buys Individual: the hold lifts with no foreground', async () => {
        await heldOnStarter();
        useSubscriptionStore.getState().setCustomerInfo(FREE);
        expect(fetchSpy).not.toHaveBeenCalled();

        // The webhook has landed: the server reports Individual and a day not used up (see ASSUMPTION).
        setScenario({ tier: 'individual', readingUsed: 0.2 });
        useSubscriptionStore.getState().setCustomerInfo(INDIVIDUAL);
        await waitFor(() => expect(isReadHeld()).toBe(false));
        expect(fetchSpy).toHaveBeenCalled();
    });

    it('a slow webhook: the first read still sees Starter, the second look at 60s lifts the hold', async () => {
        fakeClock(NOW);
        await heldOnStarter();
        useSubscriptionStore.getState().setCustomerInfo(FREE);
        useSubscriptionStore.getState().setCustomerInfo(PROFESSIONAL);
        await jest.advanceTimersByTimeAsync(1_000);
        expect(isReadHeld()).toBe(true);

        setScenario({ tier: 'professional', readingUsed: 0.05 });
        const before = fetchSpy.mock.calls.length;
        await jest.advanceTimersByTimeAsync(STORE_RISE_RESYNC_MS);
        await waitFor(() => expect(isReadHeld()).toBe(false));
        expect(fetchSpy.mock.calls.length).toBe(before + 1);
    });

    it('the cold start reads nothing extra: the first payload and the anonymous-to-identified step', async () => {
        fakeClock(NOW);
        await heldOnStarter();
        useSubscriptionStore.getState().setCustomerInfo(ANON_FREE);
        useSubscriptionStore.getState().setCustomerInfo(INDIVIDUAL);
        await jest.advanceTimersByTimeAsync(STORE_RISE_RESYNC_MS + 1_000);
        expect(fetchSpy).not.toHaveBeenCalled();

        useSubscriptionStore.getState().reset();
        useSubscriptionStore.getState().setCustomerInfo(INDIVIDUAL);
        await jest.advanceTimersByTimeAsync(STORE_RISE_RESYNC_MS + 1_000);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a same or lower tier reads nothing', async () => {
        fakeClock(NOW);
        await heldOnStarter();
        useSubscriptionStore.getState().setCustomerInfo(PROFESSIONAL);
        await jest.advanceTimersByTimeAsync(STORE_RISE_RESYNC_MS + 1_000);
        fetchSpy.mockClear();
        useSubscriptionStore.getState().setCustomerInfo(PROFESSIONAL);
        useSubscriptionStore.getState().setCustomerInfo(INDIVIDUAL);
        await jest.advanceTimersByTimeAsync(STORE_RISE_RESYNC_MS + 1_000);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('two rises keep ONE second look, and a logout cancels it', async () => {
        fakeClock(NOW);
        await heldOnStarter();
        useSubscriptionStore.getState().setCustomerInfo(FREE);
        useSubscriptionStore.getState().setCustomerInfo(INDIVIDUAL);
        useSubscriptionStore.getState().setCustomerInfo(PROFESSIONAL);
        await jest.advanceTimersByTimeAsync(1_000);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(STORE_RISE_RESYNC_MS);
        expect(fetchSpy).toHaveBeenCalledTimes(3);

        // A fresh account on this device (FREE after PROFESSIONAL alone would be the dropped offline payload).
        useSubscriptionStore.getState().reset();
        useSubscriptionStore.getState().setCustomerInfo(FREE);
        useSubscriptionStore.getState().setCustomerInfo(INDIVIDUAL);
        await jest.advanceTimersByTimeAsync(1_000);
        expect(fetchSpy).toHaveBeenCalledTimes(4);
        useSubscriptionStore.getState().reset();
        await jest.advanceTimersByTimeAsync(STORE_RISE_RESYNC_MS + 1_000);
        expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
});
