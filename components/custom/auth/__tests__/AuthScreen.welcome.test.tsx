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
jest.mock('@/components/custom/tutorials/TutorialLaunchButton', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-tutorial-launch" /> };
});
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
        expect(cta.props.accessibilityLabel).toBe('auth.startReading');

        // Walk the rendered tree: no OTHER HOST node may carry the label — a
        // wrapper carrying it is the full-screen phantom button VoiceOver and
        // text-based automation both hit. Host nodes only (`type` is a
        // string): composite layers of the same pressable legitimately relay
        // the prop on its way to the single host view.
        const labelled: unknown[] = [];
        const walk = (node: any) => {
            if (
                typeof node?.type === 'string' &&
                node?.props?.accessibilityLabel === 'auth.startReading'
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
        // auth-welcome-screen is the AuthScreen-side outer Box — on-device it
        // was the deepest of the phantom full-screen "Get started" Others
        // (plain RN container views answer an AGGREGATED accessibilityLabel);
        // the explicit accessible={false} marking is what stops that, proven
        // on-device by auth-welcome-root going label-less after the same fix.
        for (const id of [
            'auth-welcome-screen',
            'auth-welcome-root',
            'auth-welcome-logo-band',
            'auth-welcome-actions',
        ]) {
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
            ['auth-use-email-failure', 'auth.alreadyHaveAccount'],
            ['auth-device-support', 'account.contactSupport'],
        ] as const) {
            const node = await findByTestId(id);
            expect(node.props.accessibilityRole).toBe('button');
            expect(node.props.accessibilityLabel).toBe(label);
        }
    });
});

describe('welcome-view button stack (S8)', () => {
    /** Host testIDs in render order — the order assertion for the stack. */
    const collectTestIds = (root: any): string[] => {
        const ids: string[] = [];
        const walk = (node: any) => {
            if (typeof node?.type === 'string' && node?.props?.testID) ids.push(node.props.testID);
            (node?.children ?? []).forEach((c: any) => typeof c === 'object' && walk(c));
        };
        walk(root);
        return ids;
    };

    it('Learn about Mera sits ABOVE Get started, outline vs filled', async () => {
        const { findByTestId, UNSAFE_root } = render(<AuthScreen />);
        const learn = await findByTestId('auth-learn-mera');
        const cta = await findByTestId('auth-get-started');

        const ids = collectTestIds(UNSAFE_root);
        expect(ids.indexOf('auth-learn-mera')).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf('auth-learn-mera')).toBeLessThan(ids.indexOf('auth-get-started'));

        // Outline vs filled: same geometry (h-14 rounded-full), different fill.
        expect(learn.props.className).toContain('h-14');
        expect(learn.props.className).toContain('border');
        expect(learn.props.className).not.toContain('bg-primary-500');
        expect(cta.props.className).toContain('h-14');
        expect(cta.props.className).toContain('bg-primary-500');

        expect(learn.props.accessibilityRole).toBe('button');
        expect(learn.props.accessibilityLabel).toBe('auth.learnAboutMera');
    });

    it('Learn about Mera opens the tutorials MENU route, not a chapter', async () => {
        const { findByTestId } = render(<AuthScreen />);
        fireEvent.press(await findByTestId('auth-learn-mera'));
        expect(mockRouterPush).toHaveBeenCalledWith('/tutorials');
    });

    it('the footer tour pill is gone from the welcome view (it moved up), but stays on the email view', async () => {
        mockAvailability.mockResolvedValue('native');
        const welcome = render(<AuthScreen />);
        await welcome.findByTestId('auth-get-started');
        expect(welcome.queryByTestId('stub-tutorial-launch')).toBeNull();
        welcome.unmount();

        mockAvailability.mockResolvedValue('unavailable');
        const email = render(<AuthScreen />);
        await email.findByTestId('auth-email-input');
        expect(email.queryByTestId('stub-tutorial-launch')).toBeTruthy();
    });

    it('Sign in with email is RELOCATED: below the action stack, directly above the policy row', async () => {
        const { findByTestId, UNSAFE_root } = render(<AuthScreen />);
        await findByTestId('auth-get-started');

        // Present, styled as a text link, and OUTSIDE the action stack: the
        // render order is learn -> get started -> ... -> email link (footer).
        const ids = collectTestIds(UNSAFE_root);
        expect(ids.indexOf('auth-learn-mera')).toBeLessThan(ids.indexOf('auth-get-started'));
        expect(ids.indexOf('auth-get-started')).toBeLessThan(ids.indexOf('auth-use-email'));
        // In the footer band, not among the CTA buttons.
        const actions = await findByTestId('auth-welcome-actions');
        const actionIds = collectTestIds(actions);
        expect(actionIds).not.toContain('auth-use-email');

        const link = await findByTestId('auth-use-email');
        expect(link.props.accessibilityRole).toBe('button');
        expect(link.props.accessibilityLabel).toBe('auth.alreadyHaveAccount');
        // Text-link styling, not a button shell.
        expect(link.props.className ?? '').not.toContain('h-14');
    });

    it('the relocated email link still opens the email view', async () => {
        const { findByTestId } = render(<AuthScreen />);
        await findByTestId('auth-get-started');
        fireEvent.press(await findByTestId('auth-use-email'));
        expect(await findByTestId('auth-email-input')).toBeTruthy();
    });

    it('the failure state keeps its email escape (pre-S8 behavior), plus retry and support', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'attestation-denied' });
        const { findByTestId, findByText } = render(<AuthScreen />);
        fireEvent.press(await findByTestId('auth-get-started'));
        await findByText('auth.deviceSignInDenied');

        expect(await findByTestId('auth-device-retry')).toBeTruthy();
        expect(await findByTestId('auth-device-support')).toBeTruthy();
        fireEvent.press(await findByTestId('auth-use-email-failure'));
        expect(await findByTestId('auth-email-input')).toBeTruthy();
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
    it('denied shows the denied copy with retry and support paths', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'attestation-denied' });
        const { findByTestId, findByText } = render(<AuthScreen />);

        fireEvent.press(await findByTestId('auth-get-started'));

        await findByText('auth.deviceSignInDenied');
        expect(await findByTestId('auth-device-retry')).toBeTruthy();
        expect(await findByTestId('auth-device-support')).toBeTruthy();
    });

    it('retry re-runs the WHOLE flow (a fresh signInWithDevice call)', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'network' });
        const { findByTestId } = render(<AuthScreen />);

        fireEvent.press(await findByTestId('auth-get-started'));
        fireEvent.press(await findByTestId('auth-device-retry'));

        await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(2));
    });

    it('unsupported mid-flow falls back to the email view silently', async () => {
        mockSignIn.mockResolvedValue({ status: 'unsupported' });
        const { findByTestId } = render(<AuthScreen />);

        fireEvent.press(await findByTestId('auth-get-started'));

        expect(await findByTestId('auth-email-input')).toBeTruthy();
    });
});
