/* eslint-disable @typescript-eslint/no-require-imports */
// onboarding-paywall-order.test.tsx — the paywall must be resolved BEFORE the
// onboarding wizard can mount.
//
// ## Why this is asserted through OnboardingScreen
//
// OnboardingScreen is the ONLY mounter of OnboardingWizard, and therefore the
// only chokepoint that both doorways into onboarding pass through: the
// cold-start route (app/logged-in/index.tsx) and the fresh-login / deep-link
// redirect, which goes straight to /logged-in/onboarding and never touches the
// cold-start gate. Asserting the ordering anywhere else would test a path a
// real signup can skip.
//
// ## What is real here and what is stubbed
//
// The entitlement chain is REAL end to end — feature-gates → ai-access →
// subscription-store → onboarding-paywall → OnboardingScreen — so these tests
// exercise the actual derivation rather than a restatement of it. Only the
// leaves are stubbed: RevenueCat (native), entitlement-sync (Apollo), the local
// DB services, and the wizard itself.
//
// ## Driving FREE_TIER_MODE_ENABLED
//
// lib/subscription/__tests__/ai-access.test.ts flips the ship gate with
// jest.resetModules() + jest.doMock(). That pattern is unusable in a suite that
// RENDERS: resetModules hands the component a second copy of `react`, and two
// React instances in one tree is an invalid-hook-call. A getter on the mocked
// module is the equivalent that survives rendering — Babel compiles a named
// import to a property access on the module object, so the getter is read at
// call time and the flag is genuinely live. Same coverage, no module-identity
// hazard. The default below is deliberately `true` (the post-cutover state
// under test); the false case is its own test.

import { act, render } from '@testing-library/react-native';
import React from 'react';

// ── ship gate, flippable per test ──────────────────────────────────────────
const gates = {
    FREE_TIER_MODE_ENABLED: true,
    DEV_FORCE_AI_ACCESS: null as 'entitled' | 'locked' | null,
    DEV_FORCE_LAPSED: false,
};
jest.mock('@/lib/config/feature-gates', () => ({
    __esModule: true,
    get FREE_TIER_MODE_ENABLED() { return gates.FREE_TIER_MODE_ENABLED; },
    get DEV_FORCE_AI_ACCESS() { return gates.DEV_FORCE_AI_ACCESS; },
    get DEV_FORCE_LAPSED() { return gates.DEV_FORCE_LAPSED; },
    get HEADLINE_DEPTH_UI_ENABLED() { return false; },
}));

// ── rendering leaves ───────────────────────────────────────────────────────
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/spinner', () => {
    const { View } = require('react-native');
    return { Spinner: (p: any) => <View testID="onboarding-gate-spinner" {...p} /> };
});
jest.mock('@/components/custom/auth/IdentitySwitchFailedScreen', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="identity-switch-failed" /> };
});
jest.mock('@/components/custom/onboarding/OnboardingWizard', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="onboarding-wizard" {...p} /> };
});

// ── identity / local DB leaves ─────────────────────────────────────────────
jest.mock('@/lib/stores', () => ({
    clearPreviousUserData: jest.fn(async () => {}),
    useUserStore: { getState: () => ({ setUserId: jest.fn(), setNeedsReauth: jest.fn() }) },
}));
jest.mock('@/lib/security/identity-gate', () => ({
    resolveIdentity: () => 'coherent',
    hasIdentityFault: async () => false,
    readPendingAuthUserId: () => null,
    clearPendingAuthUserId: () => {},
}));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('@/lib/stores/network-store', () => ({
    useNetworkStore: { getState: () => ({ isConnected: mockIsConnected }) },
    probeServerReachable: async () => true,
}));
let mockIsConnected = true;

// Zero facts on every test in this file: the paywall gate is only reachable on
// the "about to onboard" path, which is what all six cases are about.
jest.mock('@/lib/database/services/fact-service', () => ({ hasAnyFacts: async () => false }));

// A real in-memory KV rather than a read-only stub: `cached_user_id`, the
// first-open dismissal flag and the last-known tier are all rows in this table
// and all three are driven independently by the cases below — and the
// last-known-tier cases need WRITES to be observable, not just reads.
let mockSettings: Record<string, string | null> = {};
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: jest.fn(async (k: string) => mockSettings[k] ?? null),
    setSetting: jest.fn(async (k: string, v: string) => { mockSettings[k] = v; }),
    deleteSetting: jest.fn(async (k: string) => { delete mockSettings[k]; }),
}));

// ── native / network leaves ────────────────────────────────────────────────
// Stubbing this keeps react-native-purchases out of the graph while leaving the
// REAL subscription store (and therefore the real deriveAiAccess) in it.
jest.mock('@/lib/revenuecat', () => ({
    getActiveTier: () => null,
    loginRevenueCat: jest.fn(async () => null),
    // Needed by the real subscription store. `false` = "RevenueCat has spoken
    // about THIS user", which is the state that produces the cold-start race
    // the r13 test below pins.
    isAnonymousCustomerInfo: () => false,
}));

// Stands in for the server round trip. Each test decides what the server
// "answers" by setting `mockServerAnswer`; `null` means it never answers, which
// is the 'unknown' state.
let mockServerAnswer: { subscriptionTier: string } | null = null;
const mockSyncEntitlement = jest.fn(async () => {
    if (mockServerAnswer) {
        require('@/lib/stores/subscription-store')
            .useSubscriptionStore.getState()
            .setServerBilling(mockServerAnswer);
    }
});
jest.mock('@/lib/subscription/entitlement-sync', () => ({
    syncEntitlement: (...a: any[]) => mockSyncEntitlement(...(a as [])),
}));

import OnboardingScreen from '@/components/custom/onboarding/OnboardingScreen';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import {
    ONBOARDING_ENTITLEMENT_WAIT_MS,
    decideOnboardingEntry,
    waitForAiAccessResolved,
} from '@/lib/subscription/onboarding-paywall';
import { FIRST_OPEN_DISMISSED_SETTING_KEY } from '@/lib/subscription/first-open-dismissal';
import { LAST_KNOWN_TIER_SETTING_KEY } from '@/lib/subscription/last-known-tier';

function renderGate() {
    const onComplete = jest.fn();
    const onLoginRedirect = jest.fn();
    const onPaywall = jest.fn();
    const onFreeTierMode = jest.fn();
    const utils = render(
        <OnboardingScreen
            userId="u1"
            sessionUserId="u1"
            onLoginRedirect={onLoginRedirect}
            onComplete={onComplete}
            onPaywall={onPaywall}
            onFreeTierMode={onFreeTierMode}
        />,
    );
    return { ...utils, onComplete, onLoginRedirect, onPaywall, onFreeTierMode };
}

/**
 * Drain the gate's promise chain. Deliberately NOT `waitFor`: under fake timers
 * waitFor advances them itself, which would blow straight past the "the loading
 * state holds" assertion this suite exists to make.
 *
 * The tick budget is generous because the unresolvable path is now the LONGEST
 * one — timeout → readLastKnownTier() → readFirstOpenDismissed(), each a
 * separate awaited settings read.
 */
async function flush() {
    await act(async () => {
        for (let i = 0; i < 24; i++) await Promise.resolve();
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    gates.FREE_TIER_MODE_ENABLED = true;
    gates.DEV_FORCE_AI_ACCESS = null;
    mockIsConnected = true;
    mockSettings = { cached_user_id: 'u1' };
    mockServerAnswer = null;
    useSubscriptionStore.getState().reset();
});

describe('paywall before onboarding', () => {
    it('no active tier + no local facts → the paywall, NOT onboarding', async () => {
        mockServerAnswer = { subscriptionTier: 'none' };

        const { onPaywall, onFreeTierMode, onComplete, queryByTestId } = renderGate();
        await flush();

        expect(onPaywall).toHaveBeenCalledTimes(1);
        // The whole point: the wizard — whose step 2 is the Mera chat that 401s
        // without an entitlement — never mounts.
        expect(queryByTestId('onboarding-wizard')).toBeNull();
        expect(onFreeTierMode).not.toHaveBeenCalled();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('active tier + no local facts → onboarding, and no paywall', async () => {
        mockServerAnswer = { subscriptionTier: 'professional' };

        const { onPaywall, onFreeTierMode, queryByTestId } = renderGate();
        await flush();

        expect(queryByTestId('onboarding-wizard')).toBeTruthy();
        expect(onPaywall).not.toHaveBeenCalled();
        expect(onFreeTierMode).not.toHaveBeenCalled();
    });

    // An active TRIAL needs no handling of its own: the server's `resolveTier`
    // is period_type-agnostic, so a trialing user arrives here as a real tier
    // and takes the branch above. This pins that no code path special-cases it
    // back out again.
    it('a trialing user resolves to a real tier and is treated as active', async () => {
        mockServerAnswer = { subscriptionTier: 'starter' };

        const { onPaywall, queryByTestId } = renderGate();
        await flush();

        expect(queryByTestId('onboarding-wizard')).toBeTruthy();
        expect(onPaywall).not.toHaveBeenCalled();
    });

    // ── EXPECTATION CHANGED 2026-08-06 (owner decision) ─────────────────────
    //
    // This test used to assert that an expired wait falls through to
    // ONBOARDING, and the two decideOnboardingEntry cases at the bottom of this
    // file asserted the same thing. That was the DESIRED behaviour when the
    // gate was inert: "a timeout can never leave a user worse off than before
    // this change".
    //
    // It shipped, `FREE_TIER_MODE_ENABLED` flipped true, and the assumption
    // failed in production. With the gate armed, `'unknown'` is the state of
    // EVERY cold start before billing answers — not a rare degraded-network
    // case — so a slow server dropped brand-new users into the persona chat
    // (OnboardingWizard resumes at step 2 from the server's onboardingStage)
    // instead of the "Switch Mera on" paywall.
    //
    // The replacement rule is HOLD, THEN TRUST A LAST-KNOWN TIER: hold for the
    // same bounded window, then fall back to the tier this device last
    // resolved, and only a device that has NEVER resolved one lands on the
    // paywall. The "the paywall is useless offline" objection in the old
    // comment is answered by that fallback, not by handing the wizard to
    // everyone — see the two tests below.
    // ── AND CHANGED AGAIN IN r13 ────────────────────────────────────────────
    //
    // The HOLD is untouched and is still the thing worth pinning. What flips is
    // the destination once the hold ends: the server now grants every account a
    // free 14-day Starter window and enforces it itself, so a client that has
    // never heard from that server must not guess "locked" — that guess
    // paywalls precisely the new users the grant exists to convert. It fails
    // OPEN instead; an unentitled user meets a 402 and the free-tier UI catches
    // them on the next pass.
    it("aiAccess 'unknown' on a NEVER-RESOLVED device → the loading state holds, then fails OPEN to onboarding", async () => {
        jest.useFakeTimers();
        // The server never answers, so aiAccess stays 'unknown'...
        mockServerAnswer = null;
        // ...and this device has no tier on record. `beforeEach` seeds only
        // `cached_user_id`, so the absence here is the point.
        expect(mockSettings[LAST_KNOWN_TIER_SETTING_KEY]).toBeUndefined();

        const { onPaywall, onFreeTierMode, onComplete, queryByTestId } = renderGate();
        await flush();

        // The HOLD is unchanged: nothing is decided while the wait is running.
        // No lock flashed at a possible subscriber, no onboarding flashed at a
        // possible non-subscriber — just the existing spinner.
        expect(onPaywall).not.toHaveBeenCalled();
        expect(onFreeTierMode).not.toHaveBeenCalled();
        expect(onComplete).not.toHaveBeenCalled();
        expect(queryByTestId('onboarding-wizard')).toBeNull();
        expect(queryByTestId('onboarding-gate-spinner')).toBeTruthy();

        // Still holding well into the wait window.
        act(() => { jest.advanceTimersByTime(ONBOARDING_ENTITLEMENT_WAIT_MS - 1); });
        await flush();
        expect(onPaywall).not.toHaveBeenCalled();
        expect(queryByTestId('onboarding-wizard')).toBeNull();

        // And still BOUNDED — the hold ends rather than running forever.
        act(() => { jest.advanceTimersByTime(2); });
        await flush();
        expect(onPaywall).not.toHaveBeenCalled();
        expect(onFreeTierMode).not.toHaveBeenCalled();
        expect(queryByTestId('onboarding-wizard')).toBeTruthy();

        jest.useRealTimers();
    });

    // ── THE COLD-START RACE (r13). The reason the grant needed a client fix. ─
    //
    // RevenueCat answers from local cache in milliseconds; our GraphQL round
    // trip does not. An identified-but-EMPTY CustomerInfo makes `deriveAiAccess`
    // return 'locked' while `serverTier` is still null — and RevenueCat can
    // never know about the server's free 14-day Starter grant, because it is
    // derived from the account's creation date on our side.
    //
    // Before this fix that 'locked' short-circuited `resolveEntitlementForOnboarding`
    // on its FIRST statement: the paywall appeared and `syncEntitlement` was
    // never even called. Both halves are asserted below, and the second is the
    // one that fails if only `decideOnboardingEntry` is patched.
    it('a cached RevenueCat "locked" does NOT decide the route before our server answers', async () => {
        jest.useFakeTimers();
        // RevenueCat, about this user, with no entitlements — the exact payload
        // a granted (unpaid) user's device holds on every cold start.
        useSubscriptionStore.getState().setCustomerInfo({
            allPurchasedProductIdentifiers: [],
            entitlements: { active: {} },
        } as never);
        // The server WILL answer, with the grant applied — a shade too late.
        mockServerAnswer = { subscriptionTier: 'starter' };

        const { onPaywall, queryByTestId } = renderGate();
        await flush();

        // It held instead of routing, AND it actually asked the server.
        expect(onPaywall).not.toHaveBeenCalled();
        expect(mockSyncEntitlement).toHaveBeenCalledTimes(1);

        act(() => { jest.advanceTimersByTime(1); });
        await flush();

        expect(queryByTestId('onboarding-wizard')).toBeTruthy();
        expect(onPaywall).not.toHaveBeenCalled();

        jest.useRealTimers();
    });

    it('an unresolvable verdict trusts a last-known PAID tier → onboarding, offline and all', async () => {
        // The subscriber case. This device resolved 'professional' at some
        // earlier point; today the server is unreachable.
        mockSettings[LAST_KNOWN_TIER_SETTING_KEY] = 'professional';
        mockIsConnected = false;
        mockServerAnswer = null;

        const { onPaywall, onFreeTierMode, queryByTestId } = renderGate();
        await flush();

        expect(queryByTestId('onboarding-wizard')).toBeTruthy();
        expect(onPaywall).not.toHaveBeenCalled();
        expect(onFreeTierMode).not.toHaveBeenCalled();
        // Offline is answered from memory, so nothing is even attempted.
        expect(mockSyncEntitlement).not.toHaveBeenCalled();
    });

    // The companion to the offline case above, and the branch a real subscriber
    // on a SLOW network actually takes. `resolveEntitlementForOnboarding` has
    // two fallback exits — the early offline return and this one, after the
    // bounded wait expires — and only this test covers the second: delete the
    // post-timeout fallback and every other test in this file still passes.
    it('trusts a last-known PAID tier after the WAIT EXPIRES, not just when offline', async () => {
        jest.useFakeTimers();
        mockSettings[LAST_KNOWN_TIER_SETTING_KEY] = 'professional';
        // Connected, so the full wait is spent — and the server never answers.
        mockIsConnected = true;
        mockServerAnswer = null;

        const { onPaywall, onFreeTierMode, queryByTestId } = renderGate();
        await flush();

        // It really did hold: the answer is not being taken from memory early.
        expect(queryByTestId('onboarding-gate-spinner')).toBeTruthy();
        expect(queryByTestId('onboarding-wizard')).toBeNull();
        expect(mockSyncEntitlement).toHaveBeenCalledTimes(1);

        act(() => { jest.advanceTimersByTime(ONBOARDING_ENTITLEMENT_WAIT_MS + 1); });
        await flush();

        expect(queryByTestId('onboarding-wizard')).toBeTruthy();
        expect(onPaywall).not.toHaveBeenCalled();
        expect(onFreeTierMode).not.toHaveBeenCalled();

        jest.useRealTimers();
    });

    it('an unresolvable verdict trusts a last-known tier of "none" → the paywall, not the wizard', async () => {
        // 'none' IS a resolution — the server said this user has no plan — and
        // it must read as locked rather than as "never resolved".
        mockSettings[LAST_KNOWN_TIER_SETTING_KEY] = 'none';
        mockIsConnected = false;

        const { onPaywall, queryByTestId } = renderGate();
        await flush();

        expect(onPaywall).toHaveBeenCalledTimes(1);
        expect(queryByTestId('onboarding-wizard')).toBeNull();
    });

    it('a never-resolved OFFLINE device fails open without waiting', async () => {
        mockIsConnected = false;
        mockServerAnswer = null;

        const { onPaywall, queryByTestId } = renderGate();
        await flush();

        // No timers advanced: the offline branch still returns immediately
        // rather than holding the splash for a network known to be absent.
        // Its destination is now onboarding — a paywall is no more usable
        // offline than the wizard is, and the wizard is the one that does not
        // mis-accuse a granted user.
        expect(onPaywall).not.toHaveBeenCalled();
        expect(queryByTestId('onboarding-wizard')).toBeTruthy();
    });

    it("a DISMISSED device with an unresolvable verdict still fails open, and never loops to the paywall", async () => {
        // The anti-loop rule survives the r13 reversal, just by a shorter
        // route: `'unknown'` no longer reaches the dismissal branch at all, so
        // a user who said no once cannot meet the paywall again on a launch
        // where nothing answered.
        mockSettings[FIRST_OPEN_DISMISSED_SETTING_KEY] = 'true';
        mockIsConnected = false;
        mockServerAnswer = null;

        const { onPaywall, onFreeTierMode, queryByTestId } = renderGate();
        await flush();

        expect(onPaywall).not.toHaveBeenCalled();
        expect(onFreeTierMode).not.toHaveBeenCalled();
        expect(queryByTestId('onboarding-wizard')).toBeTruthy();
    });

    it('a resolved verdict is written to the device so a LATER cold start can trust it', async () => {
        mockServerAnswer = { subscriptionTier: 'professional' };

        renderGate();
        await flush();

        expect(mockSettings[LAST_KNOWN_TIER_SETTING_KEY]).toBe('professional');
    });

    it('the bounded wait survives a parent re-render with fresh handler identities', async () => {
        jest.useFakeTimers();
        // Never answers, so the whole wait window is spent holding.
        mockServerAnswer = null;

        const onPaywall = jest.fn();
        const onComplete = jest.fn();
        const onLoginRedirect = jest.fn();
        const onFreeTierMode = jest.fn();
        // Every render hands down BRAND-NEW function identities — exactly what
        // app/logged-in/onboarding.tsx did with plain inline handlers, and what
        // the better-auth session atom triggers at least twice on a cold start.
        const tree = () => (
            <OnboardingScreen
                userId="u1"
                sessionUserId="u1"
                onLoginRedirect={() => onLoginRedirect()}
                onComplete={() => onComplete()}
                onPaywall={() => onPaywall()}
                onFreeTierMode={() => onFreeTierMode()}
            />
        );

        const { rerender } = render(tree());
        await flush();
        expect(mockSyncEntitlement).toHaveBeenCalledTimes(1);

        for (let i = 0; i < 3; i++) {
            rerender(tree());
            await flush();
        }

        // STILL one. A torn-down effect sets `cancelled = true`, discards the
        // in-flight wait and re-enters resolveEntitlementForOnboarding, which
        // would fire these again — so the counts are a direct proof that the
        // original wait is still the one running.
        expect(mockSyncEntitlement).toHaveBeenCalledTimes(1);
        expect(require('@/lib/revenuecat').loginRevenueCat).toHaveBeenCalledTimes(1);

        // And it still terminates, on the ORIGINAL clock rather than one
        // restarted by the last re-render. (Destination is onboarding since
        // r13 — see the fail-open note above; what this test pins is that the
        // wait resolves ONCE, not where it lands.)
        act(() => { jest.advanceTimersByTime(ONBOARDING_ENTITLEMENT_WAIT_MS + 1); });
        await flush();
        expect(onComplete).not.toHaveBeenCalled();
        expect(onPaywall).not.toHaveBeenCalled();

        jest.useRealTimers();
    });

    it('dismissed + no tier → Mera News Free, onboarding skipped, no paywall loop', async () => {
        mockServerAnswer = { subscriptionTier: 'none' };
        mockSettings[FIRST_OPEN_DISMISSED_SETTING_KEY] = 'true';

        const { onPaywall, onFreeTierMode, onComplete, queryByTestId } = renderGate();
        await flush();

        expect(onFreeTierMode).toHaveBeenCalledTimes(1);
        // Not back to the paywall they just dismissed...
        expect(onPaywall).not.toHaveBeenCalled();
        // ...and not into onboarding either, whose chat cannot work here.
        expect(queryByTestId('onboarding-wizard')).toBeNull();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('dismissed THEN subscribed → onboarding proceeds (dismissal never strands them)', async () => {
        // The dismissal flag is still set from the earlier refusal — it is
        // device-local and permanent — but the tier is now real.
        mockSettings[FIRST_OPEN_DISMISSED_SETTING_KEY] = 'true';
        mockServerAnswer = { subscriptionTier: 'professional' };

        const { onPaywall, onFreeTierMode, queryByTestId } = renderGate();
        await flush();

        expect(queryByTestId('onboarding-wizard')).toBeTruthy();
        expect(onFreeTierMode).not.toHaveBeenCalled();
        expect(onPaywall).not.toHaveBeenCalled();
    });
});

describe('ship gate OFF (FREE_TIER_MODE_ENABLED = false — the state this commits in)', () => {
    it("behaves exactly as today: straight to onboarding, and doesn't even ask the server", async () => {
        gates.FREE_TIER_MODE_ENABLED = false;
        // Deliberately the state that WOULD lock a user with the gate on.
        mockServerAnswer = { subscriptionTier: 'none' };

        const { onPaywall, onFreeTierMode, queryByTestId } = renderGate();
        await flush();

        expect(queryByTestId('onboarding-wizard')).toBeTruthy();
        expect(onPaywall).not.toHaveBeenCalled();
        expect(onFreeTierMode).not.toHaveBeenCalled();
        // The zero-cost property: deriveAiAccess short-circuits to 'entitled',
        // so resolveEntitlementForOnboarding returns on its first statement —
        // no round trip, no store subscription, no added splash latency.
        expect(mockSyncEntitlement).not.toHaveBeenCalled();
    });

    it('the dev override still reaches the paywall with the ship gate off', async () => {
        // DEV_FORCE_AI_ACCESS sits ABOVE the ship gate, so the simulator harness
        // can drive this reorder before the flag flips.
        gates.FREE_TIER_MODE_ENABLED = false;
        gates.DEV_FORCE_AI_ACCESS = 'locked';

        const { onPaywall, queryByTestId } = renderGate();
        await flush();

        expect(onPaywall).toHaveBeenCalledTimes(1);
        expect(queryByTestId('onboarding-wizard')).toBeNull();
    });
});

describe('decideOnboardingEntry', () => {
    it('ONLY an entitled verdict opens the wizard', () => {
        expect(decideOnboardingEntry({ aiAccess: 'entitled', firstOpenDismissed: false })).toBe('onboarding');
        expect(decideOnboardingEntry({ aiAccess: 'entitled', firstOpenDismissed: true })).toBe('onboarding');
    });

    it('locked splits on the device-local dismissal', () => {
        expect(decideOnboardingEntry({ aiAccess: 'locked', firstOpenDismissed: false })).toBe('paywall');
        expect(decideOnboardingEntry({ aiAccess: 'locked', firstOpenDismissed: true })).toBe('free-tier');
    });

    // ── EXPECTATION CHANGED TWICE. Both reversals are deliberate. ───────────
    //
    // 2026-08-06 these moved from 'onboarding' to 'paywall': with the ship gate
    // armed, `'unknown'` was every cold start that had not heard from billing,
    // and sending those users into the wizard was a production regression.
    //
    // r13 moves them back, for a reason that did not exist then: the server now
    // GRANTS every account a free 14-day Starter window and enforces it
    // server-side. Two things follow. `'unknown'` is now narrower still — since
    // `resolveEntitlementForOnboarding` keys on OUR SERVER having answered, a
    // RevenueCat-derived 'locked' no longer masquerades as a resolution — and a
    // pessimistic guess is now the expensive one, because it paywalls exactly
    // the new users the grant exists to convert. Guessing 'onboarding' grants
    // no server content: an unentitled user meets a 402 and lands in the
    // free-tier UI on the next pass.
    it("'unknown' means our server has never answered → fail OPEN to onboarding", () => {
        expect(decideOnboardingEntry({ aiAccess: 'unknown', firstOpenDismissed: false })).toBe('onboarding');
        // Dismissal does not change it: 'unknown' is not a refusal to respect,
        // it is an absence of information, and the server is the enforcer.
        expect(decideOnboardingEntry({ aiAccess: 'unknown', firstOpenDismissed: true })).toBe('onboarding');
    });
});

describe('waitForAiAccessResolved', () => {
    beforeEach(() => useSubscriptionStore.getState().reset());

    it('resolves as soon as the store leaves unknown', async () => {
        const pending = waitForAiAccessResolved(60_000);
        useSubscriptionStore.getState().setServerBilling({ subscriptionTier: 'none' });
        await expect(pending).resolves.toBe('locked');
    });

    it('resolves immediately when the verdict is already known', async () => {
        useSubscriptionStore.getState().setServerBilling({ subscriptionTier: 'professional' });
        await expect(waitForAiAccessResolved(60_000)).resolves.toBe('entitled');
    });

    it('gives up with unknown when nothing ever answers', async () => {
        jest.useFakeTimers();
        const pending = waitForAiAccessResolved(ONBOARDING_ENTITLEMENT_WAIT_MS);
        jest.advanceTimersByTime(ONBOARDING_ENTITLEMENT_WAIT_MS);
        await expect(pending).resolves.toBe('unknown');
        jest.useRealTimers();
    });
});

export {};
