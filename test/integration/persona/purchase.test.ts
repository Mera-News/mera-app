// The PRIMARY purchase route (You > Settings > Manage plan > View Plans) through `useManageSubscription`,
// and the shared free-tier paywall chokepoint (`presentFreeTierPaywall`). Real stores, Apollo over MSW,
// in-memory DB, real app-restart holds, real email-before-checkout gate, real toast queue. Mocked: the
// RevenueCat paywall SDK (an edge), driven per test.
import RevenueCatUI from 'react-native-purchases-ui';
import { act, configure, renderHook, waitFor } from '@testing-library/react-native';
import { useManageSubscription } from '@/components/custom/config-mera/useManageSubscription';
import { __resetAppRestartForTests, activeHolds } from '@/lib/app-restart';
import database from '@/lib/database';
import { getSetting } from '@/lib/database/services/setting-service';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import {
    __resetEmailCaptureForTests,
    completeEmailCapture,
    EMAIL_CAPTURE_SKIPPED_SETTING_KEY,
    subscribeEmailCapture,
} from '@/lib/subscription/email-capture';
import { resetEntitlementSyncState } from '@/lib/subscription/entitlement-sync';
import { readLastKnownTier } from '@/lib/subscription/last-known-tier';
import { presentFreeTierPaywall } from '@/lib/subscription/present-free-tier-paywall';
import { PURCHASE_HOLD_AFTER_RETURN_MS, PURCHASE_HOLD_CEILING_MS } from '@/lib/subscriptions/subscribe-flow';
import { toastManager } from '@/lib/toast-manager';
import { resetToastQueue, toastApi, useToastQueue } from '@/lib/toast/toast-queue';
import { seedFacts } from '@/test/integration/chat/_helpers';
import {
    advanceUntilDone,
    graphql,
    http,
    HttpResponse,
    initI18nEn,
    server,
    setAppState,
    setScenario,
    useFakeClock as fakeClock,
} from '@/test/helpers';

// MSW answers on real I/O while the fake clock ticks, so the default one-second wait is too tight.
configure({ asyncUtilTimeout: 20_000 });

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const FEED = '/logged-in/app_container/feed';

const presentPaywall = RevenueCatUI.presentPaywall as unknown as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const router = require('expo-router').router as { replace: jest.Mock };

const billing = (subscriptionTier: string) => ({
    __typename: 'UserBillingInfo',
    subscriptionTier,
    dailyArticleLimit: 250,
    articlesUsedToday: 0,
    entitlementExpiresAt: null,
    resetAt: null,
    grantExpiresAt: null,
});

/** GetUserBilling answers one entry per call (the last repeats). The mount load is call 1. */
function scriptBilling(steps: string[]): () => number {
    let calls = 0;
    server.use(
        graphql.query('GetUserBilling', () =>
            HttpResponse.json({ data: { userBilling: billing(steps[Math.min(calls++, steps.length - 1)]) } }),
        ),
    );
    return () => calls;
}

/** The account's session as the auth client reads it: this is what decides whether the email gate raises. */
function sessionEmail(email: string, isAnonymous = false) {
    server.use(
        http.get('*/api/auth/get-session', () =>
            HttpResponse.json({
                session: { id: 's1', userId: 'u1', token: 't', expiresAt: '2030-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                user: { id: 'u1', email, isAnonymous, emailVerified: true, name: 'x', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            }),
        ),
    );
}
const anonymousAccount = () => sessionEmail('x@anon.mera.news', true);

/** Raises of the email sheet, in order. Subscribing is what stands in for the mounted EmailCaptureHost. */
function mountEmailHost(): string[] {
    const seen: string[] = [];
    subscribeEmailCapture((source) => seen.push(source));
    return seen;
}

/** Polls on the (auto-advancing) clock until the condition holds. */
async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
    for (let t = 0; t < ms && !(await cond()); t += 10) await new Promise((r) => setTimeout(r, 10));
    if (!(await cond())) throw new Error('until: condition not met');
}

/** GetUserBilling requests the app sends from now on. */
const stops: (() => void)[] = [];
function countBillingReads(): () => number {
    let n = 0;
    const listener = ({ request }: { request: Request }) => {
        if (!request.url.endsWith('/graphql')) return;
        void request
            .clone()
            .json()
            .then((b: { operationName?: string }) => {
                if (b.operationName === 'GetUserBilling') n += 1;
            });
    };
    server.events.on('request:start', listener);
    stops.push(() => server.events.removeListener('request:start', listener));
    return () => n;
}

/** The text of the toasts queued: their plain RN Text children. */
const textOf = (node: unknown): string[] => {
    if (node == null || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(textOf);
    return textOf((node as { props?: { children?: unknown } }).props?.children);
};
const toastTitles = () => useToastQueue.getState().entries.map((e) => textOf(e.render({ id: e.id }))[0]);

/** Mounts the hook and waits for its first load. The clock is faked first: holds arm timers. */
async function mountSettled() {
    fakeClock(NOW);
    const hook = renderHook(() => useManageSubscription());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
}

/** Runs `handleViewPlans` to completion on the fake clock. */
async function viewPlans(hook: Awaited<ReturnType<typeof mountSettled>>) {
    await act(async () => {
        await advanceUntilDone(hook.result.current.handleViewPlans());
    });
}

/** Moves the fake clock on until the condition holds (the late poll runs detached). */
async function advanceWhile(cond: () => boolean, maxMs = 200_000) {
    for (let t = 0; t < maxMs && cond(); t += 500) {
        await act(async () => {
            await jest.advanceTimersByTimeAsync(500);
        });
    }
}

/**
 * Lets background work land before the test ends. Settings writes are fired without awaiting, and a write
 * started under the fake clock needs the fake clock to finish: if the clock is restored first, the write never
 * completes and the next test's DB reset waits on it forever. This must run BEFORE the setup's own afterEach
 * (which restores real timers), which is why every test sits inside a describe: a nested afterEach runs first.
 */
async function settleBackgroundWork() {
    if ('clock' in (setTimeout as unknown as object)) await jest.advanceTimersByTimeAsync(200);
    else await new Promise((r) => setTimeout(r, 25));
    await database.write(async () => {});
}

describe('purchase', () => {
    beforeAll(async () => {
        await initI18nEn();
        toastManager.setToastInstance(toastApi);
    });

    beforeEach(() => {
        stops.splice(0).forEach((stop) => stop());
        __resetAppRestartForTests();
        __resetEmailCaptureForTests();
        resetEntitlementSyncState();
        useSubscriptionStore.getState().reset();
        resetToastQueue();
        setAppState('active');
        presentPaywall.mockResolvedValue('CANCELLED');
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await settleBackgroundWork();
    });

    // ---------------------------------------------------------------------------------------------
    describe('the restart hold', () => {
        it('is taken BEFORE the email gate resolves, and is not released when handleViewPlans returns', async () => {
            anonymousAccount();
            const raised = mountEmailHost();
            const hook = await mountSettled();

            const flow = hook.result.current.handleViewPlans();
            await until(() => raised.length > 0);
            // The gate is pending (the capture request is up) and the hold is already in place.
            expect(raised).toEqual(['checkout']);
            expect(activeHolds()).toEqual(['purchase']);
            expect(presentPaywall).not.toHaveBeenCalled();

            completeEmailCapture('verified');
            await act(async () => {
                await advanceUntilDone(flow);
            });

            expect(presentPaywall).toHaveBeenCalledTimes(1);
            // Timer-owned: nothing in the flow released it, on any path.
            expect(activeHolds()).toEqual(['purchase']);
        });

        it('is still held when a dismissed email gate aborts checkout', async () => {
            anonymousAccount();
            const raised = mountEmailHost();
            const hook = await mountSettled();

            const flow = hook.result.current.handleViewPlans();
            await until(() => raised.length > 0);
            completeEmailCapture('dismissed');
            await act(async () => {
                await advanceUntilDone(flow);
            });

            expect(presentPaywall).not.toHaveBeenCalled();
            expect(activeHolds()).toEqual(['purchase']);
        });

        it('is released 20s after a true return from background, not before', async () => {
            const hook = await mountSettled();
            await viewPlans(hook);
            expect(activeHolds()).toEqual(['purchase']);

            setAppState('background');
            setAppState('active');
            await jest.advanceTimersByTimeAsync(PURCHASE_HOLD_AFTER_RETURN_MS - 2_000);
            expect(activeHolds()).toEqual(['purchase']);

            await jest.advanceTimersByTimeAsync(4_000);
            expect(activeHolds()).toEqual([]);
        });

        it('a second trip out re-arms the window', async () => {
            const hook = await mountSettled();
            await viewPlans(hook);

            setAppState('background');
            setAppState('active');
            await jest.advanceTimersByTimeAsync(PURCHASE_HOLD_AFTER_RETURN_MS - 5_000);
            setAppState('background');
            setAppState('active');
            await jest.advanceTimersByTimeAsync(PURCHASE_HOLD_AFTER_RETURN_MS - 5_000);
            expect(activeHolds()).toEqual(['purchase']);

            await jest.advanceTimersByTimeAsync(10_000);
            expect(activeHolds()).toEqual([]);
        });

        it('an `inactive` blip is not a return', async () => {
            const hook = await mountSettled();
            await viewPlans(hook);

            setAppState('inactive');
            setAppState('active');
            await jest.advanceTimersByTimeAsync(PURCHASE_HOLD_AFTER_RETURN_MS + 5_000);
            expect(activeHolds()).toEqual(['purchase']);
        });

        it('with no return at all the five-minute ceiling releases it (iOS presents the sheet in-process)', async () => {
            const hook = await mountSettled();
            await viewPlans(hook);

            await jest.advanceTimersByTimeAsync(PURCHASE_HOLD_CEILING_MS - 5_000);
            expect(activeHolds()).toEqual(['purchase']);

            await jest.advanceTimersByTimeAsync(10_000);
            expect(activeHolds()).toEqual([]);
        });

        it('repeated checkouts leave one hold each, and the ceiling clears them all', async () => {
            const hook = await mountSettled();
            await viewPlans(hook);
            await viewPlans(hook);
            await viewPlans(hook);
            expect(activeHolds()).toEqual(['purchase', 'purchase', 'purchase']);

            await jest.advanceTimersByTimeAsync(PURCHASE_HOLD_CEILING_MS + 5_000);
            expect(activeHolds()).toEqual([]);
        });

        it('presentFreeTierPaywall takes it ahead of the gate too, and keeps it on a dismissed gate and a throwing sheet', async () => {
            fakeClock(NOW);
            anonymousAccount();
            const raised = mountEmailHost();

            const flow = presentFreeTierPaywall('test');
            await until(() => raised.length > 0);
            expect(activeHolds()).toEqual(['purchase']);
            completeEmailCapture('dismissed');
            await advanceUntilDone(flow);
            expect(presentPaywall).not.toHaveBeenCalled();
            expect(activeHolds()).toEqual(['purchase']);

            __resetEmailCaptureForTests();
            presentPaywall.mockRejectedValueOnce(new Error('sheet failed'));
            await advanceUntilDone(presentFreeTierPaywall('test'));
            expect(activeHolds()).toEqual(['purchase', 'purchase']);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('email before checkout', () => {
        it('an anonymous account raises a checkout capture request; a dismissed sheet never presents the paywall', async () => {
            anonymousAccount();
            const raised = mountEmailHost();
            const hook = await mountSettled();

            const flow = hook.result.current.handleViewPlans();
            await until(() => raised.length > 0);
            expect(raised).toEqual(['checkout']);
            completeEmailCapture('dismissed');
            await act(async () => {
                await advanceUntilDone(flow);
            });

            expect(presentPaywall).not.toHaveBeenCalled();
        });

        it('a skip presents the paywall and writes the email_capture_skipped row', async () => {
            anonymousAccount();
            const raised = mountEmailHost();
            const hook = await mountSettled();

            const flow = hook.result.current.handleViewPlans();
            await until(() => raised.length > 0);
            completeEmailCapture('skipped');
            await act(async () => {
                await advanceUntilDone(flow);
            });

            expect(presentPaywall).toHaveBeenCalledTimes(1);
            await until(async () => (await getSetting(EMAIL_CAPTURE_SKIPPED_SETTING_KEY)) === '1');
        });

        it('a verified email presents the paywall', async () => {
            anonymousAccount();
            const raised = mountEmailHost();
            const hook = await mountSettled();

            const flow = hook.result.current.handleViewPlans();
            await until(() => raised.length > 0);
            completeEmailCapture('verified');
            await act(async () => {
                await advanceUntilDone(flow);
            });

            expect(presentPaywall).toHaveBeenCalledTimes(1);
            await expect(getSetting(EMAIL_CAPTURE_SKIPPED_SETTING_KEY)).resolves.toBeNull();
        });

        it('an account with a real email goes straight to the paywall, no sheet', async () => {
            sessionEmail('real@example.com');
            const raised = mountEmailHost();
            const hook = await mountSettled();

            await viewPlans(hook);

            expect(raised).toEqual([]);
            expect(presentPaywall).toHaveBeenCalledTimes(1);
        });

        it('presentFreeTierPaywall honours the same gate: dismissed means no paywall and no sync', async () => {
            fakeClock(NOW);
            anonymousAccount();
            const raised = mountEmailHost();
            const reads = countBillingReads();

            const flow = presentFreeTierPaywall('test');
            await until(() => raised.length > 0);
            completeEmailCapture('dismissed');
            await advanceUntilDone(flow);
            await jest.advanceTimersByTimeAsync(200);

            expect(presentPaywall).not.toHaveBeenCalled();
            expect(reads()).toBe(0);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('useManageSubscription: the paywall', () => {
        it('presents the paywall with a close button (browsing from settings is dismissible)', async () => {
            const hook = await mountSettled();
            await viewPlans(hook);
            expect(presentPaywall).toHaveBeenCalledWith({ displayCloseButton: true });
        });

        it('cancelled: nothing is re-read, nothing is navigated', async () => {
            const reads = countBillingReads();
            const hook = await mountSettled();
            await until(() => reads() === 1);

            await viewPlans(hook);
            await jest.advanceTimersByTimeAsync(200);

            expect(reads()).toBe(1);
            expect(router.replace).not.toHaveBeenCalled();
        });

        it('a purchase that the server confirms (starter -> individual on the 3rd read) updates the hook and the store', async () => {
            const reads = scriptBilling(['starter', 'starter', 'individual']);
            presentPaywall.mockResolvedValueOnce('PURCHASED');
            const hook = await mountSettled();
            expect(hook.result.current.billing?.subscriptionTier).toBe('starter');

            await viewPlans(hook);

            expect(reads()).toBe(3);
            expect(hook.result.current.billing?.subscriptionTier).toBe('individual');
            expect(useSubscriptionStore.getState().serverTier).toBe('individual');
            expect(hook.result.current.activationPending).toBe(false);
            // The activation toast announces none -> paid only; from starter there is nothing to announce.
            expect(toastTitles()).toEqual([]);
        });

        it('a purchase from "none" announces the new plan', async () => {
            setScenario({ tier: 'none' });
            scriptBilling(['none', 'none', 'individual']);
            presentPaywall.mockResolvedValueOnce('PURCHASED');
            const hook = await mountSettled();

            await viewPlans(hook);

            expect(hook.result.current.billing?.subscriptionTier).toBe('individual');
            expect(toastTitles()).toEqual(['Individual is active']);
        });

        it('a restore is handled like a purchase', async () => {
            const reads = scriptBilling(['starter', 'professional']);
            presentPaywall.mockResolvedValueOnce('RESTORED');
            const hook = await mountSettled();

            await viewPlans(hook);

            expect(reads()).toBe(2);
            expect(hook.result.current.billing?.subscriptionTier).toBe('professional');
        });

        it('unconfirmed: "activating" shows, the old tier stays committed, and the late poll (20 x 5s) clears the notice', async () => {
            const reads = scriptBilling(['starter']);
            presentPaywall.mockResolvedValueOnce('PURCHASED');
            const hook = await mountSettled();

            await viewPlans(hook);

            // The first poll gave up (mount + 8 attempts); the notice is up and nothing new was committed.
            // mount + 8 attempts; the late poll's first read may already be on the wire.
            expect(reads()).toBeGreaterThanOrEqual(9);
            expect(reads()).toBeLessThanOrEqual(10);
            expect(hook.result.current.activationPending).toBe(true);
            expect(hook.result.current.billing?.subscriptionTier).toBe('starter');
            expect(useSubscriptionStore.getState().serverTier).toBe('starter');

            await advanceWhile(() => hook.result.current.activationPending);

            expect(hook.result.current.activationPending).toBe(false);
            // The late poll is 20 attempts, 5s apart.
            expect(reads()).toBe(9 + 20);
            expect(useSubscriptionStore.getState().serverTier).toBe('starter');
            expect(toastTitles()).toEqual([]);
            expect(router.replace).not.toHaveBeenCalled();
        });

        it('unconfirmed, then the late poll sees the new tier: committed, announced, notice cleared', async () => {
            setScenario({ tier: 'none' });
            // mount + 8 first-poll reads + 2 late reads on "none", then the webhook lands.
            scriptBilling(['none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'individual']);
            presentPaywall.mockResolvedValueOnce('PURCHASED');
            const hook = await mountSettled();

            await viewPlans(hook);
            expect(hook.result.current.activationPending).toBe(true);
            expect(hook.result.current.billing?.subscriptionTier).toBe('none');

            await advanceWhile(() => hook.result.current.activationPending);

            expect(hook.result.current.billing?.subscriptionTier).toBe('individual');
            expect(useSubscriptionStore.getState().serverTier).toBe('individual');
            expect(toastTitles()).toEqual(['Individual is active']);
        });

        it('a throwing paywall is swallowed: no crash, nothing re-read', async () => {
            const reads = countBillingReads();
            presentPaywall.mockRejectedValueOnce(new Error('sheet failed'));
            const hook = await mountSettled();
            await until(() => reads() === 1);

            await expect(
                act(async () => {
                    await advanceUntilDone(hook.result.current.handleViewPlans());
                }),
            ).resolves.toBeUndefined();
            expect(reads()).toBe(1);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('presentFreeTierPaywall', () => {
        it('presents the paywall with a close button when the gate passes', async () => {
            fakeClock(NOW);
            await advanceUntilDone(presentFreeTierPaywall('test'));
            expect(presentPaywall).toHaveBeenCalledWith({ displayCloseButton: true });
        });

        it('cancelled: a FORCED entitlement sync goes out, the store takes the answer, and nothing is navigated', async () => {
            fakeClock(NOW);
            setScenario({ tier: 'individual' });
            const reads = countBillingReads();

            await advanceUntilDone(presentFreeTierPaywall('test'));
            await until(() => reads() === 1);

            expect(useSubscriptionStore.getState().serverTier).toBe('individual');
            expect(router.replace).not.toHaveBeenCalled();
            // Forced: a second dismissal inside the 60s debounce still reads.
            await advanceUntilDone(presentFreeTierPaywall('test'));
            await until(() => reads() === 2);
        });

        it('a confirmed purchase commits the tier, remembers it on the device and announces it', async () => {
            fakeClock(NOW);
            useSubscriptionStore.getState().setServerBilling({ subscriptionTier: 'none' });
            scriptBilling(['individual']);
            presentPaywall.mockResolvedValueOnce('PURCHASED');

            await advanceUntilDone(presentFreeTierPaywall('test'));

            expect(useSubscriptionStore.getState().serverTier).toBe('individual');
            await until(async () => (await readLastKnownTier()) === 'individual');
            expect(toastTitles()).toEqual(['Individual is active']);
        });

        it('an unconfirmed purchase commits nothing and announces nothing, then a forced sync follows', async () => {
            fakeClock(NOW);
            useSubscriptionStore.getState().setServerBilling({ subscriptionTier: 'none' });
            setScenario({ tier: 'none' });
            const reads = countBillingReads();
            presentPaywall.mockResolvedValueOnce('PURCHASED');

            await advanceUntilDone(presentFreeTierPaywall('test'));
            await jest.advanceTimersByTimeAsync(500);

            // 8 poll attempts, then the forced sync.
            await until(() => reads() === 9);
            expect(useSubscriptionStore.getState().serverTier).toBe('none');
            expect(toastTitles()).toEqual([]);
            expect(router.replace).not.toHaveBeenCalled();
        });

        it('a throwing paywall is swallowed and refreshes nothing', async () => {
            fakeClock(NOW);
            const reads = countBillingReads();
            presentPaywall.mockRejectedValueOnce(new Error('sheet failed'));

            await expect(advanceUntilDone(presentFreeTierPaywall('test'))).resolves.toBeUndefined();
            await jest.advanceTimersByTimeAsync(200);

            expect(reads()).toBe(0);
        });
    });

    // ---------------------------------------------------------------------------------------------
    // PE6 (owner ruling): after a purchase the app stays on Manage subscription. The purchase starts a billing
    // poll and the hook reports it, `purchaseStatus`: 'confirming' (an indeterminate loader) until billing
    // confirms the entitlement ('confirmed'), or 'timed-out' when the poll budget runs out (the page then asks
    // the user to contact support if they paid). Nothing navigates: not the purchase, not a late poll.
    // Each test.failing below pins one part of that; its "today" sibling pins what happens now. P3 flips them.
    describe('PE6 after a purchase', () => {
        type Status = 'idle' | 'confirming' | 'confirmed' | 'timed-out' | undefined;
        const statusOf = (hook: Awaited<ReturnType<typeof mountSettled>>): Status =>
            (hook.result.current as { purchaseStatus?: Status }).purchaseStatus;

        /** Mounts, buys, and runs the purchase to the end of its first poll. `steps` scripts GetUserBilling. */
        const purchase = async (steps: string[]) => {
            scriptBilling(steps);
            presentPaywall.mockResolvedValueOnce('PURCHASED');
            const hook = await mountSettled();
            await viewPlans(hook);
            return hook;
        };
        /** Gives any navigation the purchase would trigger time to land (it is fired, not awaited). */
        const settle = () =>
            act(async () => {
                await jest.advanceTimersByTimeAsync(1000);
            });

        test.failing('PE6 a confirmed purchase stays on Manage subscription (account with facts)', async () => {
            await seedFacts(['Follows Formula 1']);
            await purchase(['starter', 'individual']);
            await settle();
            expect(router.replace).not.toHaveBeenCalled();
        });

        test('PE6 today: a confirmed purchase replaces the route with the Feed when the account has facts', async () => {
            await seedFacts(['Follows Formula 1']);
            await purchase(['starter', 'individual']);
            await until(() => router.replace.mock.calls.length > 0);
            expect(router.replace).toHaveBeenCalledTimes(1);
            expect(router.replace).toHaveBeenCalledWith(FEED);
        });

        test.failing('PE6 a confirmed purchase stays on Manage subscription (account without facts)', async () => {
            await purchase(['starter', 'individual']);
            await settle();
            expect(router.replace).not.toHaveBeenCalled();
        });

        test('PE6 today: with no facts the purchase replaces the route with /logged-in (the gate sends it to onboarding)', async () => {
            await purchase(['starter', 'individual']);
            await until(() => router.replace.mock.calls.length > 0);
            expect(router.replace).toHaveBeenCalledTimes(1);
            expect(router.replace).toHaveBeenCalledWith('/logged-in');
        });

        // mount + 8 first-poll reads + the late poll's first read on "starter"; the webhook lands on its second.
        const lateConfirmation = () => Array<string>(10).fill('starter').concat('individual');

        test.failing('PE6 a purchase confirmed only by the late poll stays on Manage subscription', async () => {
            await seedFacts(['Follows Formula 1']);
            const hook = await purchase(lateConfirmation());
            await advanceWhile(() => hook.result.current.billing?.subscriptionTier !== 'individual');
            await settle();
            expect(hook.result.current.billing?.subscriptionTier).toBe('individual');
            expect(router.replace).not.toHaveBeenCalled();
        });

        test('PE6 today: a purchase confirmed only by the late poll navigates too', async () => {
            await seedFacts(['Follows Formula 1']);
            const hook = await purchase(lateConfirmation());
            expect(router.replace).not.toHaveBeenCalled();
            await advanceWhile(() => hook.result.current.activationPending);
            expect(router.replace).toHaveBeenCalledWith(FEED);
        });

        test.failing('PE6 presentFreeTierPaywall leaves the user where they are after a confirmed purchase', async () => {
            fakeClock(NOW);
            await seedFacts(['Follows Formula 1']);
            useSubscriptionStore.getState().setServerBilling({ subscriptionTier: 'none' });
            scriptBilling(['individual']);
            presentPaywall.mockResolvedValueOnce('PURCHASED');

            await advanceUntilDone(presentFreeTierPaywall('test'));
            await settle();

            expect(useSubscriptionStore.getState().serverTier).toBe('individual');
            expect(router.replace).not.toHaveBeenCalled();
        });

        test('PE6 today: presentFreeTierPaywall navigates on a confirmed purchase as well', async () => {
            fakeClock(NOW);
            await seedFacts(['Follows Formula 1']);
            useSubscriptionStore.getState().setServerBilling({ subscriptionTier: 'none' });
            scriptBilling(['individual']);
            presentPaywall.mockResolvedValueOnce('PURCHASED');

            await advanceUntilDone(presentFreeTierPaywall('test'));
            await until(() => router.replace.mock.calls.length > 0);

            expect(router.replace).toHaveBeenCalledWith(FEED);
        });

        /** Starts a purchase WITHOUT waiting for its poll, so the state during the poll can be read. */
        const startPurchase = async (steps: string[]) => {
            scriptBilling(steps);
            presentPaywall.mockResolvedValueOnce('PURCHASED');
            const hook = await mountSettled();
            let done: Promise<void> = Promise.resolve();
            act(() => {
                done = hook.result.current.handleViewPlans();
            });
            return { hook, done };
        };
        // mount, then three "starter" poll reads before the webhook lands: the poll runs for a few seconds.
        const confirmsOnFourthRead = ['starter', 'starter', 'starter', 'individual'];

        test.failing('PE6 the hook reports confirming while billing is polled, then confirmed', async () => {
            const { hook, done } = await startPurchase(confirmsOnFourthRead);
            // Half a second in, the first poll is still waiting on the webhook: the loader is up.
            await act(async () => {
                await jest.advanceTimersByTimeAsync(500);
            });
            expect(statusOf(hook)).toBe('confirming');
            await act(async () => {
                await advanceUntilDone(done);
            });
            await advanceWhile(() => statusOf(hook) !== 'confirmed', 10_000);
            expect(statusOf(hook)).toBe('confirmed');
            expect(hook.result.current.billing?.subscriptionTier).toBe('individual');
        });

        test('PE6 today: the hook exposes no purchase status; activationPending stays false through the first poll', async () => {
            const { hook, done } = await startPurchase(confirmsOnFourthRead);
            await act(async () => {
                await jest.advanceTimersByTimeAsync(500);
            });
            expect(statusOf(hook)).toBeUndefined();
            expect(hook.result.current.activationPending).toBe(false);
            await act(async () => {
                await advanceUntilDone(done);
            });
            expect(statusOf(hook)).toBeUndefined();
            expect(hook.result.current.billing?.subscriptionTier).toBe('individual');
        });

        test.failing('PE6 when billing never confirms, the hook ends in timed-out (the page asks the user to contact support)', async () => {
            const hook = await purchase(['starter']);
            // Past the whole poll budget: the first poll and the late poll.
            await advanceWhile(() => statusOf(hook) !== 'timed-out');
            expect(statusOf(hook)).toBe('timed-out');
            expect(router.replace).not.toHaveBeenCalled();
        });

        test('PE6 today: when billing never confirms, the late poll just clears activationPending; nothing reports a timeout', async () => {
            const hook = await purchase(['starter']);
            expect(hook.result.current.activationPending).toBe(true);
            await advanceWhile(() => hook.result.current.activationPending);
            expect(hook.result.current.activationPending).toBe(false);
            expect(statusOf(hook)).toBeUndefined();
            expect(hook.result.current.billing?.subscriptionTier).toBe('starter');
        });
    });
});
