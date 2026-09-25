/* eslint-disable @typescript-eslint/no-require-imports */
// AuthScreen.device-no-email.test.tsx — "Sign in without email".
//
// The account model: the phone's own account (device sign-in) is always
// reachable, any number of email accounts can live on one device, and moving
// between accounts wipes local data. What must hold here:
//  - The previous-user and email views offer device sign-in, except on a device
//    that cannot attest and on Forgot PIN (allowDeviceSignIn=false).
//  - It runs through the consent step, like "Get started".
//  - The phone's account is compared with the account on this device BEFORE any
//    bookkeeping. Same account: normal sign-in. Different account: a confirm,
//    and nothing is recorded, latched or persisted for it unless the user
//    continues. Going back signs the phone's account out and returns.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/auth/OTPVerificationView', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-otp-view" /> };
});
// The stub surfaces the one prop this suite is about: whether the parent
// offers device sign-in, and what pressing it does.
jest.mock('@/components/custom/auth/PreviousUserView', () => {
    const { View, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: (p: any) => (
            <View testID="stub-previous-user-view">
                {p.onSignInWithoutEmail ? (
                    <Pressable testID="stub-previous-device-sign-in" onPress={p.onSignInWithoutEmail} />
                ) : null}
            </View>
        ),
    };
});
jest.mock('@/components/custom/auth/LanguageSelector', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-language-selector" /> };
});
jest.mock('@/components/custom/auth/LegalFooter', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-legal-footer" /> };
});
jest.mock('@/components/custom/tutorials/TutorialLaunchButton', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-tutorial-launch" /> };
});
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable: (p: any) => <Pressable {...p} /> };
});
jest.mock('@/components/ui/input', () => {
    const { View, TextInput } = require('react-native');
    return { Input: (p: any) => <View {...p} />, InputField: (p: any) => <TextInput {...p} /> };
});
jest.mock('@/components/ui/toast', () => {
    const { View, Text } = require('react-native');
    return {
        Toast: (p: any) => <View {...p} />,
        ToastTitle: (p: any) => <Text {...p} />,
        ToastDescription: (p: any) => <Text {...p} />,
        useToast: () => ({ show: jest.fn() }),
    };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} />, FontAwesome: (p: any) => <View {...p} /> };
});
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
    router: {
        replace: (...a: any[]) => mockRouterReplace(...a),
        push: (...a: any[]) => mockRouterPush(...a),
    },
}));

const mockGetSetting = jest.fn();
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => mockGetSetting(k),
}));

const mockAvailability = jest.fn();
const mockSignIn = jest.fn();
jest.mock('@/lib/device-auth', () => ({
    deviceSignInAvailability: (...a: any[]) => mockAvailability(...a),
    signInWithDevice: (...a: any[]) => mockSignIn(...a),
}));

const mockClearAuthStorage = jest.fn(async () => {});
jest.mock('@/lib/auth-client', () => ({
    sendOTP: jest.fn(async () => ({ success: true })),
    clearAuthStorage: () => mockClearAuthStorage(),
}));

const mockRecordAuthenticatedUser = jest.fn();
const mockClearIdentityFault = jest.fn(async (..._a: unknown[]) => {});
const calls: string[] = [];
const mockHold = jest.fn((..._a: any[]) => { calls.push('hold'); });
const mockRelease = jest.fn(() => { calls.push('release'); });
jest.mock('@/lib/security/identity-gate', () => ({
    recordAuthenticatedUser: (...a: any[]) => { calls.push('record'); return mockRecordAuthenticatedUser(...a); },
    clearIdentityFault: (...a: any[]) => mockClearIdentityFault(...a),
    holdAccountSwitch: (...a: any[]) => mockHold(...a),
    releaseAccountSwitch: () => mockRelease(),
}));

const mockSetNeedsReauth = jest.fn();
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: { getState: () => ({ setNeedsReauth: mockSetNeedsReauth }) },
}));

// The store's getState is read twice by the language stage (current value +
// the persist call); a plain object with a stable jest.fn is enough.
const mockSetAppLanguage = jest.fn(async (_lang: string) => {});
jest.mock('@/lib/stores/app-language-store', () => ({
    useAppLanguageStore: {
        getState: () => ({ appLanguage: 'en', setAppLanguage: mockSetAppLanguage }),
    },
}));

const mockFetchLegalVersions = jest.fn();
const mockAcceptLegal = jest.fn();
const mockMarkAccepted = jest.fn();
const mockSilentlyAcceptLegal = jest.fn(async (..._a: any[]) => {});
jest.mock('../legal-consent', () => ({
    fetchLegalVersions: (...a: any[]) => mockFetchLegalVersions(...a),
    acceptLegal: (...a: any[]) => mockAcceptLegal(...a),
    markLegalAcceptedThisProcess: (...a: any[]) => mockMarkAccepted(...a),
    silentlyAcceptLegal: (...a: any[]) => mockSilentlyAcceptLegal(...a),
}));

const mockOpenSupport = jest.fn();
jest.mock('@/lib/intercom', () => ({
    useSupportAction: () => ({ busy: false, openSupport: mockOpenSupport }),
}));

jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(async () => {}) }));
jest.mock('@/lib/web-browser-utils', () => ({
    openInAppBrowser: jest.fn(),
    withAppLanguage: (u: string) => u,
}));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), debug: jest.fn() },
}));

import AuthScreen from '../AuthScreen';

const CURRENT = { termsVersion: '2026-08-01', privacyVersion: '2026-08-01' };

/** A device remembering an email user. */
function rememberEmailUser(userId = 'email-user') {
    mockGetSetting.mockImplementation(async (k: string) =>
        k === 'cached_user_email' ? 'a@b.com' : k === 'cached_user_id' ? userId : 'en',
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    rememberEmailUser();
    mockAvailability.mockResolvedValue('native');
    mockFetchLegalVersions.mockResolvedValue(CURRENT);
    mockAcceptLegal.mockResolvedValue({ ok: true });
});

/** From the previous-user view, press "Sign in without email" then Agree. */
async function signInWithoutEmailFromPrevious(r: ReturnType<typeof render>) {
    fireEvent.press(await r.findByTestId('stub-previous-device-sign-in'));
    fireEvent.press(await r.findByTestId('auth-consent-agree'));
}

describe('where "Sign in without email" is offered', () => {
    it('the previous-user view offers it when the device can attest', async () => {
        const r = render(<AuthScreen />);
        expect(await r.findByTestId('stub-previous-device-sign-in')).toBeTruthy();
    });

    it('the dev bypass counts as able to attest', async () => {
        mockAvailability.mockResolvedValue('dev-bypass');
        const r = render(<AuthScreen />);
        expect(await r.findByTestId('stub-previous-device-sign-in')).toBeTruthy();
    });

    it('not on a device that cannot attest (no dead button)', async () => {
        mockAvailability.mockResolvedValue('unavailable');
        const r = render(<AuthScreen />);
        await r.findByTestId('stub-previous-user-view');
        expect(r.queryByTestId('stub-previous-device-sign-in')).toBeNull();
    });

    it('not on Forgot PIN, where holding the phone must not reset the lock', async () => {
        const r = render(<AuthScreen allowDeviceSignIn={false} onLoginSuccess={jest.fn()} />);
        await r.findByTestId('stub-previous-user-view');
        expect(r.queryByTestId('stub-previous-device-sign-in')).toBeNull();
    });

    it('the email view offers it too, and it leads to the consent step', async () => {
        mockGetSetting.mockImplementation(async (k: string) => (k === 'app_language' ? 'en' : null));
        const r = render(<AuthScreen />);
        fireEvent.press(await r.findByTestId('auth-use-email'));
        fireEvent.press(await r.findByTestId('auth-email-device-sign-in'));
        expect(await r.findByTestId('auth-consent-agree')).toBeTruthy();
    });

    it('the email view hides it on Forgot PIN', async () => {
        mockGetSetting.mockImplementation(async (k: string) => (k === 'app_language' ? 'en' : null));
        const r = render(<AuthScreen allowDeviceSignIn={false} />);
        fireEvent.press(await r.findByTestId('auth-use-email'));
        await r.findByTestId('auth-email-input');
        expect(r.queryByTestId('auth-email-device-sign-in')).toBeNull();
    });
});

describe('the phone opens the SAME account (email added after a device sign-in)', () => {
    it('signs in with the normal bookkeeping and no confirm', async () => {
        mockSignIn.mockResolvedValue({ status: 'success', userId: 'email-user', trialAvailable: false });
        const onLoginSuccess = jest.fn();
        const r = render(<AuthScreen onLoginSuccess={onLoginSuccess} />);

        await signInWithoutEmailFromPrevious(r);

        await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith('email-user'));
        expect(mockHold).not.toHaveBeenCalled();
        expect(mockRecordAuthenticatedUser).toHaveBeenCalledWith('email-user');
        expect(mockSetNeedsReauth).toHaveBeenCalledWith(false);
        expect(mockMarkAccepted).toHaveBeenCalledWith('email-user');
        expect(r.queryByTestId('auth-different-account-root')).toBeNull();
    });
});

describe('the phone opens a DIFFERENT account', () => {
    beforeEach(() => {
        mockSignIn.mockResolvedValue({ status: 'success', userId: 'phone-user', trialAvailable: false });
    });

    it('asks first, with NOTHING recorded for the phone account yet', async () => {
        const onLoginSuccess = jest.fn();
        const r = render(<AuthScreen onLoginSuccess={onLoginSuccess} />);

        await signInWithoutEmailFromPrevious(r);

        expect(await r.findByTestId('auth-different-account-root')).toBeTruthy();
        expect(mockRecordAuthenticatedUser).not.toHaveBeenCalled();
        expect(mockSetNeedsReauth).not.toHaveBeenCalled();
        expect(mockClearIdentityFault).not.toHaveBeenCalled();
        expect(mockMarkAccepted).not.toHaveBeenCalled();
        expect(mockAcceptLegal).not.toHaveBeenCalled();
        expect(onLoginSuccess).not.toHaveBeenCalled();
        expect(mockRouterReplace).not.toHaveBeenCalled();
        // Held, so no gate, watcher or shortcut acts on it while the user decides.
        expect(mockHold).toHaveBeenCalledWith('phone-user');
        expect(mockRelease).not.toHaveBeenCalled();
    });

    it('Continue runs the bookkeeping, then hands the NEW account to the caller', async () => {
        const onLoginSuccess = jest.fn();
        const r = render(<AuthScreen onLoginSuccess={onLoginSuccess} />);
        await signInWithoutEmailFromPrevious(r);

        fireEvent.press(await r.findByTestId('auth-different-account-continue'));

        await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith('phone-user'));
        // Released BEFORE the account is recorded, so the gate can now act on it.
        expect(calls).toEqual(['hold', 'release', 'record']);
        expect(mockRecordAuthenticatedUser).toHaveBeenCalledWith('phone-user');
        expect(mockMarkAccepted).toHaveBeenCalledWith('phone-user');
        expect(mockAcceptLegal).toHaveBeenCalledWith(CURRENT);
        // The switch never signs anything out: the identity gate wipes the
        // previous account on arrival and keeps this new session.
        expect(mockClearAuthStorage).not.toHaveBeenCalled();
    });

    it('Continue outside reauth mode routes to /logged-in, where the gate wipes', async () => {
        const r = render(<AuthScreen />);
        await signInWithoutEmailFromPrevious(r);

        fireEvent.press(await r.findByTestId('auth-different-account-continue'));

        await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/logged-in'));
    });

    it('Go back signs the phone account out and returns to the previous-user view', async () => {
        const onLoginSuccess = jest.fn();
        const r = render(<AuthScreen onLoginSuccess={onLoginSuccess} />);
        await signInWithoutEmailFromPrevious(r);

        fireEvent.press(await r.findByTestId('auth-different-account-back'));

        expect(await r.findByTestId('stub-previous-user-view')).toBeTruthy();
        expect(mockClearAuthStorage).toHaveBeenCalledTimes(1);
        // Stays held: signOut clears the atom asynchronously, and a stale read
        // of the declined account must never act.
        expect(mockRelease).not.toHaveBeenCalled();
        expect(mockRecordAuthenticatedUser).not.toHaveBeenCalled();
        expect(mockMarkAccepted).not.toHaveBeenCalled();
        expect(onLoginSuccess).not.toHaveBeenCalled();
    });

    it('a device with no remembered account never asks (nothing to switch from)', async () => {
        mockGetSetting.mockImplementation(async (k: string) => (k === 'app_language' ? 'en' : null));
        const r = render(<AuthScreen />);
        fireEvent.press(await r.findByTestId('auth-get-started'));
        fireEvent.press(await r.findByTestId('auth-consent-agree'));

        await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/logged-in'));
        expect(r.queryByTestId('auth-different-account-root')).toBeNull();
    });
});

describe('consent-step fallback', () => {
    it('"Sign in with email" after a failure returns to the previous-user view it came from', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'network' });
        const r = render(<AuthScreen />);
        await signInWithoutEmailFromPrevious(r);

        fireEvent.press(await r.findByTestId('auth-use-email-failure'));

        expect(await r.findByTestId('stub-previous-user-view')).toBeTruthy();
        expect(r.queryByTestId('auth-email-input')).toBeNull();
    });
});
