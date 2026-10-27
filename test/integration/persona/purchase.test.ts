// The PRIMARY purchase route (You > Settings > Manage plan > View Plans) through `useManageSubscription`,
// and the shared free-tier paywall chokepoint (`presentFreeTierPaywall`). Real stores, Apollo over MSW,
// in-memory DB, real app-restart holds, real toast queue. Mocked: the
// RevenueCat paywall SDK (an edge), driven per test.
import Purchases from 'react-native-purchases';
import RevenueCatUI from 'react-native-purchases-ui';
import { act, configure, renderHook, waitFor } from '@testing-library/react-native';
import { useManageSubscription } from '@/components/custom/config-mera/useManageSubscription';
import { __resetAppRestartForTests, activeHolds } from '@/lib/app-restart';
import database from '@/lib/database';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { resetEntitlementSyncState } from '@/lib/subscription/entitlement-sync';
import { readLastKnownTier } from '@/lib/subscription/last-known-tier';
import { configureRevenueCat } from '@/lib/revenuecat';
import { presentFreeTierPaywall } from '@/lib/subscription/present-free-tier-paywall';
import { PURCHASE_HOLD_AFTER_RETURN_MS, PURCHASE_HOLD_CEILING_MS } from '@/lib/subscriptions/subscribe-flow';
import { useDialogQueue } from '@/lib/dialog';
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

const presentPaywall = RevenueCatUI.presentPaywall as unknown as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const router = require('expo-router').router as { replace: jest.Mock };

// A paid tier carries the store entitlement's expiry; the free Starter grant has none, only a grant window.
const PAID_END = '2026-11-09T12:00:00.000Z';
const GRANT_END = '2026-10-23T12:00:00.000Z';
type BillingStep = string | { tier: string; over: Record<string, unknown> };
/** The free Starter every account holds: a grant window, no store entitlement. */
const freeStarter: BillingStep = { tier: 'starter', over: { entitlementExpiresAt: null, grantExpiresAt: GRANT_END } };
/** Starter bought from the store: an entitlement expiry, no grant. */
const boughtStarter: BillingStep = { tier: 'starter', over: { entitlementExpiresAt: PAID_END, grantExpiresAt: null } };

const billing = (step: BillingStep) => {
    const { tier, over } = typeof step === 'string' ? { tier: step, over: {} } : step;
    const paid = tier === 'individual' || tier === 'professional';
    return {
        __typename: 'UserBillingInfo',
        subscriptionTier: tier,
        dailyArticleLimit: 250,
        articlesUsedToday: 0,
        entitlementExpiresAt: paid ? PAID_END : null,
        resetAt: null,
        grantExpiresAt: null,
        ...over,
    };
};

/** GetUserBilling answers one entry per call (the last repeats). The mount load is call 1. */
function scriptBilling(steps: BillingStep[]): () => number {
    let calls = 0;
    server.use(
        graphql.query('GetUserBilling', () =>
            HttpResponse.json({ data: { userBilling: billing(steps[Math.min(calls++, steps.length - 1)]) } }),
        ),
    );
    return () => calls;
}

const purchases = Purchases as unknown as { getCustomerInfo: jest.Mock };
const ENTITLEMENT_ID: Record<string, string> = {
    starter: 'mera-news-starter-plan',
    individual: 'mera-news-individual-plan',
    professional: 'mera-news-professional-plan',
};
/** What the RevenueCat SDK reports as active: the tier it names, or nothing. */
function rcReports(tier: string | null) {
    const active = tier ? { [ENTITLEMENT_ID[tier]]: { identifier: ENTITLEMENT_ID[tier], isActive: true, productIdentifier: `${tier}_monthly` } } : {};
    purchases.getCustomerInfo.mockResolvedValue({ entitlements: { active } });
}
/** The next paywall buys `tier`: the store took the money, so the SDK now reports that entitlement. */
function paywallBuys(tier: string) {
    presentPaywall.mockImplementationOnce(async () => {
        rcReports(tier);
        return 'PURCHASED';
    });
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

/** The text of the toasts queued: title then body. */
const textOf = (node: unknown): string[] => {
    if (node == null || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(textOf);
    const props = (node as { props?: { title?: unknown; body?: unknown; children?: unknown } }).props;
    // A MeraToast carries its text as props.
    if (typeof props?.title === 'string') return [props.title, ...(typeof props.body === 'string' ? [props.body] : [])];
    return textOf(props?.children);
};
const toastTitles = () => useToastQueue.getState().entries.map((e) => textOf(e.render({ id: e.id }))[0]);

/** Mounts the hook and waits for its first load. The clock is faked first: holds arm timers. */
async function mountSettled() {
    fakeClock(NOW, { advanceTimers: true });
    const hook = renderHook(() => useManageSubscription());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
}

type Status = 'idle' | 'confirming' | 'confirmed' | 'timed-out' | undefined;
/** The hook's purchase status. */
const statusOf = (hook: Awaited<ReturnType<typeof mountSettled>>): Status =>
    (hook.result.current as { purchaseStatus?: Status }).purchaseStatus;

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
        // toast-manager requires the toast UI module lazily, on the first toast it shows. Its cold load takes
        // seconds (more under machine load) and would otherwise be charged to whichever test confirms a
        // purchase first, timing it out. Pay it once here, outside any test.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@/components/custom/toast/MeraToast');
    }, 60_000);

    beforeEach(() => {
        stops.splice(0).forEach((stop) => stop());
        __resetAppRestartForTests();
        resetEntitlementSyncState();
        useSubscriptionStore.getState().reset();
        resetToastQueue();
        useDialogQueue.setState({ queue: [] });
        setAppState('active');
        presentPaywall.mockResolvedValue('CANCELLED');
        rcReports(null);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await settleBackgroundWork();
    });

    // ---------------------------------------------------------------------------------------------
    describe('the restart hold', () => {
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

        it('presentFreeTierPaywall takes it, and keeps it when the sheet throws', async () => {
            fakeClock(NOW, { advanceTimers: true });
            presentPaywall.mockRejectedValueOnce(new Error('sheet failed'));
            await advanceUntilDone(presentFreeTierPaywall('test'));
            expect(activeHolds()).toEqual(['purchase']);
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
            // Every confirmed purchase announces its plan, whatever the account held before.
            expect(toastTitles()).toEqual(['Individual is active']);
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
            // A restore says the plan is back and never shows the receipts note.
            expect(toastTitles()).toEqual(['Your plan is back.']);
            expect(useDialogQueue.getState().queue).toEqual([]);
        });

        it('the receipts note shows once, after the first confirmed purchase only', async () => {
            scriptBilling(['starter', 'individual']);
            paywallBuys('individual');
            const hook = await mountSettled();

            await viewPlans(hook);
            await settleBackgroundWork();
            const first = useDialogQueue.getState().queue;
            expect(first).toHaveLength(1);
            expect(first[0]).toMatchObject({ title: 'Individual is active', confirmLabel: 'OK' });
            expect(first[0].cancelLabel).toBeUndefined();
            expect(first[0].body).toMatch(/receipts/);

            useDialogQueue.setState({ queue: [] });
            scriptBilling(['individual', 'professional']);
            paywallBuys('professional');
            await viewPlans(hook);
            await settleBackgroundWork();
            expect(toastTitles()).toContain('Professional is active');
            expect(useDialogQueue.getState().queue).toEqual([]);
        });

        // PE15 / PE17: the account holds the free Starter grant (a grant window, no store entitlement).
        describe('from the free Starter grant', () => {
            const startFree = async (steps: BillingStep[], buys: string) => {
                scriptBilling(steps);
                paywallBuys(buys);
                return mountSettled();
            };

            test('PE15: buying Starter from the free grant confirms', async () => {
                const hook = await startFree([freeStarter, freeStarter, boughtStarter], 'starter');
                await viewPlans(hook);
                expect(hook.result.current.activationPending).toBe(false);
                expect(hook.result.current.billing?.entitlementExpiresAt).toBe(PAID_END);
                expect(statusOf(hook)).toBe('confirmed');
            });

            test('PE17: the plan-active toast shows after an upgrade from free Starter', async () => {
                const hook = await startFree([freeStarter, 'individual'], 'individual');
                await viewPlans(hook);
                expect(hook.result.current.billing?.subscriptionTier).toBe('individual');
                expect(toastTitles()).toEqual(['Individual is active']);
            });

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
            fakeClock(NOW, { advanceTimers: true });
            await advanceUntilDone(presentFreeTierPaywall('test'));
            expect(presentPaywall).toHaveBeenCalledWith({ displayCloseButton: true });
        });

        it('cancelled: a FORCED entitlement sync goes out, the store takes the answer, and nothing is navigated', async () => {
            fakeClock(NOW, { advanceTimers: true });
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
            fakeClock(NOW, { advanceTimers: true });
            useSubscriptionStore.getState().setServerBilling({ subscriptionTier: 'none' });
            scriptBilling(['individual']);
            presentPaywall.mockResolvedValueOnce('PURCHASED');

            await advanceUntilDone(presentFreeTierPaywall('test'));

            expect(useSubscriptionStore.getState().serverTier).toBe('individual');
            await until(async () => (await readLastKnownTier()) === 'individual');
            expect(toastTitles()).toEqual(['Individual is active']);
        });

        it('an unconfirmed purchase commits nothing and announces nothing, then a forced sync follows', async () => {
            fakeClock(NOW, { advanceTimers: true });
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
            fakeClock(NOW, { advanceTimers: true });
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
    describe('PE6 after a purchase', () => {
        // The SDK reports entitlements only once configured; the planned confirm rule reads them.
        beforeAll(() => configureRevenueCat());


        /** Mounts, buys, and runs the purchase to the end of its first poll. `steps` scripts GetUserBilling. */
        const purchase = async (steps: string[]) => {
            scriptBilling(steps);
            paywallBuys('individual');
            const hook = await mountSettled();
            await viewPlans(hook);
            return hook;
        };
        /** Gives any navigation the purchase would trigger time to land (it is fired, not awaited). */
        const settle = () =>
            act(async () => {
                await jest.advanceTimersByTimeAsync(1000);
            });

        test('PE6 a confirmed purchase stays on Manage subscription (account with facts)', async () => {
            await seedFacts(['Follows Formula 1']);
            await purchase(['starter', 'individual']);
            await settle();
            expect(router.replace).not.toHaveBeenCalled();
        });

        test('PE6 a confirmed purchase stays on Manage subscription (account without facts)', async () => {
            await purchase(['starter', 'individual']);
            await settle();
            expect(router.replace).not.toHaveBeenCalled();
        });

        // mount + 8 first-poll reads + the late poll's first read on "starter"; the webhook lands on its second.
        const lateConfirmation = () => Array<string>(10).fill('starter').concat('individual');

        test('PE6 a purchase confirmed only by the late poll stays on Manage subscription', async () => {
            await seedFacts(['Follows Formula 1']);
            const hook = await purchase(lateConfirmation());
            await advanceWhile(() => hook.result.current.billing?.subscriptionTier !== 'individual');
            await settle();
            expect(hook.result.current.billing?.subscriptionTier).toBe('individual');
            expect(router.replace).not.toHaveBeenCalled();
        });

        test('PE6 presentFreeTierPaywall leaves the user where they are after a confirmed purchase', async () => {
            fakeClock(NOW, { advanceTimers: true });
            await seedFacts(['Follows Formula 1']);
            useSubscriptionStore.getState().setServerBilling({ subscriptionTier: 'none' });
            scriptBilling(['individual']);
            paywallBuys('individual');

            await advanceUntilDone(presentFreeTierPaywall('test'));
            await settle();

            expect(useSubscriptionStore.getState().serverTier).toBe('individual');
            expect(router.replace).not.toHaveBeenCalled();
        });

        /** Starts a purchase WITHOUT waiting for its poll, so the state during the poll can be read. */
        const startPurchase = async (steps: string[]) => {
            scriptBilling(steps);
            paywallBuys('individual');
            const hook = await mountSettled();
            let done: Promise<void> = Promise.resolve();
            act(() => {
                done = hook.result.current.handleViewPlans();
            });
            return { hook, done };
        };
        // mount, then three "starter" poll reads before the webhook lands: the poll runs for a few seconds.
        const confirmsOnFourthRead = ['starter', 'starter', 'starter', 'individual'];

        test('PE6 the hook reports confirming while billing is polled, then confirmed', async () => {
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

        test('PE6 when billing never confirms, the hook ends in timed-out (the page asks the user to contact support)', async () => {
            const hook = await purchase(['starter']);
            // Past the whole poll budget: the first poll and the late poll.
            await advanceWhile(() => statusOf(hook) !== 'timed-out');
            expect(statusOf(hook)).toBe('timed-out');
            expect(router.replace).not.toHaveBeenCalled();
        });


        test('checkAgain from timed-out goes back to confirming, then confirms when billing finally shows the paid tier', async () => {
            // mount + 8 first-poll reads + 20 late reads stay on starter; the webhook lands for the next look.
            scriptBilling([...Array<string>(29).fill('starter'), 'individual']);
            paywallBuys('individual');
            const hook = await mountSettled();
            await viewPlans(hook);
            await advanceWhile(() => statusOf(hook) !== 'timed-out');
            expect(statusOf(hook)).toBe('timed-out');

            let again: Promise<void> = Promise.resolve();
            act(() => {
                again = hook.result.current.checkAgain();
            });
            expect(statusOf(hook)).toBe('confirming');
            await act(async () => {
                await advanceUntilDone(again);
            });

            expect(statusOf(hook)).toBe('confirmed');
            expect(hook.result.current.billing?.subscriptionTier).toBe('individual');
            expect(toastTitles()).toEqual(['Individual is active']);
            expect(router.replace).not.toHaveBeenCalled();
        });
    });
});
