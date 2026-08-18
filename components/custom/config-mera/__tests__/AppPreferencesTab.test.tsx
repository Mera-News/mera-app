/* eslint-disable @typescript-eslint/no-require-imports */
// Settings → Logout. The bug this suite exists to prevent: signing out cleared
// the server session and the two secure-store keys but left `cached_user_id`
// and the whole WatermelonDB behind, so the launch gate saw a local identity,
// routed back into the app, and the previous user's persona / facts / saved
// articles / reading history stayed readable on the device.
//
// ORDER is the assertion that matters, not presence — the buggy version already
// called replace() and dismissAll(). Every mock below appends to `calls`.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

const calls: string[] = [];

// --- the logout sequence's collaborators ----------------------------------
const mockSignOut = jest.fn(async () => { calls.push('signOut'); });
const mockClearAuthStorage = jest.fn(async () => { calls.push('clearAuthStorage'); });
// Mutable so individual tests can hand the tab a resolved session (the
// support-id row and the anon-account row both derive from it).
let mockSessionData: { user: Record<string, unknown> } | null = null;
jest.mock('@/lib/auth-client', () => ({
    authClient: { signOut: () => mockSignOut(), useSession: () => ({ data: mockSessionData }) },
    clearAuthStorage: () => mockClearAuthStorage(),
}));

// The tab now reads the signed-in email from the LOCAL store rather than the
// server session. Mocked as a selector because the real module pulls in
// account-service → apollo-client → WatermelonDB's native SQLite adapter, which
// cannot initialize under Jest.
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: (selector: (s: { userId: string | null; userEmail: string | null }) => unknown) =>
        selector({ userId: 'u1', userEmail: 'someone@example.com' }),
}));

const mockSetLockEnabled = jest.fn(async (_v: boolean) => { calls.push('setLockEnabled'); });
jest.mock('@/lib/stores/pin-store', () => ({
    usePinStore: { getState: () => ({ setLockEnabled: (v: boolean) => mockSetLockEnabled(v) }) },
}));

const mockDeleteSetting = jest.fn(async (key: string) => { calls.push(`deleteSetting:${key}`); });
jest.mock('@/lib/database/services/setting-service', () => ({
    deleteSetting: (key: string) => mockDeleteSetting(key),
}));

const mockWipeAll = jest.fn(async () => { calls.push('wipeAllLocalUserData'); });
jest.mock('@/lib/security/local-wipe', () => ({ wipeAllLocalUserData: () => mockWipeAll() }));

const mockReplace = jest.fn((...a: any[]) => { calls.push('replace'); return a; });
const mockDismissAll = jest.fn(() => { calls.push('dismissAll'); });
let mockCanDismiss = false;
jest.mock('expo-router', () => ({
    router: {
        replace: (...a: any[]) => mockReplace(...a),
        dismissAll: () => mockDismissAll(),
        canDismiss: () => mockCanDismiss,
    },
    // Stable across renders, so a row's push TARGET can be asserted. The rows
    // write their paths as `'...' as any` (typedRoutes cannot see through the
    // cast), which makes a wrong path invisible to tsc and to lint.
    useRouter: () => ({ push: (...a: any[]) => mockPush(...a), replace: jest.fn() }),
}));
const mockPush = jest.fn();

// --- modal state: hold the logout modal open so its button is reachable -----
const mockCloseModal = jest.fn();
const mockOpenModal = jest.fn();
const mockSetModalProcessing = jest.fn();
jest.mock('@/lib/stores/ui-store', () => ({
    useLogoutModal: () => ({ isOpen: true, isProcessing: false }),
    useUIStore: () => ({
        openModal: mockOpenModal,
        closeModal: mockCloseModal,
        setModalProcessing: mockSetModalProcessing,
    }),
}));

// --- everything below is chrome: swapped for RN primitives / no-ops --------
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: ({ children, onPress, disabled, ...p }: any) => (
            <Pressable onPress={onPress} disabled={disabled} {...p}>{children}</Pressable>
        ),
        ButtonText: ({ children }: any) => <Text>{children}</Text>,
    };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const passthrough = ({ children }: any) => <View>{children}</View>;
    return {
        // isOpen is driven by useLogoutModal (mocked open above); render children
        // unconditionally so the confirm button is queryable.
        Modal: ({ children }: any) => <View>{children}</View>,
        ModalBackdrop: () => null,
        ModalContent: passthrough,
        ModalHeader: passthrough,
        ModalBody: passthrough,
        ModalFooter: passthrough,
    };
});
jest.mock('@/components/ui/toast', () => ({
    useToast: () => ({ show: jest.fn() }),
    Toast: (p: any) => { const { View } = require('react-native'); return <View {...p} />; },
    ToastTitle: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
    ToastDescription: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
}));
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return { GlassPanel: ({ children }: any) => <View>{children}</View> };
});
jest.mock('@/components/custom/PolicyPill', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-mera/LanguageWordTicker', () => ({ __esModule: true, default: () => null }));
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} />, FontAwesome: (p: any) => <View {...p} /> };
});
jest.mock('@/lib/revenuecat', () => ({ isRevenueCatConfigured: () => false }));
jest.mock('@/lib/feedback', () => ({ showFeedback: jest.fn() }));
jest.mock('@/lib/sentry-init', () => ({ SENTRY_ENABLED: false }));
jest.mock('@/lib/web-browser-utils', () => ({ openInAppBrowser: jest.fn(), withAppLanguage: (u: string) => u }));
jest.mock('@/lib/version', () => ({ getAppVersionLabel: () => 'v0.0.0 · test' }));
const mockSetStringAsync = jest.fn(async (_s: string) => true);
jest.mock('expo-clipboard', () => ({ setStringAsync: (s: string) => mockSetStringAsync(s) }));
const mockHapticLight = jest.fn(async () => {});
jest.mock('@/lib/haptics', () => ({ hapticLight: () => mockHapticLight() }));
jest.mock('@/lib/stores/app-language-store', () => ({ useAppLanguageStore: (sel: any) => sel({ appLanguage: 'en' }) }));

import AppPreferencesTab from '../AppPreferencesTab';

const pressSignOut = (getByText: (t: string) => any) =>
    fireEvent.press(getByText('preferences.signOut'));

beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    mockCanDismiss = false;
    mockSessionData = null;
});

describe('Settings → Logout', () => {
    it('clears the local identity and every local store, in an order that cannot re-poison it', async () => {
        const { getByText } = render(<AppPreferencesTab />);
        pressSignOut(getByText);

        await waitFor(() => expect(mockWipeAll).toHaveBeenCalled());

        // The sentinel the launch gate reads must be gone BEFORE navigation:
        // app/logged-in/index.tsx re-writes `cached_user_id` via setUserId(), so
        // anything that reaches it while the row survives undoes the logout.
        expect(mockDeleteSetting).toHaveBeenCalledWith('cached_user_id');
        expect(calls.indexOf('deleteSetting:cached_user_id')).toBeLessThan(calls.indexOf('replace'));

        // ...and the bulk wipe must come AFTER navigation, so screens unmount
        // before the data they render disappears underneath them.
        expect(calls.indexOf('replace')).toBeLessThan(calls.indexOf('wipeAllLocalUserData'));

        // No direct 'signOut' entry: the ONLY server contact lives inside
        // clearAuthStorage(), where it is guarded and bounded — a direct
        // unguarded call here is what once let a staging outage abort the
        // whole local logout.
        expect(calls).toEqual([
            'clearAuthStorage',
            'setLockEnabled',
            'deleteSetting:cached_user_id',
            'replace',
            'wipeAllLocalUserData',
        ]);
    });

    it('a rejecting server sign-out cannot stop the local logout (outage = still signed out)', async () => {
        // The observed field bug: logout during a staging outage relaunched
        // signed IN. The handler must never await the server unguarded — local
        // truth wins, exactly as the never-silent-logout invariant demands in
        // the other direction.
        mockSignOut.mockRejectedValue(new TypeError('Network request failed'));
        const { getByText } = render(<AppPreferencesTab />);
        pressSignOut(getByText);

        await waitFor(() => expect(mockWipeAll).toHaveBeenCalled());
        expect(mockClearAuthStorage).toHaveBeenCalled();
        expect(mockDeleteSetting).toHaveBeenCalledWith('cached_user_id');
        expect(mockReplace).toHaveBeenCalledWith({ pathname: '/login', params: { signedOut: '1' } });
    });

    it('lands on /login with signedOut:"1", never on the launch gate', async () => {
        const { getByText } = render(<AppPreferencesTab />);
        pressSignOut(getByText);

        await waitFor(() => expect(mockReplace).toHaveBeenCalled());
        // '/' would re-enter app/index.tsx, which counts a not-yet-cleared
        // better-auth session atom as identity; the param suppresses login.tsx's
        // matching shortcut for the same window.
        expect(mockReplace).toHaveBeenCalledWith({ pathname: '/login', params: { signedOut: '1' } });
        expect(mockReplace).toHaveBeenCalledTimes(1);
    });

    it('turns the PIN opt-in off before navigating away', async () => {
        const { getByText } = render(<AppPreferencesTab />);
        pressSignOut(getByText);

        await waitFor(() => expect(mockSetLockEnabled).toHaveBeenCalledWith(false));
    });

    it('skips dismissAll() when nothing is dismissible (logout from the Settings tab)', async () => {
        mockCanDismiss = false;
        const { getByText } = render(<AppPreferencesTab />);
        pressSignOut(getByText);

        await waitFor(() => expect(mockReplace).toHaveBeenCalled());
        // Unguarded this logged "POP_TO_TOP was not handled by any navigator".
        expect(mockDismissAll).not.toHaveBeenCalled();
    });

    it('still dismisses when a screen is pushed above the tab', async () => {
        mockCanDismiss = true;
        const { getByText } = render(<AppPreferencesTab />);
        pressSignOut(getByText);

        await waitFor(() => expect(mockReplace).toHaveBeenCalled());
        expect(mockDismissAll).toHaveBeenCalledTimes(1);
        expect(calls.indexOf('dismissAll')).toBeLessThan(calls.indexOf('replace'));
    });

    // The two halves of the boundary. BEFORE clearAuthStorage() a failure is
    // safe to abort on — nothing local has been touched. AFTER it the cookie is
    // already gone, so aborting would strand the device with no credentials but
    // a live `cached_user_id`: 'present' to the launch gate, invisible to the
    // orphan purge, serving the previous user's data offline forever.
    it('a failing PIN write still reaches the wipe — nothing after the cookie delete may abort', async () => {
        mockSetLockEnabled.mockRejectedValueOnce(new Error('keychain write failed'));
        const { getByText } = render(<AppPreferencesTab />);
        pressSignOut(getByText);

        await waitFor(() => expect(mockWipeAll).toHaveBeenCalled());
        expect(mockDeleteSetting).toHaveBeenCalledWith('cached_user_id');
        expect(mockReplace).toHaveBeenCalled();
    });

    it('a failing sentinel delete still reaches the wipe', async () => {
        mockDeleteSetting.mockRejectedValueOnce(new Error('db busy'));
        const { getByText } = render(<AppPreferencesTab />);
        pressSignOut(getByText);

        await waitFor(() => expect(mockWipeAll).toHaveBeenCalled());
        expect(mockReplace).toHaveBeenCalled();
    });

    // The spec that used to sit here — "a failing server sign-out leaves local
    // state untouched" — encoded the field bug it was meant to prevent: logout
    // during a staging outage left the device signed IN across relaunches.
    // The user pressed the button, so local truth wins; the rejecting-sign-out
    // case is covered above, and the server call itself now lives guarded and
    // bounded inside clearAuthStorage().
});

describe('Settings footer → Support ID copy button (S9)', () => {
    it('copies EXACTLY the numeric id — never the label, never an email', async () => {
        mockSessionData = { user: { id: 'u1', email: 'x@anon.mera.news', isAnonymous: true, supportId: '1234567' } };
        const { findByTestId } = render(<AppPreferencesTab />);

        fireEvent.press(await findByTestId('settings-support-id-copy'));

        await waitFor(() => expect(mockSetStringAsync).toHaveBeenCalledTimes(1));
        expect(mockSetStringAsync).toHaveBeenCalledWith('1234567');
        expect(mockHapticLight).toHaveBeenCalled();
    });

    it('shows a brief Copied state and reverts', async () => {
        mockSessionData = { user: { id: 'u1', email: 'x@anon.mera.news', isAnonymous: true, supportId: '1234567' } };
        const { findByTestId, queryByText, getByText } = render(<AppPreferencesTab />);
        const button = await findByTestId('settings-support-id-copy');

        expect(queryByText('support.copied')).toBeNull();

        jest.useFakeTimers();
        try {
            fireEvent.press(button);
            // Flush the async clipboard write so the state lands.
            await act(async () => {
                await Promise.resolve();
            });
            expect(getByText('support.copied')).toBeTruthy();

            act(() => {
                jest.advanceTimersByTime(2000);
            });
            expect(queryByText('support.copied')).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });

    it('is absent when the account has no supportId', async () => {
        mockSessionData = { user: { id: 'u1', email: 'real@example.com' } };
        const { queryByTestId, findByText } = render(<AppPreferencesTab />);
        await findByText('preferences.manageSettings');
        expect(queryByTestId('settings-support-id-copy')).toBeNull();
    });
});

describe('Settings footer → Support ID', () => {
    it('shows the id when the session user carries one (anonymous account)', async () => {
        mockSessionData = { user: { id: 'u1', email: 'x@anon.mera.news', isAnonymous: true, supportId: '12345678' } };
        const { findByTestId } = render(<AppPreferencesTab />);
        const row = await findByTestId('settings-support-id');
        expect(row.props.children).toBe('support.supportId');
    });

    it('shows the id for an email-attached account too (it survives attach)', async () => {
        mockSessionData = { user: { id: 'u1', email: 'real@example.com', supportId: '12345678' } };
        const { findByTestId } = render(<AppPreferencesTab />);
        expect(await findByTestId('settings-support-id')).toBeTruthy();
    });

    it('hides the row when the account has no supportId or the session is unresolved', async () => {
        mockSessionData = { user: { id: 'u1', email: 'real@example.com' } };
        const { queryByTestId, findByText } = render(<AppPreferencesTab />);
        await findByText('preferences.manageSettings');
        expect(queryByTestId('settings-support-id')).toBeNull();

        mockSessionData = null;
        const second = render(<AppPreferencesTab />);
        await second.findByText('preferences.manageSettings');
        expect(second.queryByTestId('settings-support-id')).toBeNull();
    });
});

describe('Settings → tutorials row', () => {
    // TOP-LEVEL `/tutorials`, not `/logged-in/tutorials`. The flow was moved out
    // of the signed-in tree so an unauthed reader can reach it (the paywall
    // links to the same route), and this row is the in-app entry point that has
    // to follow it there.
    it('opens the top-level tutorials route', () => {
        mockPush.mockClear();
        const { getByTestId } = render(<AppPreferencesTab />);

        fireEvent.press(getByTestId('settings-row-tutorials'));

        expect(mockPush).toHaveBeenCalledWith('/tutorials');
    });
});

describe('Settings → signed-in email', () => {
    // Regression guard for a reported bug: the email row read
    // `session?.user?.email`, so any window where better-auth could not produce
    // a session blanked it — and a still-signed-in user read that as "I have
    // been logged out". The auth-client mock above returns `data: null` for
    // useSession, so EVERY render in this file is that offline case.
    it('renders the masked email from the local store while the server session is unavailable', () => {
        const { getByText } = render(<AppPreferencesTab />);
        // 't' is mocked to the key, so the interpolated email is not in the
        // output — assert the row exists at all, which is what vanished.
        expect(getByText('preferences.user')).toBeTruthy();
    });
});
