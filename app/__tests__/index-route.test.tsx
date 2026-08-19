/* eslint-disable @typescript-eslint/no-require-imports */
// The launch gate (app/index.tsx).
//
// THE RULE: offline mode is served IF AND ONLY IF the local credentials have
// NOT been cleared.
//   - credentials present (incl. a dead server session) → into the app, and
//     NOTHING is wiped. This is the r7 offline-first behaviour and the case that
//     must never regress.
//   - credentials provably gone but data still on disk → an interrupted logout;
//     finish it before any screen can read that data, then /login.
//   - credentials UNREADABLE (locked keychain) → /login, but never a wipe.
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

const mockRedirect = jest.fn();
jest.mock('expo-router', () => ({ Redirect: ({ href }: any) => { mockRedirect(href); return null; } }));

let mockSession: any = null;
jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => ({ data: mockSession }) } }));

let mockIdentityState = 'absent';
jest.mock('@/lib/security/launch-route', () => ({
    readLocalIdentityState: async () => mockIdentityState,
    resolveLaunchRoute: ({ hasIdentity }: any) => (hasIdentity ? '/logged-in' : '/login'),
}));

const mockPurge = jest.fn(async () => true);
jest.mock('@/lib/security/local-wipe', () => ({ purgeOrphanedLocalData: () => mockPurge() }));

const mockEnforceBoundary = jest.fn(async () => {});
let mockBoundaryReset = false;
jest.mock('@/lib/security/install-boundary', () => ({
    enforceInstallBoundary: () => mockEnforceBoundary(),
    wasInstallBoundaryReset: () => mockBoundaryReset,
}));

const mockPinInit = jest.fn(async () => {});
let mockPinState = { initialized: true, pinSet: false, lockEnabled: false, locked: false };
jest.mock('@/lib/stores/pin-store', () => ({
    usePinStore: { getState: () => ({ ...mockPinState, init: mockPinInit }) },
}));

import Index from '../index';

beforeEach(() => {
    jest.clearAllMocks();
    mockSession = null;
    mockIdentityState = 'absent';
    mockBoundaryReset = false;
    mockPinState = { initialized: true, pinSet: false, lockEnabled: false, locked: false };
});

const renderGate = () => render(<Index />);

describe('launch gate — offline mode iff credentials survive', () => {
    it('session expiry: credentials present → /logged-in and NOTHING is wiped', async () => {
        // The one case that must keep serving offline mode. A dead server
        // session leaves `cached_user_id` (and the cookie) on the device.
        mockIdentityState = 'present';
        renderGate();

        await waitFor(() => expect(mockRedirect).toHaveBeenCalledWith('/logged-in'));
        expect(mockPurge).not.toHaveBeenCalled();
    });

    it('after logout: credentials absent → orphaned data is wiped, then /login', async () => {
        mockIdentityState = 'absent';
        renderGate();

        await waitFor(() => expect(mockRedirect).toHaveBeenCalledWith('/login'));
        expect(mockPurge).toHaveBeenCalledTimes(1);
    });

    it('the wipe completes BEFORE the redirect renders, so no screen reads stale data', async () => {
        mockIdentityState = 'absent';
        let purgeResolved = false;
        mockPurge.mockImplementation(async () => {
            await Promise.resolve();
            purgeResolved = true;
            return true;
        });
        renderGate();

        await waitFor(() => expect(mockRedirect).toHaveBeenCalled());
        expect(purgeResolved).toBe(true);
    });

    it('unreadable keychain (unknown) → /login but NEVER a wipe', async () => {
        // Cold start before the device's first unlock. Routing to /login is
        // recoverable by signing in; destroying the library is not.
        mockIdentityState = 'unknown';
        renderGate();

        await waitFor(() => expect(mockRedirect).toHaveBeenCalledWith('/login'));
        expect(mockPurge).not.toHaveBeenCalled();
    });

    it('a live session with no persisted identity yet is not treated as orphaned', async () => {
        // Fresh login, before /logged-in has written `cached_user_id`. Wiping
        // here would delete the account the user just signed into.
        mockIdentityState = 'absent';
        mockSession = { user: { id: 'u1' } };
        renderGate();

        await waitFor(() => expect(mockRedirect).toHaveBeenCalledWith('/logged-in'));
        expect(mockPurge).not.toHaveBeenCalled();
    });


});

describe('install-boundary reset (S10)', () => {
    it('runs the boundary check on every launch pass', async () => {
        renderGate();
        await waitFor(() => expect(mockRedirect).toHaveBeenCalled());
        expect(mockEnforceBoundary).toHaveBeenCalled();
    });

    it('after a boundary reset, a stale session atom does NOT count as identity and /login carries signedOut', async () => {
        mockBoundaryReset = true;
        mockIdentityState = 'absent';
        // The atom still holds the pre-reset session (fetched with the cookie
        // the reset just deleted) — it must be ignored.
        mockSession = { user: { id: 'stale-user' } };

        renderGate();

        await waitFor(() => expect(mockRedirect).toHaveBeenCalled());
        expect(mockRedirect).toHaveBeenCalledWith({
            pathname: '/login',
            params: { signedOut: '1' },
        });
    });

    it('without a reset the session enhancement still works (fresh-login window)', async () => {
        mockBoundaryReset = false;
        mockIdentityState = 'absent';
        mockSession = { user: { id: 'fresh-user' } };

        renderGate();

        await waitFor(() => expect(mockRedirect).toHaveBeenCalledWith('/logged-in'));
    });
});
