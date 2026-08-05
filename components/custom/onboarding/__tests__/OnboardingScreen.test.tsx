/* eslint-disable @typescript-eslint/no-require-imports */
// OnboardingScreen gate tests.
//
// The gate is LOCAL FACTS, never the server's onboardingStage:
//   - >=1 fact            → onComplete(), wizard never mounts
//   - 0 facts             → wizard, even when the server says FINISHED
//   - user switch         → clearPreviousUserData() runs BEFORE the count
//                           (`facts` is device-global, so a stale count would
//                           let user B skip onboarding on user A's device)
//   - local read failure  → wizard (never a persona-less feed)
// No AccountService / network call is involved at all.
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

// Decorative, and it drags in react-native-reanimated (no worklets runtime
// under Jest) — stub it out of the module graph entirely.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
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

// Records the interleaving of the wipe and the count so the ordering test can
// assert the wipe strictly precedes the count.
const callOrder: string[] = [];

const mockClearPreviousUserData = jest.fn(async () => { callOrder.push('clear'); });
const mockSetUserId = jest.fn((_id: string) => { callOrder.push('setUserId'); });
const mockSetNeedsReauth = jest.fn((_v: boolean) => { callOrder.push('setNeedsReauth'); });
jest.mock('@/lib/stores', () => ({
    clearPreviousUserData: (...args: any[]) => mockClearPreviousUserData(...(args as [])),
    useUserStore: {
        getState: () => ({ setUserId: mockSetUserId, setNeedsReauth: mockSetNeedsReauth }),
    },
}));

const mockHasAnyFacts = jest.fn(async () => { callOrder.push('count'); return false; });
jest.mock('@/lib/database/services/fact-service', () => ({
    hasAnyFacts: () => mockHasAnyFacts(),
}));

// The identity gate itself is exhaustively tested in
// lib/security/__tests__/identity-gate.test.ts — here we only pin the WIRING:
// which verdict produces which action, and in what order.
const mockResolveIdentity = jest.fn(() => 'wipeAndProceed' as string);
const mockHasIdentityFault = jest.fn(async () => false);
jest.mock('@/lib/security/identity-gate', () => ({
    resolveIdentity: (...a: any[]) => mockResolveIdentity(...(a as [])),
    hasIdentityFault: () => mockHasIdentityFault(),
}));

const mockGetSetting = jest.fn(async (_k: string): Promise<string | null> => 'u1');
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => mockGetSetting(k),
}));

const mockProbeServerReachable = jest.fn(async () => true);
jest.mock('@/lib/stores/network-store', () => ({
    useNetworkStore: { getState: () => ({ isConnected: true }) },
    probeServerReachable: () => mockProbeServerReachable(),
}));

// The pre-onboarding paywall gate is stubbed to its pass-through verdict here
// so this suite stays about FACTS and IDENTITY. Its real graph reaches
// react-native-purchases and Apollo, neither of which can be constructed in this
// environment, and its own behaviour is covered end-to-end (with the real
// feature-gates → ai-access → store chain) in
// components/custom/subscription/__tests__/onboarding-paywall-order.test.tsx.
const mockResolveEntitlement = jest.fn(async () => 'entitled' as string);
const mockDecideEntry = jest.fn(() => 'onboarding' as string);
jest.mock('@/lib/subscription/onboarding-paywall', () => ({
    resolveEntitlementForOnboarding: (...a: any[]) => mockResolveEntitlement(...(a as [])),
    decideOnboardingEntry: (...a: any[]) => mockDecideEntry(...(a as [])),
}));
jest.mock('@/lib/subscription/first-open-dismissal', () => ({
    FIRST_OPEN_DISMISSED_SETTING_KEY: 'companion_first_open_dismissed',
    readFirstOpenDismissed: jest.fn(async () => false),
}));

import OnboardingScreen from '../OnboardingScreen';

beforeEach(() => {
    jest.clearAllMocks();
    callOrder.length = 0;
    mockClearPreviousUserData.mockImplementation(async () => { callOrder.push('clear'); });
    mockSetUserId.mockImplementation((_id: string) => { callOrder.push('setUserId'); });
    mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return false; });
    mockResolveIdentity.mockReturnValue('wipeAndProceed');
    mockHasIdentityFault.mockResolvedValue(false);
    mockGetSetting.mockResolvedValue('u1');
    mockProbeServerReachable.mockResolvedValue(true);
    mockResolveEntitlement.mockResolvedValue('entitled');
    mockDecideEntry.mockReturnValue('onboarding');
});

// `userId` is the EFFECTIVE owner (session ?? cached); `sessionUserId` is the
// live session id and is undefined when offline. They are separate props on
// purpose — see the prop docs on OnboardingScreen.
function renderScreen(
    onComplete = jest.fn(),
    onLoginRedirect = jest.fn(),
    props: { userId?: string; sessionUserId?: string } = {},
) {
    const onPaywall = jest.fn();
    const onCompanionMode = jest.fn();
    const utils = render(
        <OnboardingScreen
            userId={props.userId ?? 'u1'}
            sessionUserId={'sessionUserId' in props ? props.sessionUserId : 'u1'}
            onLoginRedirect={onLoginRedirect}
            onComplete={onComplete}
            onPaywall={onPaywall}
            onCompanionMode={onCompanionMode}
        />,
    );
    return { ...utils, onComplete, onLoginRedirect, onPaywall, onCompanionMode };
}

describe('OnboardingScreen fact gate', () => {
    it('shows the wizard when the user has 0 local facts (server stage is irrelevant)', async () => {
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return false; });
        const { queryByTestId, onComplete } = renderScreen();

        await waitFor(() => expect(queryByTestId('onboarding-wizard')).toBeTruthy());
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('calls onComplete without mounting the wizard when the user has >=1 fact', async () => {
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return true; });
        const { queryByTestId, onComplete } = renderScreen();

        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(queryByTestId('onboarding-wizard')).toBeNull();
    });

    it('keeps the spinner up while handing off to onComplete (no blank flash)', async () => {
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return true; });
        const { queryByTestId, onComplete } = renderScreen();

        await waitFor(() => expect(onComplete).toHaveBeenCalled());
        expect(queryByTestId('onboarding-gate-spinner')).toBeTruthy();
    });

    it('wipes a previous user\'s data, stamps the new owner, THEN counts facts', async () => {
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return true; });
        renderScreen();

        await waitFor(() => expect(mockHasAnyFacts).toHaveBeenCalled());
        expect(mockClearPreviousUserData).toHaveBeenCalledWith('u1');
        // setUserId writes `cached_user_id`, the sentinel clearPreviousUserData
        // keys off. Nothing else on the fresh-login path writes it, so without
        // this stamp the wipe is a permanent no-op for a user who logged in but
        // never cold-started — and the next user inherits their facts.
        expect(mockSetUserId).toHaveBeenCalledWith('u1');
        expect(callOrder).toEqual(['clear', 'setUserId', 'count']);
    });

    it('still counts facts when the wipe throws (a broken wipe must not strand the user)', async () => {
        mockClearPreviousUserData.mockImplementation(async () => { throw new Error('db locked'); });
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return true; });
        const { onComplete } = renderScreen();

        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    });

    it('shows the wizard when the local fact count throws', async () => {
        mockHasAnyFacts.mockImplementation(async () => { throw new Error('db unreadable'); });
        const { queryByTestId, onComplete } = renderScreen();

        await waitFor(() => expect(queryByTestId('onboarding-wizard')).toBeTruthy());
        expect(onComplete).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Identity-gate wiring
// ---------------------------------------------------------------------------

describe('OnboardingScreen identity gate', () => {
    it('reads the on-disk owner BEFORE the wipe can delete it', async () => {
        renderScreen();
        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockGetSetting).toHaveBeenCalledWith('cached_user_id');
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ sessionUserId: 'u1', cachedUserId: 'u1' }),
        );
    });

    it('reauth verdict → routes to the reauth login and never reads facts', async () => {
        mockResolveIdentity.mockReturnValue('reauth');
        const { onLoginRedirect, onComplete, queryByTestId } = renderScreen();

        await waitFor(() => expect(onLoginRedirect).toHaveBeenCalledTimes(1));
        expect(mockClearPreviousUserData).not.toHaveBeenCalled();
        expect(mockSetUserId).not.toHaveBeenCalled();
        expect(mockHasAnyFacts).not.toHaveBeenCalled();
        expect(onComplete).not.toHaveBeenCalled();
        expect(queryByTestId('onboarding-wizard')).toBeNull();
    });

    it('coherent verdict → stamps the owner but skips the wipe', async () => {
        mockResolveIdentity.mockReturnValue('coherent');
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return true; });
        const { onComplete } = renderScreen();

        await waitFor(() => expect(onComplete).toHaveBeenCalled());
        expect(mockClearPreviousUserData).not.toHaveBeenCalled();
        expect(mockSetUserId).toHaveBeenCalledWith('u1');
    });

    it('passes the observed ownership fault into the verdict', async () => {
        mockHasIdentityFault.mockResolvedValue(true);
        renderScreen();
        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ ownershipFault: true, isConnected: true }),
        );
    });

    // ── server-reachability probe ────────────────────────────────────────
    it('probes reachability ONLY on the fault path (no round-trip on the happy path)', async () => {
        renderScreen();
        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockProbeServerReachable).not.toHaveBeenCalled();
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ serverReachable: undefined }),
        );
    });

    it('feeds the probe result into the verdict when a fault is present', async () => {
        mockHasIdentityFault.mockResolvedValue(true);
        mockProbeServerReachable.mockResolvedValue(false);
        renderScreen();

        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockProbeServerReachable).toHaveBeenCalledTimes(1);
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ ownershipFault: true, serverReachable: false }),
        );
    });

    it('keeps needsReauth set when a fault is deferred, so no server task runs', async () => {
        // Deferring the eject must not leave background work ungated: the
        // scheduler's auth pre-flight is what actually halts feed-sync, and it
        // keys off needsReauth.
        mockHasIdentityFault.mockResolvedValue(true);
        mockProbeServerReachable.mockResolvedValue(false);
        mockResolveIdentity.mockReturnValue('coherent');
        renderScreen();

        await waitFor(() => expect(mockSetNeedsReauth).toHaveBeenCalledWith(true));
        // Ordering: the wipe resets the user store, so the flag must be set
        // AFTER it or it would be zeroed again.
        expect(callOrder.indexOf('setNeedsReauth')).toBeGreaterThan(
            callOrder.indexOf('setUserId'),
        );
    });

    it('does not touch needsReauth when there is no fault', async () => {
        renderScreen();
        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockSetNeedsReauth).not.toHaveBeenCalled();
    });

    // ── the prop split ───────────────────────────────────────────────────
    // The caller coalesces `session ?? cached` into `userId` so this screen
    // works offline. If that coalesced value were ALSO passed as sessionUserId,
    // resolveIdentity would compare the local id against itself and the
    // fresh-login cross-user wipe would silently never fire again.
    it('passes the LIVE session id as sessionUserId, not the coalesced owner', async () => {
        renderScreen(jest.fn(), jest.fn(), { userId: 'local-owner', sessionUserId: 'live-session' });

        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ sessionUserId: 'live-session', cachedUserId: 'u1' }),
        );
    });

    it('reports an absent session as undefined (the offline path), not as the local id', async () => {
        renderScreen(jest.fn(), jest.fn(), { userId: 'local-owner', sessionUserId: undefined });

        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ sessionUserId: undefined }),
        );
        // ...while the wipe/stamp still target the effective owner.
        expect(mockSetUserId).toHaveBeenCalledWith('local-owner');
    });
});
