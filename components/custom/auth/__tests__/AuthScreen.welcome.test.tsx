/* eslint-disable @typescript-eslint/no-require-imports */
// AuthScreen.welcome.test.tsx — the device sign-in entry view.
//
// What must hold:
//  - A fresh device with attestation (or the dev bypass) available lands on
//    the WELCOME view; without either it falls straight to the email view, so
//    no user ever sees a dead CTA. A remembered previous user outranks both.
//  - Success mirrors OTPVerificationView's bookkeeping: recordAuthenticatedUser
//    BEFORE navigation, needsReauth cleared, identity fault cleared. Normal
//    mode navigates itself to /logged-in (the session atom is not trusted to
//    settle); reauth mode hands the userId to onLoginSuccess instead.
//  - Every failure state offers retry AND the email path, and retry re-runs
//    the whole flow (fresh nonce lives inside signInWithDevice).

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/auth/OTPVerificationView', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-otp-view" /> };
});
jest.mock('@/components/custom/auth/PreviousUserView', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-previous-user-view" /> };
});
jest.mock('@/components/custom/auth/LanguageSelector', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/tutorials/TutorialLaunchButton', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/PolicyPill', () => ({ __esModule: true, default: () => null }));
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
jest.mock('expo-router', () => ({
    router: { replace: (...a: any[]) => mockRouterReplace(...a) },
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

jest.mock('@/lib/auth-client', () => ({
    sendOTP: jest.fn(async () => ({ success: true })),
}));

const mockRecordAuthenticatedUser = jest.fn();
const mockClearIdentityFault = jest.fn(async (..._a: unknown[]) => {});
jest.mock('@/lib/security/identity-gate', () => ({
    recordAuthenticatedUser: (...a: any[]) => mockRecordAuthenticatedUser(...a),
    clearIdentityFault: (...a: any[]) => mockClearIdentityFault(...a),
}));

const mockSetNeedsReauth = jest.fn();
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: { getState: () => ({ setNeedsReauth: mockSetNeedsReauth }) },
}));

const mockOpenSupport = jest.fn();
jest.mock('@/lib/intercom', () => ({
    useSupportAction: () => ({ busy: false, openSupport: mockOpenSupport }),
}));

jest.mock('@/lib/version', () => ({ getAppVersionLabel: () => 'v1.3.0' }));
jest.mock('@/lib/web-browser-utils', () => ({
    openInAppBrowser: jest.fn(),
    withAppLanguage: (u: string) => u,
}));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), debug: jest.fn() },
}));

import AuthScreen from '../AuthScreen';

beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockAvailability.mockResolvedValue('native');
});

describe('entry view selection', () => {
    it('fresh device with attestation available lands on the welcome view', async () => {
        const { findByTestId, queryByTestId } = render(<AuthScreen />);
        expect(await findByTestId('auth-get-started')).toBeTruthy();
        expect(queryByTestId('auth-email-input')).toBeNull();
    });

    it('no attestation and no dev token falls straight to the email view', async () => {
        mockAvailability.mockResolvedValue('unavailable');
        const { findByTestId, queryByTestId } = render(<AuthScreen />);
        expect(await findByTestId('auth-email-input')).toBeTruthy();
        expect(queryByTestId('auth-get-started')).toBeNull();
    });

    it('a remembered previous user outranks the welcome view', async () => {
        mockGetSetting.mockImplementation(async (k: string) =>
            k === 'cached_user_email' ? 'a@b.com' : k === 'cached_user_id' ? 'u1' : null,
        );
        const { queryByTestId, findByTestId } = render(<AuthScreen />);
        expect(await findByTestId('stub-previous-user-view')).toBeTruthy();
        expect(queryByTestId('auth-get-started')).toBeNull();
    });
});

describe('accessibility scoping (F2)', () => {
    it('exactly ONE node carries the Get started label, and it is the button itself', async () => {
        const { findByTestId, UNSAFE_root } = render(<AuthScreen />);
        const cta = await findByTestId('auth-get-started');

        expect(cta.props.accessibilityRole).toBe('button');
        expect(cta.props.accessibilityLabel).toBe('auth.getStarted');

        // Walk the rendered tree: no OTHER HOST node may carry the label — a
        // wrapper carrying it is the full-screen phantom button VoiceOver and
        // text-based automation both hit. Host nodes only (`type` is a
        // string): composite layers of the same pressable legitimately relay
        // the prop on its way to the single host view.
        const labelled: unknown[] = [];
        const walk = (node: any) => {
            if (
                typeof node?.type === 'string' &&
                node?.props?.accessibilityLabel === 'auth.getStarted'
            ) {
                labelled.push(node);
            }
            (node?.children ?? []).forEach((c: any) => typeof c === 'object' && walk(c));
        };
        walk(UNSAFE_root);
        expect(labelled).toHaveLength(1);
    });

    it('the full-screen wrappers are explicitly not accessibility elements', async () => {
        const { findByTestId } = render(<AuthScreen />);
        for (const id of ['auth-welcome-root', 'auth-welcome-logo-band', 'auth-welcome-actions']) {
            const wrapper = await findByTestId(id);
            expect(wrapper.props.accessible).toBe(false);
            expect(wrapper.props.accessibilityLabel).toBeUndefined();
        }
    });

    it('the secondary controls are buttons with their own labels', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'attestation-denied' });
        const { findByTestId, findByText } = render(<AuthScreen />);
        fireEvent.press(await findByTestId('auth-get-started'));
        await findByText('auth.deviceSignInDenied');

        for (const [id, label] of [
            ['auth-device-retry', 'auth.tryAgain'],
            ['auth-use-email', 'auth.signInWithEmail'],
            ['auth-device-support', 'account.contactSupport'],
        ] as const) {
            const node = await findByTestId(id);
            expect(node.props.accessibilityRole).toBe('button');
            expect(node.props.accessibilityLabel).toBe(label);
        }
    });
});

describe('device sign-in success', () => {
    it('records the user, clears reauth state and navigates to /logged-in', async () => {
        mockSignIn.mockResolvedValue({ status: 'success', userId: 'anon-user-1' });
        const { findByTestId } = render(<AuthScreen />);

        fireEvent.press(await findByTestId('auth-get-started'));

        await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/logged-in'));
        expect(mockRecordAuthenticatedUser).toHaveBeenCalledWith('anon-user-1');
        expect(mockSetNeedsReauth).toHaveBeenCalledWith(false);
        expect(mockClearIdentityFault).toHaveBeenCalled();
        // The recording must precede navigation — it is what the gates read
        // while the session atom is still settling.
        expect(mockRecordAuthenticatedUser.mock.invocationCallOrder[0]).toBeLessThan(
            mockRouterReplace.mock.invocationCallOrder[0],
        );
    });

    it('reauth mode hands the userId to onLoginSuccess instead of navigating', async () => {
        mockSignIn.mockResolvedValue({ status: 'success', userId: 'anon-user-1' });
        const onLoginSuccess = jest.fn();
        const { findByTestId } = render(<AuthScreen onLoginSuccess={onLoginSuccess} />);

        fireEvent.press(await findByTestId('auth-get-started'));

        await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith('anon-user-1'));
        expect(mockRouterReplace).not.toHaveBeenCalled();
    });
});

describe('device sign-in failure', () => {
    it('denied shows the denied copy with retry, email and support paths', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'attestation-denied' });
        const { findByTestId, findByText } = render(<AuthScreen />);

        fireEvent.press(await findByTestId('auth-get-started'));

        await findByText('auth.deviceSignInDenied');
        expect(await findByTestId('auth-device-retry')).toBeTruthy();
        expect(await findByTestId('auth-use-email')).toBeTruthy();
        expect(await findByTestId('auth-device-support')).toBeTruthy();
    });

    it('retry re-runs the WHOLE flow (a fresh signInWithDevice call)', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'network' });
        const { findByTestId } = render(<AuthScreen />);

        fireEvent.press(await findByTestId('auth-get-started'));
        fireEvent.press(await findByTestId('auth-device-retry'));

        await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(2));
    });

    it('the email path from a failure state renders the email view', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'unknown' });
        const { findByTestId, findByText } = render(<AuthScreen />);

        fireEvent.press(await findByTestId('auth-get-started'));
        await findByText('auth.deviceSignInFailed');
        fireEvent.press(await findByTestId('auth-use-email'));

        expect(await findByTestId('auth-email-input')).toBeTruthy();
    });

    it('unsupported mid-flow falls back to the email view silently', async () => {
        mockSignIn.mockResolvedValue({ status: 'unsupported' });
        const { findByTestId } = render(<AuthScreen />);

        fireEvent.press(await findByTestId('auth-get-started'));

        expect(await findByTestId('auth-email-input')).toBeTruthy();
    });
});
