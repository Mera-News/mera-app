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
}));
jest.mock('@/lib/stores/network-store', () => ({
    useNetworkStore: { getState: () => ({ isConnected: mockIsConnected }) },
    probeServerReachable: async () => true,
}));
let mockIsConnected = true;

// Zero facts on every test in this file: the paywall gate is only reachable on
// the "about to onboard" path, which is what all six cases are about.
jest.mock('@/lib/database/services/fact-service', () => ({ hasAnyFacts: async () => false }));

// Keyed so `cached_user_id` and the first-open dismissal flag can be driven
// independently — the dismissal cases turn on exactly that second key.
let mockSettings: Record<string, string | null> = {};
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: jest.fn(async (k: string) => mockSettings[k] ?? null),
    setSetting: jest.fn(async () => {}),
}));

// ── native / network leaves ────────────────────────────────────────────────
// Stubbing this keeps react-native-purchases out of the graph while leaving the
// REAL subscription store (and therefore the real deriveAiAccess) in it.
jest.mock('@/lib/revenuecat', () => ({
    getActiveTier: () => null,
    loginRevenueCat: jest.fn(async () => null),
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
 */
async function flush() {
    await act(async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
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

    it("aiAccess 'unknown' → neither paywall nor onboarding; the loading state holds", async () => {
        jest.useFakeTimers();
        // The server never answers, so aiAccess stays 'unknown'.
        mockServerAnswer = null;

        const { onPaywall, onFreeTierMode, onComplete, queryByTestId } = renderGate();
        await flush();

        // NEITHER. No lock flashed at a possible subscriber, no onboarding
        // flashed at a possible non-subscriber — just the existing spinner.
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

        // Documented timeout fallback: an unresolvable verdict lands on today's
        // behaviour (onboarding) rather than a paywall the user could not buy
        // from anyway. See decideOnboardingEntry's comment.
        act(() => { jest.advanceTimersByTime(2); });
        await flush();
        expect(queryByTestId('onboarding-wizard')).toBeTruthy();
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
    it('only a locked verdict can divert; entitled always onboards', () => {
        expect(decideOnboardingEntry({ aiAccess: 'entitled', firstOpenDismissed: false })).toBe('onboarding');
        expect(decideOnboardingEntry({ aiAccess: 'entitled', firstOpenDismissed: true })).toBe('onboarding');
    });

    it('locked splits on the device-local dismissal', () => {
        expect(decideOnboardingEntry({ aiAccess: 'locked', firstOpenDismissed: false })).toBe('paywall');
        expect(decideOnboardingEntry({ aiAccess: 'locked', firstOpenDismissed: true })).toBe('free-tier');
    });

    it("an expired wait ('unknown') falls back to today's behaviour, never to a paywall", () => {
        expect(decideOnboardingEntry({ aiAccess: 'unknown', firstOpenDismissed: false })).toBe('onboarding');
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
