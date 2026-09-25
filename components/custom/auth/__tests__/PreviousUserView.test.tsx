/* eslint-disable @typescript-eslint/no-require-imports */
// PreviousUserView.test.tsx — the returning-user screen's two account moves.
//
//  - "Login with a different user" puts another account on this device, so it
//    must run the FULL wipe after signing out. clearAllStores() alone left this
//    account's PIN lock, backup key, staged backup files and E2EE keys for the
//    next account; a tidy-up back to it must fail here.
//  - "Sign in without email" renders only when the parent offers it (the device
//    can attest and this is not Forgot PIN).

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
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
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: (p: any) => <Pressable {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
    };
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
    return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

const calls: string[] = [];
const mockClearAuthStorage = jest.fn(async () => { calls.push('clearAuthStorage'); });
jest.mock('@/lib/auth-client', () => ({
    sendOTP: jest.fn(async () => ({ success: true })),
    clearAuthStorage: () => mockClearAuthStorage(),
}));
const mockWipe = jest.fn(async (..._a: unknown[]) => { calls.push('wipeAllLocalUserData'); });
jest.mock('@/lib/security/local-wipe', () => ({
    wipeAllLocalUserData: (...a: unknown[]) => mockWipe(...a),
}));
const mockClearAllStores = jest.fn(async () => {});
jest.mock('@/lib/stores', () => ({ clearAllStores: () => mockClearAllStores() }));

import PreviousUserView from '../PreviousUserView';

const baseProps = {
    email: 'a@b.com',
    userId: 'email-user',
    onUseDifferentUser: jest.fn(),
    onOTPSent: jest.fn(),
};

beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
});

describe('Login with a different user', () => {
    it('signs out, then runs the FULL wipe, then hands back to the parent', async () => {
        const onUseDifferentUser = jest.fn();
        const r = render(<PreviousUserView {...baseProps} onUseDifferentUser={onUseDifferentUser} />);

        fireEvent.press(r.getByText('auth.previousUser.useDifferentUser'));
        fireEvent.press(r.getByText('auth.previousUser.switchConfirm'));

        await waitFor(() => expect(onUseDifferentUser).toHaveBeenCalled());
        expect(calls).toEqual(['clearAuthStorage', 'wipeAllLocalUserData']);
        // The full wipe, never keepSession: no session is wanted after this.
        expect(mockWipe).toHaveBeenCalledWith();
        expect(mockClearAllStores).not.toHaveBeenCalled();
    });

    it('a failed wipe does not hand back (the user stays on this screen)', async () => {
        mockWipe.mockRejectedValueOnce(new Error('db locked'));
        const onUseDifferentUser = jest.fn();
        const r = render(<PreviousUserView {...baseProps} onUseDifferentUser={onUseDifferentUser} />);

        fireEvent.press(r.getByText('auth.previousUser.useDifferentUser'));
        fireEvent.press(r.getByText('auth.previousUser.switchConfirm'));

        await waitFor(() => expect(mockWipe).toHaveBeenCalled());
        expect(onUseDifferentUser).not.toHaveBeenCalled();
    });
});

describe('Sign in without email', () => {
    it('renders and fires when the parent offers it', () => {
        const onSignInWithoutEmail = jest.fn();
        const r = render(<PreviousUserView {...baseProps} onSignInWithoutEmail={onSignInWithoutEmail} />);

        fireEvent.press(r.getByTestId('previous-user-device-sign-in'));

        expect(onSignInWithoutEmail).toHaveBeenCalledTimes(1);
        // The subtitle names the option only when the button is there.
        expect(r.getByText('auth.previousUser.subtitleWithDevice')).toBeTruthy();
        expect(r.queryByText('auth.previousUser.subtitle')).toBeNull();
    });

    it('is absent when the parent does not offer it, and so is the subtitle naming it', () => {
        const r = render(<PreviousUserView {...baseProps} />);
        expect(r.queryByTestId('previous-user-device-sign-in')).toBeNull();
        expect(r.getByText('auth.previousUser.subtitle')).toBeTruthy();
        expect(r.queryByText('auth.previousUser.subtitleWithDevice')).toBeNull();
    });
});
