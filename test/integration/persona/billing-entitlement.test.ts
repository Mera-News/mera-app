// Billing, entitlement sync, the device's last-known tier, the /token subscription latch, the AI-access
// verdict and the activation toast. Real stores, real Apollo client over MSW, in-memory DB, real toast
// queue. Mocked: nothing. Concurrency is counted with a call-through spy on the real `fetchUserBilling`,
// because Apollo merges two identical in-flight queries into ONE HTTP request, so the wire count hides
// how many syncs ran.
import { waitFor } from '@testing-library/react-native';
import * as billingService from '@/lib/billing-service';
import {
    fetchUserBilling,
    fetchUserBillingLapseState,
    refreshUserBillingAfterPurchase,
} from '@/lib/billing-service';
import database from '@/lib/database';
import * as settingService from '@/lib/database/services/setting-service';
import { LAST_DAILY_ARTICLE_LIMIT_KEY } from '@/lib/background/bg-refresh-settings';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import {
    aiAccessFromLastKnownTier,
    clearLastKnownTier,
    LAST_KNOWN_TIER_SETTING_KEY,
    readLastKnownTier,
    rememberLastKnownTier,
} from '@/lib/subscription/last-known-tier';
import { resetEntitlementSyncState, syncEntitlement } from '@/lib/subscription/entitlement-sync';
import { showSubscriptionActivatedToast } from '@/lib/subscription/activation-toast';
import {
    _resetJwtSubscriptionGateForTests,
    clearJwtSubscriptionLock,
    isJwtSubscriptionLocked,
    isSubscriptionRequiredAuthError,
    recordJwtSubscriptionLocked,
} from '@/lib/subscription/jwt-subscription-gate';
import {
    aiAccessIsServerResolved,
    deriveAiAccess,
    deriveHasEverSubscribed,
    deriveShowLapseInterstitial,
} from '@/lib/subscription/ai-access';
import * as featureGates from '@/lib/config/feature-gates';
import { toastManager } from '@/lib/toast-manager';
import { resetToastQueue, toastApi, useToastQueue } from '@/lib/toast/toast-queue';
import {
    advanceUntilDone,
    graphql,
    http,
    HttpResponse,
    delay,
    initI18nEn,
    mockGql,
    mockGqlError,
    server,
    setScenario,
    useFakeClock as fakeClock,
} from '@/test/helpers';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

const billing = (subscriptionTier: string | null, over: Record<string, unknown> = {}) => ({
    __typename: 'UserBillingInfo',
    subscriptionTier,
    dailyArticleLimit: 100,
    articlesUsedToday: 3,
    entitlementExpiresAt: null,
    resetAt: null,
    grantExpiresAt: null,
    ...over,
});

/** A GraphQL response body. The cast is only for msw's resolver typing, which cannot unify a data and an error body. */
const gqlBody = (body: { data?: unknown; errors?: unknown[] }): never => HttpResponse.json(body as never) as never;
const gqlErrorBody = () => gqlBody({ errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });

interface Sent {
    op: string;
    at: number;
}

/** Every GraphQL operation the app sends from now on, with the (fake) clock reading at the request. */
const stops: (() => void)[] = [];
function recordOps(): Sent[] {
    const sent: Sent[] = [];
    const listener = ({ request }: { request: Request }) => {
        if (!request.url.endsWith('/graphql')) return;
        const at = Date.now();
        void request
            .clone()
            .json()
            .then((b: { operationName?: string }) => {
                if (b.operationName) sent.push({ op: b.operationName, at });
            });
    };
    server.events.on('request:start', listener);
    stops.push(() => server.events.removeListener('request:start', listener));
    return sent;
}
const opsNamed = (sent: Sent[], op: string) => sent.filter((s) => s.op === op);

/** A scripted billing row: a tier plus overrides (the free Starter grant and a bought one differ only in these). */
type BillingStep = { tier: string | null; over: Record<string, unknown> };
const GRANT_END = '2026-10-23T12:00:00.000Z';
const BOUGHT_END = '2026-11-09T12:00:00.000Z';
/** The free Starter every account holds: a grant window, no store entitlement. */
const freeStarter: BillingStep = { tier: 'starter', over: { entitlementExpiresAt: null, grantExpiresAt: GRANT_END } };
/** Starter bought from the store: an entitlement expiry, no grant. */
const boughtStarter: BillingStep = { tier: 'starter', over: { entitlementExpiresAt: BOUGHT_END, grantExpiresAt: null } };

/** GetUserBilling answers one entry per call; the last entry repeats. A string is a tier, 'error' a GraphQL error. */
function scriptBilling(steps: (string | null | 'error' | BillingStep)[]): () => number {
    let calls = 0;
    server.use(
        graphql.query('GetUserBilling', () => {
            const step = steps[Math.min(calls++, steps.length - 1)];
            if (step === 'error') return gqlErrorBody();
            const row = step !== null && typeof step === 'object' ? billing(step.tier, step.over) : billing(step);
            return gqlBody({ data: { userBilling: row } });
        }),
    );
    return () => calls;
}

let fetchSpy: jest.SpyInstance;

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

describe('billing and entitlement', () => {
    beforeAll(async () => {
        await initI18nEn();
        toastManager.setToastInstance(toastApi);
    });

    beforeEach(() => {
        stops.splice(0).forEach((stop) => stop());
        resetEntitlementSyncState();
        _resetJwtSubscriptionGateForTests();
        useSubscriptionStore.getState().reset();
        _resetJwtSubscriptionGateForTests();
        resetToastQueue();
        fetchSpy = jest.spyOn(billingService, 'fetchUserBilling');
    });

    afterEach(async () => {
        fetchSpy.mockRestore();
        jest.restoreAllMocks();
        (globalThis as { __DEV__?: boolean }).__DEV__ = true;
        await settleBackgroundWork();
    });

    // ---------------------------------------------------------------------------------------------
    describe('fetchUserBilling', () => {
        it('returns the account billing row', async () => {
            setScenario({ tier: 'individual' });
            const result = await fetchUserBilling();
            expect(result).toMatchObject({ subscriptionTier: 'individual', dailyArticleLimit: 1000 });
        });

        it('returns null on a GraphQL error', async () => {
            server.use(mockGqlError('GetUserBilling', 'INTERNAL_SERVER_ERROR'));
            await expect(fetchUserBilling()).resolves.toBeNull();
        });

        it('returns null on a transport error', async () => {
            server.use(http.post('*/graphql', () => HttpResponse.error()));
            await expect(fetchUserBilling()).resolves.toBeNull();
        });

        it('fetchUserBillingLapseState returns the lapse fields, and null quietly on any error', async () => {
            server.use(
                mockGql('GetUserBillingLapseState', {
                    userBilling: { subscriptionTier: 'starter', hasEverSubscribed: true, showLapseInterstitial: true, grantExpiresAt: null },
                }),
            );
            await expect(fetchUserBillingLapseState()).resolves.toMatchObject({
                hasEverSubscribed: true,
                showLapseInterstitial: true,
            });

            server.use(mockGqlError('GetUserBillingLapseState', 'GRAPHQL_VALIDATION_FAILED'));
            await expect(fetchUserBillingLapseState()).resolves.toBeNull();
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('refreshUserBillingAfterPurchase', () => {
        it('returns on the first attempt when the tier already changed', async () => {
            const calls = scriptBilling(['professional']);
            const result = await refreshUserBillingAfterPurchase('individual', { intervalMs: 10 });
            expect(result).toMatchObject({ confirmed: true, billing: { subscriptionTier: 'professional' } });
            expect(calls()).toBe(1);
        });

        it('keeps polling while the webhook has not landed, then returns the new tier', async () => {
            const calls = scriptBilling(['individual', 'individual', 'professional']);
            const result = await refreshUserBillingAfterPurchase('individual', { attempts: 5, intervalMs: 10 });
            expect(result).toMatchObject({ confirmed: true, billing: { subscriptionTier: 'professional' } });
            expect(calls()).toBe(3);
        });

        it('gives up after the attempt budget and reports unconfirmed, the deferred-plan-change case where the tier never changes', async () => {
            const calls = scriptBilling(['individual']);
            const result = await refreshUserBillingAfterPurchase('individual', { attempts: 3, intervalMs: 10 });
            // Still the OLD tier, and flagged unresolved so the caller refuses to commit it.
            expect(result).toMatchObject({ confirmed: false, billing: { subscriptionTier: 'individual' } });
            // Bounded: exactly `attempts` fetches.
            expect(calls()).toBe(3);
        });

        // PE14: the free Starter grant every account holds is not a purchase, even for a missing or 'none' starting
        // tier. Confirming Starter needs a store entitlement.
        test('PE14: a missing starting tier does not confirm on the free Starter grant', async () => {
            const calls = scriptBilling(['none', freeStarter]);
            const result = await refreshUserBillingAfterPurchase(null, { attempts: 3, intervalMs: 10 });
            expect(result).toMatchObject({ confirmed: false, billing: { subscriptionTier: 'starter' } });
            expect(calls()).toBe(3);
        });

        // PE15: Starter bought on top of the free grant keeps the tier string, so the store entitlement confirms it.
        test('PE15: buying Starter from the free grant confirms', async () => {
            const calls = scriptBilling([freeStarter, boughtStarter]);
            const result = await refreshUserBillingAfterPurchase('starter', { attempts: 3, intervalMs: 10 });
            expect(result).toMatchObject({ confirmed: true, billing: { subscriptionTier: 'starter', entitlementExpiresAt: BOUGHT_END } });
            expect(calls()).toBe(2);
        });

        it('a null server tier reads as "none" too: no change from "none", so unconfirmed', async () => {
            scriptBilling([null]);
            const result = await refreshUserBillingAfterPurchase('none', { attempts: 2, intervalMs: 10 });
            expect(result.confirmed).toBe(false);
        });

        it('survives a failing fetch mid-poll and still returns the eventual snapshot', async () => {
            scriptBilling(['error', 'professional']);
            const result = await refreshUserBillingAfterPurchase('individual', { attempts: 3, intervalMs: 10 });
            expect(result).toMatchObject({ confirmed: true, billing: { subscriptionTier: 'professional' } });
        });

        it('reports unconfirmed with a null snapshot when every attempt fails', async () => {
            scriptBilling(['error']);
            await expect(
                refreshUserBillingAfterPurchase('individual', { attempts: 2, intervalMs: 10 }),
            ).resolves.toEqual({ billing: null, confirmed: false });
        });

        it('default budget: 8 attempts, gaps 1500ms growing x1.5 and capped at 4000ms', async () => {
            fakeClock(NOW);
            const sent = recordOps();
            scriptBilling(['individual']);

            const result = await advanceUntilDone(refreshUserBillingAfterPurchase('individual'));

            expect(result.confirmed).toBe(false);
            const requests = opsNamed(sent, 'GetUserBilling');
            expect(requests).toHaveLength(8);
            const gaps = requests.slice(1).map((r, i) => r.at - requests[i].at);
            const sleeps = [1500, 2250, 3375, 4000, 4000, 4000, 4000];
            // A request never goes out earlier than the sleep before it. The fake clock also runs while a response
            // is in flight, so a gap may overshoot by that wait, which is far smaller than the step between sleeps.
            gaps.forEach((gap, i) => {
                expect(gap).toBeGreaterThanOrEqual(sleeps[i]);
                expect(gap).toBeLessThan(sleeps[i] + 700);
            });
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('syncEntitlement', () => {
        const settled = async (read: () => Promise<unknown>, expected: unknown) =>
            waitFor(async () => expect(await read()).toEqual(expected));

        it('fetches on the very first call (no debounce clock has started) and mirrors the answer into the store', async () => {
            setScenario({ tier: 'individual' });
            await syncEntitlement();
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const state = useSubscriptionStore.getState();
            expect(state.serverTier).toBe('individual');
            expect(state.grantExpiresAt).toBeNull();
        });

        it('carries the starter grant window into the store', async () => {
            setScenario({ tier: 'starter' });
            await syncEntitlement();
            const state = useSubscriptionStore.getState();
            expect(state.serverTier).toBe('starter');
            expect(state.grantExpiresAt).not.toBeNull();
        });

        // The device's memory of its own tier: the pre-onboarding gate falls back on it when billing cannot be
        // reached on a cold start.
        it('records the resolved tier on the device', async () => {
            setScenario({ tier: 'individual' });
            await syncEntitlement();
            await settled(readLastKnownTier, 'individual');
        });

        it('records the daily article limit for the background refresh allowance', async () => {
            setScenario({ tier: 'individual' });
            await syncEntitlement();
            await settled(() => settingService.getSetting(LAST_DAILY_ARTICLE_LIMIT_KEY), '1000');
        });

        it('records no limit and no tier when the fetch failed: a silent server is not a resolution', async () => {
            server.use(mockGqlError('GetUserBilling', 'INTERNAL_SERVER_ERROR'), mockGqlError('GetUserBillingLapseState', 'INTERNAL_SERVER_ERROR'));
            await syncEntitlement();
            // Let any stray fire-and-forget write land before asserting its absence.
            await new Promise((r) => setTimeout(r, 30));
            await expect(readLastKnownTier()).resolves.toBeNull();
            await expect(settingService.getSetting(LAST_DAILY_ARTICLE_LIMIT_KEY)).resolves.toBeNull();
            expect(useSubscriptionStore.getState().serverTier).toBeNull();
        });

        it("records 'none' when the server answers with no tier: that IS a resolution", async () => {
            // Telling it apart from "never resolved" is the point: only a never-resolved device may fall through to
            // the paywall on an unresolvable verdict.
            // Both reads carry the tier into the store, so the lapse read is silenced to keep this about the first.
            server.use(mockGql('GetUserBilling', { userBilling: billing(null) }), mockGqlError('GetUserBillingLapseState', 'INTERNAL_SERVER_ERROR'));
            await syncEntitlement();
            await settled(readLastKnownTier, 'none');
            expect(useSubscriptionStore.getState().serverTier).toBe('none');
        });

        it('debounces a second call inside the 60s window and fetches again once it has elapsed', async () => {
            fakeClock(NOW);
            await syncEntitlement();
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            // The clock runs while the request is in flight, so the sync time is somewhere in [NOW, finished].
            const finished = Date.now();

            jest.setSystemTime(NOW + 30_000);
            await syncEntitlement();
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            jest.setSystemTime(NOW + 59_000);
            await syncEntitlement();
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // At or past the edge: the comparison is "< 60_000", so the edge itself fetches.
            jest.setSystemTime(finished + 60_000);
            await syncEntitlement();
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it('`force: true` bypasses the debounce window entirely', async () => {
            await syncEntitlement();
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await syncEntitlement({ force: true });
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it('a failed fetch does not start the debounce clock: the next call still fetches', async () => {
            scriptBilling(['error', 'individual']);
            // Both reads carry the tier into the store, so the lapse read is silenced to keep this about the first.
            server.use(mockGqlError('GetUserBillingLapseState', 'INTERNAL_SERVER_ERROR'));
            await syncEntitlement();
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(useSubscriptionStore.getState().serverTier).toBeNull();

            await syncEntitlement();
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(useSubscriptionStore.getState().serverTier).toBe('individual');
        });

        it('concurrent calls without force share the same in-flight fetch', async () => {
            fakeClock(NOW);
            server.use(
                graphql.query('GetUserBilling', async () => {
                    await delay(500);
                    return HttpResponse.json({ data: { userBilling: billing('professional') } });
                }),
                mockGqlError('GetUserBillingLapseState', 'INTERNAL_SERVER_ERROR'),
            );
            const first = syncEntitlement();
            const second = syncEntitlement();
            await advanceUntilDone(Promise.all([first, second]));
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(useSubscriptionStore.getState().serverTier).toBe('professional');
        });

        it('pushes the lapse-state snapshot into the store separately', async () => {
            server.use(
                mockGql('GetUserBillingLapseState', {
                    userBilling: { subscriptionTier: 'starter', hasEverSubscribed: true, showLapseInterstitial: true, grantExpiresAt: null },
                }),
            );
            await syncEntitlement();
            const state = useSubscriptionStore.getState();
            expect(state.hasEverSubscribed).toBe(true);
            expect(state.showLapseInterstitial).toBe(true);
        });

        it('a server without the lapse fields leaves the tier answer intact', async () => {
            server.use(mockGqlError('GetUserBillingLapseState', 'GRAPHQL_VALIDATION_FAILED'));
            setScenario({ tier: 'individual' });
            await syncEntitlement();
            const state = useSubscriptionStore.getState();
            expect(state.serverTier).toBe('individual');
        });

        it('resetEntitlementSyncState() clears the debounce window', async () => {
            await syncEntitlement();
            resetEntitlementSyncState();
            await syncEntitlement();
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        describe('a sync that starts while a forced one is in flight', () => {
            // Setup: A (unforced) is slow and its billing read fails, so it records no sync time. B (forced) starts
            // while A runs and outlives it. When A settles it clears the in-flight marker that now belongs to B.
            // C (unforced) arrives next, while B is still running.
            async function runBClobberScenario(firstReadFails: boolean) {
                fakeClock(NOW);
                let billingCalls = 0;
                let lapseCalls = 0;
                server.use(
                    graphql.query('GetUserBilling', async () => {
                        billingCalls += 1;
                        if (billingCalls === 1) {
                            await delay(1000);
                            return firstReadFails ? gqlErrorBody() : gqlBody({ data: { userBilling: billing('individual') } });
                        }
                        return gqlBody({ data: { userBilling: billing('individual') } });
                    }),
                    graphql.query('GetUserBillingLapseState', async () => {
                        lapseCalls += 1;
                        // B's lapse read is the long one: B outlives A.
                        if (lapseCalls === 2) await delay(2000);
                        return HttpResponse.json({
                            data: { userBilling: { subscriptionTier: 'individual', hasEverSubscribed: true, showLapseInterstitial: false, grantExpiresAt: null } },
                        });
                    }),
                );

                const a = syncEntitlement();
                await jest.advanceTimersByTimeAsync(300);
                const b = syncEntitlement({ force: true });
                // A settles at ~1000ms; B is still in flight until ~2300ms.
                await jest.advanceTimersByTimeAsync(1200);
                const c = syncEntitlement();
                await advanceUntilDone(Promise.all([a, b, c]));
                return fetchSpy.mock.calls.length;
            }

            test.failing('B7 a sync while a forced one is in flight joins it', async () => {
                // A, B, then C joins B: two reads in total.
                await expect(runBClobberScenario(true)).resolves.toBe(2);
            });

            test('B7 today: A settling clears the in-flight marker, so C starts a third read', async () => {
                await expect(runBClobberScenario(true)).resolves.toBe(3);
            });

            test('a successful first read debounces C, hiding the clobbered marker (two reads)', async () => {
                await expect(runBClobberScenario(false)).resolves.toBe(2);
            });
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('last-known-tier', () => {
        const row = () => settingService.getSetting(LAST_KNOWN_TIER_SETTING_KEY);

        describe('rememberLastKnownTier', () => {
            it('records a paid tier verbatim', async () => {
                await rememberLastKnownTier('professional');
                await expect(row()).resolves.toBe('professional');
            });

            it("records 'none': a server that says the user has no plan HAS resolved", async () => {
                await rememberLastKnownTier('none');
                await expect(row()).resolves.toBe('none');
            });

            it('records nothing for null / undefined / empty', async () => {
                const writes = jest.spyOn(settingService, 'setSetting');
                await rememberLastKnownTier(null);
                await rememberLastKnownTier(undefined);
                await rememberLastKnownTier('');
                // "We did not learn a tier" must not masquerade as history.
                await expect(row()).resolves.toBeNull();
                expect(writes).not.toHaveBeenCalled();
            });

            it('swallows a write failure: callers fire it alongside work that matters more', async () => {
                jest.spyOn(settingService, 'setSetting').mockRejectedValueOnce(new Error('db unavailable'));
                await expect(rememberLastKnownTier('starter')).resolves.toBeUndefined();
            });
        });

        describe('readLastKnownTier', () => {
            it('returns null when nothing was ever recorded', async () => {
                await expect(readLastKnownTier()).resolves.toBeNull();
            });

            it('round-trips what was written', async () => {
                await rememberLastKnownTier('individual');
                await expect(readLastKnownTier()).resolves.toBe('individual');
            });

            it('FAILS CLOSED on an unreadable row: never read as a subscriber', async () => {
                await rememberLastKnownTier('professional');
                jest.spyOn(settingService, 'getSetting').mockRejectedValueOnce(new Error('db unavailable'));
                await expect(readLastKnownTier()).resolves.toBeNull();
            });
        });

        describe('clearLastKnownTier', () => {
            it('removes the row', async () => {
                await rememberLastKnownTier('professional');
                await clearLastKnownTier();
                await expect(readLastKnownTier()).resolves.toBeNull();
            });

            it('swallows a delete failure', async () => {
                jest.spyOn(settingService, 'deleteSetting').mockRejectedValueOnce(new Error('db unavailable'));
                await expect(clearLastKnownTier()).resolves.toBeUndefined();
            });
        });

        describe('aiAccessFromLastKnownTier', () => {
            it('null / empty means unknown: the never-resolved state the gate keys the paywall off', () => {
                expect(aiAccessFromLastKnownTier(null)).toBe('unknown');
                expect(aiAccessFromLastKnownTier('')).toBe('unknown');
            });

            it("'none' means entitled, not locked: no account carries it any more", () => {
                expect(aiAccessFromLastKnownTier('none')).toBe('entitled');
            });

            it('any other tier means entitled, including one this build has never heard of', () => {
                for (const tier of ['starter', 'individual', 'professional', 'enterprise']) {
                    expect(aiAccessFromLastKnownTier(tier)).toBe('entitled');
                }
            });
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('the /token subscription latch', () => {
        describe('isSubscriptionRequiredAuthError', () => {
            // The shape better-fetch returns on the non-throwing path: the parsed body spread, with status stamped on.
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
                    isSubscriptionRequiredAuthError({ statusCode: 403, body: { code: 'SUBSCRIPTION_REQUIRED' } }),
                ).toBe(true);
            });

            // An expired session must stay retryable, or a lapsed cookie never gets back in.
            it('does NOT match a generic 401 (expired session)', () => {
                expect(
                    isSubscriptionRequiredAuthError({ code: 'UNAUTHORIZED', message: 'Unauthorized', status: 401 }),
                ).toBe(false);
            });

            it('does NOT match a bare 403 with no code', () => {
                expect(isSubscriptionRequiredAuthError({ status: 403, message: 'Forbidden' })).toBe(false);
            });

            it('does NOT match a 401 that somehow carries the code (status disagrees)', () => {
                expect(isSubscriptionRequiredAuthError({ status: 401, code: 'SUBSCRIPTION_REQUIRED' })).toBe(false);
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
            it('latches so this session stops re-minting a refused JWT', () => {
                recordJwtSubscriptionLocked();
                expect(isJwtSubscriptionLocked()).toBe(true);
            });

            it('is idempotent: a second refusal costs nothing', () => {
                recordJwtSubscriptionLocked();
                recordJwtSubscriptionLocked();
                expect(isJwtSubscriptionLocked()).toBe(true);
            });

            it('clears explicitly', () => {
                recordJwtSubscriptionLocked();
                clearJwtSubscriptionLock();
                expect(isJwtSubscriptionLocked()).toBe(false);
            });
        });

        describe('clearing on a successful entitlement sync', () => {
            it('lifts the lock when the server reports a paid tier, no app restart', async () => {
                recordJwtSubscriptionLocked();
                setScenario({ tier: 'starter' });
                await syncEntitlement({ force: true });
                expect(isJwtSubscriptionLocked()).toBe(false);
            });

            it('leaves the lock in place when the server still says "none"', async () => {
                recordJwtSubscriptionLocked();
                setScenario({ tier: 'none' });
                await syncEntitlement({ force: true });
                expect(isJwtSubscriptionLocked()).toBe(true);
            });

            it('is not lifted by a snapshot that does not select subscriptionTier', () => {
                recordJwtSubscriptionLocked();
                // What the lapse-state query returns when the field is absent: "unknown", never "paid".
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
    });

    // ---------------------------------------------------------------------------------------------
    describe('deriveAiAccess and its siblings', () => {
        // `feature-gates` exports plain consts. The dev overrides are driven by replacing the property on the real
        // module for one test (restored by jest.restoreAllMocks), not by mocking the module.
        const force = (name: 'DEV_FORCE_AI_ACCESS' | 'DEV_FORCE_LAPSED', value: unknown) =>
            jest.replaceProperty(featureGates as never, name as never, value as never);
        const dev = (on: boolean) => {
            (globalThis as { __DEV__?: boolean }).__DEV__ = on;
        };

        describe('verdict precedence', () => {
            it('the dev override takes precedence over everything else', () => {
                force('DEV_FORCE_AI_ACCESS', 'locked');
                expect(deriveAiAccess({ serverTier: 'professional', hasCustomerInfo: true, isPremium: true })).toBe('locked');
            });

            it('the dev override is only consulted in dev builds', () => {
                force('DEV_FORCE_AI_ACCESS', 'locked');
                dev(false);
                expect(deriveAiAccess({ serverTier: 'professional', hasCustomerInfo: false, isPremium: false })).toBe('entitled');
            });

            it('any answer from the server means entitled', () => {
                expect(deriveAiAccess({ serverTier: 'starter', hasCustomerInfo: false, isPremium: false })).toBe('entitled');
                expect(deriveAiAccess({ serverTier: 'individual', hasCustomerInfo: true, isPremium: false })).toBe('entitled');
            });

            // RevenueCat may GRANT and may NEVER deny: Starter is a server-side grant it knows nothing about.
            it('grants from RevenueCat, but never denies, while the server is silent', () => {
                expect(deriveAiAccess({ serverTier: null, hasCustomerInfo: true, isPremium: true })).toBe('entitled');
                const empty = deriveAiAccess({ serverTier: null, hasCustomerInfo: true, isPremium: false });
                expect(empty).toBe('unknown');
                expect(empty).not.toBe('locked');
            });

            it('returns unknown, never locked, when neither the server nor RevenueCat has answered', () => {
                const result = deriveAiAccess({ serverTier: null, hasCustomerInfo: false, isPremium: false });
                expect(result).toBe('unknown');
                expect(result).not.toBe('locked');
            });

            it('an entitlement grants even while RevenueCat is still anonymous', () => {
                expect(deriveAiAccess({ serverTier: null, hasCustomerInfo: false, isPremium: true })).toBe('entitled');
            });

            it('an ANONYMOUS empty answer is unknown, not locked', () => {
                expect(deriveAiAccess({ serverTier: null, hasCustomerInfo: false, isPremium: false })).toBe('unknown');
            });
        });

        describe('aiAccessIsServerResolved', () => {
            it('is true once the server has answered, false while it has not', () => {
                expect(aiAccessIsServerResolved('starter')).toBe(true);
                expect(aiAccessIsServerResolved(null)).toBe(false);
            });

            it('is true under the dev override, which outranks every signal', () => {
                force('DEV_FORCE_AI_ACCESS', 'entitled');
                expect(aiAccessIsServerResolved(null)).toBe(true);
            });
        });

        describe('deriveShowLapseInterstitial', () => {
            it('returns the server flag verbatim when true', () => {
                expect(deriveShowLapseInterstitial(true, false)).toBe(true);
            });

            it('returns false when the server flag is false', () => {
                expect(deriveShowLapseInterstitial(false, false)).toBe(false);
            });

            it('returns false when the server flag is null (unknown)', () => {
                expect(deriveShowLapseInterstitial(null, false)).toBe(false);
            });

            it('DEV_FORCE_LAPSED seeds true when not yet acked', () => {
                force('DEV_FORCE_LAPSED', true);
                expect(deriveShowLapseInterstitial(null, false)).toBe(true);
                expect(deriveShowLapseInterstitial(false, false)).toBe(true);
            });

            it('DEV_FORCE_LAPSED stops applying once acked (a seed, not a clamp)', () => {
                force('DEV_FORCE_LAPSED', true);
                expect(deriveShowLapseInterstitial(false, true)).toBe(false);
            });

            it('DEV_FORCE_LAPSED is only consulted in dev builds', () => {
                force('DEV_FORCE_LAPSED', true);
                dev(false);
                expect(deriveShowLapseInterstitial(null, false)).toBe(false);
            });
        });

        describe('deriveHasEverSubscribed', () => {
            it('returns the server value verbatim outside the dev override', () => {
                expect(deriveHasEverSubscribed(true)).toBe(true);
                expect(deriveHasEverSubscribed(false)).toBe(false);
                expect(deriveHasEverSubscribed(null)).toBeNull();
            });

            it('resolves null to false only when DEV_FORCE_AI_ACCESS is forcing locked', () => {
                force('DEV_FORCE_AI_ACCESS', 'locked');
                expect(deriveHasEverSubscribed(null)).toBe(false);
            });

            it('does not touch a known server value even when forcing locked', () => {
                force('DEV_FORCE_AI_ACCESS', 'locked');
                expect(deriveHasEverSubscribed(true)).toBe(true);
            });

            it('does not resolve null when the override forces entitled instead of locked', () => {
                force('DEV_FORCE_AI_ACCESS', 'entitled');
                expect(deriveHasEverSubscribed(null)).toBeNull();
            });

            it('the locked-resolves-null-to-false override is only consulted in dev builds', () => {
                force('DEV_FORCE_AI_ACCESS', 'locked');
                dev(false);
                expect(deriveHasEverSubscribed(null)).toBeNull();
            });
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('showSubscriptionActivatedToast', () => {
        /** The text a queued toast would paint: its plain RN `Text` children. */
        const textOf = (node: unknown): string[] => {
            if (node == null || typeof node === 'boolean') return [];
            if (typeof node === 'string' || typeof node === 'number') return [String(node)];
            if (Array.isArray(node)) return node.flatMap(textOf);
            return textOf((node as { props?: { children?: unknown } }).props?.children);
        };
        const shown = () => useToastQueue.getState().entries.map((e) => textOf(e.render({ id: e.id })));

        it.each([
            ['starter', 'Starter is active'],
            ['individual', 'Individual is active'],
            ['professional', 'Professional is active'],
        ])('announces a confirmed %s purchase with the real plan name', (tier, title) => {
            showSubscriptionActivatedToast(tier);
            expect(shown()).toEqual([[title, 'Your personalized feed, dashboard, followed stories and chat are ready.']]);
        });

        it.each([[null], [undefined], ['none']])('stays silent when the new tier is %s', (tier) => {
            showSubscriptionActivatedToast(tier as string | null | undefined);
            expect(shown()).toEqual([]);
        });

        // planName used to fall through to a promo label, turning an unrecognised value into a confident, wrong name.
        it.each([['promo'], ['PROMOTIONAL'], ['mera-news-starter-plan'], ['']])(
            'stays silent for the unmappable tier %p rather than inventing "Promo"',
            (tier) => {
                showSubscriptionActivatedToast(tier);
                expect(shown()).toEqual([]);
            },
        );
    });
});
