/* eslint-disable @typescript-eslint/no-require-imports */
// The login route's session shortcut (app/login.tsx).
//
// A live session normally means "already logged in, go to the app". That is
// wrong for exactly one window: right after an explicit logout. better-auth
// does not clear its session atom synchronously on signOut() — it toggles
// $sessionSignal on a 10ms timer and only nulls `data` once /get-session
// round-trips — so without `signedOut: '1'` the shortcut fires on the stale
// session and bounces the user straight back into the account they just left
// (and app/logged-in/index.tsx then re-writes `cached_user_id` and re-identifies
// them to RevenueCat).
//
// ── DESTINATION CHANGED 2026-08-06 (owner decision) ─────────────────────────
//
// The shortcut used to target `/logged-in/onboarding` directly, and the
// assertions below pinned that. It was a bypass: better-auth is allowed to serve
// this session atom stale, and jumping to the onboarding route skipped every
// gate in `app/logged-in/index.tsx` — the session↔local identity check and its
// cross-user wipe, the local-fact check that decides whether onboarding is owed
// at all, and the entitlement resolution that decides paywall vs wizard. It now
// targets `/logged-in`, so this path resolves like every other entry. The
// suppression contract itself is unchanged, and is still what these tests are
// mainly about.
//
// The suppression MUST release. Outside reauth mode AuthScreen gets no
// onLoginSuccess, so this Redirect is the ONLY thing that moves a freshly
// logged-in user off the screen — a permanent suppression would strand them.
import { render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

const mockRedirect = jest.fn();
let mockParams: Record<string, string | undefined> = {};
jest.mock('expo-router', () => ({
    Redirect: ({ href }: any) => { mockRedirect(href); return null; },
    router: { replace: jest.fn() },
    useLocalSearchParams: () => mockParams,
}));

let mockSession: any = null;
let mockIsPending = false;
jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: mockSession, isPending: mockIsPending }) },
}));

jest.mock('@/components/custom/auth/AuthScreen', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="auth-screen" /> };
});
jest.mock('@/components/custom/ErrorBoundary', () => ({ __esModule: true, default: ({ children }: any) => children }));
jest.mock('@/components/custom/ErrorFallback', () => ({ FullScreenErrorFallback: () => null }));
jest.mock('@/lib/database/services/setting-service', () => ({ getSetting: jest.fn(async () => null) }));
jest.mock('@/lib/security/pin-service', () => ({ clearPin: jest.fn(async () => {}) }));
jest.mock('@/lib/stores/pin-store', () => ({
    usePinStore: { getState: () => ({ setPinSet: jest.fn(), setLockEnabled: jest.fn(async () => {}) }) },
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { debug: jest.fn() } }));

import LoginScreen from '../login';

beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    mockSession = null;
    mockIsPending = false;
});

describe('login route — session shortcut', () => {
    it('a live session short-circuits to /logged-in — the gate, never past it', () => {
        mockSession = { user: { id: 'u1' } };
        render(<LoginScreen />);
        expect(mockRedirect).toHaveBeenCalledWith('/logged-in');
        // Pinned as an exclusion so the bypass cannot come back by accident:
        // /logged-in/onboarding is downstream of the identity, local-fact and
        // entitlement checks, and this route knows none of them.
        expect(mockRedirect).not.toHaveBeenCalledWith('/logged-in/onboarding');
    });

    it('reauth mode never short-circuits (OTP must re-prove identity)', () => {
        mockSession = { user: { id: 'u1' } };
        mockParams = { reauth: '1' };
        render(<LoginScreen />);
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('signedOut:"1" suppresses the shortcut while the session atom is still stale', () => {
        mockSession = { user: { id: 'u1' } };
        mockParams = { signedOut: '1' };
        const { getByTestId } = render(<LoginScreen />);

        expect(mockRedirect).not.toHaveBeenCalled();
        getByTestId('auth-screen');
    });

    it('isPending cannot substitute — it stays false through the stale window', () => {
        // better-auth's onRequest sets isPending from `data === null`, so with
        // stale non-null data it is false for the whole refetch. Asserted so a
        // future "just check isPending" simplification fails here.
        mockSession = { user: { id: 'u1' } };
        mockIsPending = false;
        mockParams = { signedOut: '1' };
        render(<LoginScreen />);
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('releases the suppression once the session clears, so a fresh login still redirects', () => {
        mockSession = { user: { id: 'u1' } };
        mockParams = { signedOut: '1' };
        const { rerender } = render(<LoginScreen />);
        expect(mockRedirect).not.toHaveBeenCalled();

        // /get-session finally lands: the stale session becomes null.
        mockSession = null;
        rerender(<LoginScreen />);
        expect(mockRedirect).not.toHaveBeenCalled();

        // The user logs back in on this very screen. Without the release above
        // they would be stranded here — nothing else navigates away.
        mockSession = { user: { id: 'u2' } };
        rerender(<LoginScreen />);
        expect(mockRedirect).toHaveBeenCalledWith('/logged-in');
    });
});
