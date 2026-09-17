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
import { act, render } from '@testing-library/react-native';
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
const mockReplace = jest.fn();
let mockParams: Record<string, string | undefined> = {};
jest.mock('expo-router', () => ({
    Redirect: ({ href }: any) => { mockRedirect(href); return null; },
    router: { replace: (href: string) => mockReplace(href) },
    useLocalSearchParams: () => mockParams,
}));

let mockSession: any = null;
let mockIsPending = false;
jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: mockSession, isPending: mockIsPending }) },
}));

// Capture onLoginSuccess so the reauth tests can drive the handler directly.
// Outside reauth mode the route passes `undefined`, which is itself asserted.
let mockOnLoginSuccess: ((userId: string) => void) | undefined;
jest.mock('@/components/custom/auth/AuthScreen', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: (props: any) => {
            mockOnLoginSuccess = props.onLoginSuccess;
            return <View testID="auth-screen" />;
        },
    };
});
jest.mock('@/components/custom/ErrorBoundary', () => ({ __esModule: true, default: ({ children }: any) => children }));
jest.mock('@/components/custom/ErrorFallback', () => ({ FullScreenErrorFallback: () => null }));
const mockGetSetting = jest.fn(async (_k: string): Promise<string | null> => null);
jest.mock('@/lib/database/services/setting-service', () => ({ getSetting: (k: string) => mockGetSetting(k) }));

// Stable across getState() calls — the old inline `jest.fn()` minted a fresh spy
// per call, so nothing could be asserted about them.
const mockClearPin = jest.fn(async () => {});
const mockSetPinSet = jest.fn();
const mockSetLockEnabled = jest.fn(async () => {});
jest.mock('@/lib/security/pin-service', () => ({ clearPin: () => mockClearPin() }));
jest.mock('@/lib/stores/pin-store', () => ({
    usePinStore: {
        getState: () => ({ setPinSet: mockSetPinSet, setLockEnabled: mockSetLockEnabled }),
    },
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { debug: jest.fn() } }));

import LoginScreen from '../login';

beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    mockSession = null;
    mockIsPending = false;
    mockOnLoginSuccess = undefined;
    mockGetSetting.mockResolvedValue(null);
});

/** Render in reauth mode and fire a successful OTP verify for `userId`. */
async function reauthWith(reauth: string, userId: string, cachedUserId: string | null) {
    mockParams = { reauth };
    mockGetSetting.mockResolvedValue(cachedUserId);
    render(<LoginScreen />);
    expect(mockOnLoginSuccess).toBeDefined();
    await act(async () => { mockOnLoginSuccess!(userId); });
}

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

// ── The reauth destination (app/login.tsx handleReauthSuccess) ───────────────
//
// This branched on identity ALONE until 2026-09-17, so every same-user reauth
// landed on /pin-setup. Only one of the four reauth producers is about the PIN:
//
//   app/pin-lock.tsx (Forgot PIN)                    → reauth=pin → /pin-setup
//   components/custom/ReauthBanner.tsx               → reauth=1   → /logged-in
//   app/logged-in/index.tsx (identity gate)          → reauth=1   → /logged-in
//   .../onboarding/OnboardingScreen.tsx → onboarding → reauth=1   → /logged-in
//
// The three `reauth=1` producers enrolled users who had never opted into the
// lock, and completing that setup persisted the opt-in so the launch gate then
// locked them out on every cold start. mera-app-persona invariant 7.
describe('login route — reauth destination', () => {
    it('Forgot PIN (reauth=pin), same user → /pin-setup with the PIN cleared', async () => {
        await reauthWith('pin', 'u1', 'u1');

        expect(mockReplace).toHaveBeenCalledWith('/pin-setup');
        expect(mockClearPin).toHaveBeenCalled();
        expect(mockSetPinSet).toHaveBeenCalledWith(false);
        // The opt-in stands — they chose the lock, they are replacing the PIN.
        expect(mockSetLockEnabled).not.toHaveBeenCalled();
    });

    it('banner reauth (reauth=1), same user → /logged-in and the PIN is UNTOUCHED', async () => {
        await reauthWith('1', 'u1', 'u1');

        expect(mockReplace).toHaveBeenCalledWith('/logged-in');
        // The regression. /pin-setup here is what enrolled users who never
        // opted in, and it is also what completing setup made permanent.
        expect(mockReplace).not.toHaveBeenCalledWith('/pin-setup');
        // clearPin ran BEFORE the branch decision, so a user who genuinely had
        // a PIN and then cancelled out of setup lost it silently. Both halves
        // of "untouched" are pinned, because either one alone is still a bug.
        expect(mockClearPin).not.toHaveBeenCalled();
        expect(mockSetPinSet).not.toHaveBeenCalled();
        expect(mockSetLockEnabled).not.toHaveBeenCalled();
    });

    it('a different user → /logged-in with the lock turned off first', async () => {
        // clearAllStores does not touch the keychain, so without this the new
        // user meets the previous user's PIN screen on the next cold start.
        await reauthWith('1', 'u2', 'u1');

        expect(mockSetLockEnabled).toHaveBeenCalledWith(false);
        expect(mockReplace).toHaveBeenCalledWith('/logged-in');
        expect(mockReplace).not.toHaveBeenCalledWith('/pin-setup');
    });

    it('a different user on reauth=pin also goes to /logged-in, never to setup', async () => {
        // Identity is checked FIRST: arriving from Forgot PIN does not license
        // resetting a PIN that belongs to whoever was signed in before.
        await reauthWith('pin', 'u2', 'u1');

        expect(mockSetLockEnabled).toHaveBeenCalledWith(false);
        expect(mockReplace).toHaveBeenCalledWith('/logged-in');
        expect(mockReplace).not.toHaveBeenCalledWith('/pin-setup');
        expect(mockClearPin).not.toHaveBeenCalled();
    });

    it('no cached user at all → /logged-in, never to setup', async () => {
        await reauthWith('1', 'u1', null);

        expect(mockReplace).toHaveBeenCalledWith('/logged-in');
        expect(mockReplace).not.toHaveBeenCalledWith('/pin-setup');
    });

    it('reauth=pin still counts as reauth mode, so the session shortcut stays off', () => {
        // If reauthMode missed 'pin', the Redirect would fire on the live
        // session and bounce Forgot PIN straight back into the app — the PIN
        // would be unresettable. This is why reauthMode ORs the two values.
        mockSession = { user: { id: 'u1' } };
        mockParams = { reauth: 'pin' };
        render(<LoginScreen />);
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('outside reauth mode AuthScreen gets no onLoginSuccess at all', () => {
        render(<LoginScreen />);
        expect(mockOnLoginSuccess).toBeUndefined();
    });
});
