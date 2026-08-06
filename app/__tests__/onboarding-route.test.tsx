/* eslint-disable @typescript-eslint/no-require-imports */
// app/logged-in/onboarding.tsx — routing only.
//
// The one assertion that matters: `onLoginRedirect` (the escape hatch the
// identity gate pulls when session and local identity are unresolvably out of
// sync) must navigate to /login WITH reauth:'1'. login.tsx:23 redirects any
// live session straight back to /logged-in/onboarding unless reauthMode is on,
// so a missing param turns the recovery path into an infinite bounce.
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/ErrorBoundary', () => ({ __esModule: true, default: ({ children }: any) => children }));
jest.mock('@/components/custom/ErrorFallback', () => ({ FullScreenErrorFallback: () => null }));
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
    router: { replace: (...a: any[]) => mockReplace(...a) },
    Redirect: () => null,
}));

let mockSession: any = { user: { id: 'u1' } };
jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => ({ data: mockSession, isPending: false }) } }));

// The route now reads `cached_user_id` directly — identity is a LOCAL fact, so
// a dead/slow session can no longer eject the user. Mock the settings read (and
// with it the WatermelonDB singleton the real module instantiates at import).
let mockCachedUserId: string | null = 'cached-u1';
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: jest.fn(async () => mockCachedUserId),
}));

// Stand-in for the gate: immediately pulls whichever escape hatch the test asks
// for, so the route's handlers are exercised without the real gate's DB reads.
let mockInvoke: 'login' | 'complete' | 'paywall' | 'free-tier' | null = null;
jest.mock('@/components/custom/onboarding/OnboardingScreen', () => {
    const React2 = require('react');
    const GateStub = ({ onLoginRedirect, onComplete, onPaywall, onFreeTierMode }: any) => {
        React2.useEffect(() => {
            if (mockInvoke === 'login') onLoginRedirect();
            if (mockInvoke === 'complete') onComplete();
            if (mockInvoke === 'paywall') onPaywall();
            if (mockInvoke === 'free-tier') onFreeTierMode();
        }, [onLoginRedirect, onComplete, onPaywall, onFreeTierMode]);
        return null;
    };
    return { __esModule: true, default: GateStub };
});

// The route hands the paywall escape hatch to navigateToPaywall() rather than
// issuing its own replace — that function owns the in-flight guard that stops
// two near-simultaneous triggers stacking two paywall screens.
const mockNavigateToPaywall = jest.fn();
jest.mock('@/lib/nav-state', () => ({ navigateToPaywall: (...a: any[]) => mockNavigateToPaywall(...a) }));

import Onboarding from '../logged-in/onboarding';

beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { user: { id: 'u1' } };
    mockCachedUserId = 'cached-u1';
    mockInvoke = null;
});

describe('onboarding route', () => {
    it('onLoginRedirect navigates to /login WITH reauth:"1"', async () => {
        mockInvoke = 'login';
        render(<Onboarding />);

        await waitFor(() => expect(mockReplace).toHaveBeenCalled());
        expect(mockReplace).toHaveBeenCalledWith({
            pathname: '/login',
            params: { reauth: '1' },
        });
    });

    it('onComplete navigates to the dashboard with fromOnboarding', async () => {
        mockInvoke = 'complete';
        render(<Onboarding />);

        await waitFor(() => expect(mockReplace).toHaveBeenCalled());
        expect(mockReplace).toHaveBeenCalledWith({
            pathname: '/logged-in/app_container/for_you',
            params: { fromOnboarding: '1' },
        });
    });

    it('onPaywall goes through navigateToPaywall in its DEFAULT mode', async () => {
        mockInvoke = 'paywall';
        render(<Onboarding />);

        await waitFor(() => expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1));
        // No 'lapsed' argument: this is the primary conversion moment and
        // deliberately gets the screen's auto-presented purchase sheet.
        expect(mockNavigateToPaywall).toHaveBeenCalledWith();
        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('onFreeTierMode lands on the FEED, not the fromOnboarding dashboard', async () => {
        mockInvoke = 'free-tier';
        render(<Onboarding />);

        // fromOnboarding:'1' would be a claim about a wizard that never ran.
        await waitFor(() =>
            expect(mockReplace).toHaveBeenCalledWith('/logged-in/app_container/feed'),
        );
        expect(mockNavigateToPaywall).not.toHaveBeenCalled();
    });

    // ── local-first identity ─────────────────────────────────────────────
    // The bug this route caused: a failed/slow /get-session settles with
    // `session === undefined`, the old `if (!session) return <Redirect
    // href="/login"/>` fired, and login.tsx rendered PreviousUserView — the
    // "Welcome back" screen — at a user who was perfectly signed in.
    it('mounts the gate from the CACHED owner when the session is missing', async () => {
        mockSession = undefined;
        const { UNSAFE_getByType } = render(<Onboarding />);

        await waitFor(() => {
            const gate = UNSAFE_getByType(
                require('@/components/custom/onboarding/OnboardingScreen').default,
            );
            expect(gate.props.userId).toBe('cached-u1');
        });
    });

    it('reports the missing session as undefined rather than faking it from the cache', async () => {
        // Load-bearing: if the coalesced owner were also passed as sessionUserId,
        // resolveIdentity would compare the local id against itself and the
        // cross-user wipe would never fire again.
        mockSession = undefined;
        const { UNSAFE_getByType } = render(<Onboarding />);

        await waitFor(() => {
            const gate = UNSAFE_getByType(
                require('@/components/custom/onboarding/OnboardingScreen').default,
            );
            expect(gate.props.sessionUserId).toBeUndefined();
        });
    });

    it('prefers the live session id over the cached one when both exist', async () => {
        mockSession = { user: { id: 'live-u9' } };
        const { UNSAFE_getByType } = render(<Onboarding />);

        await waitFor(() => {
            const gate = UNSAFE_getByType(
                require('@/components/custom/onboarding/OnboardingScreen').default,
            );
            expect(gate.props.userId).toBe('live-u9');
            expect(gate.props.sessionUserId).toBe('live-u9');
        });
    });

    it('never ejects to /login on a session failure alone', async () => {
        mockSession = undefined;
        render(<Onboarding />);

        // Give the async identity resolution a chance to settle.
        await waitFor(() => expect(mockReplace).not.toHaveBeenCalled());
    });
});
