/* eslint-disable @typescript-eslint/no-require-imports */
// The sheet's OUTCOME contract (S10): every close reports 'verified' iff the
// flow reached done — the checkout gate keys on it.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

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
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    return {
        Modal: ({ isOpen, children }: any) => (isOpen ? <View>{children}</View> : null),
        ModalBackdrop: () => null,
        ModalContent: (p: any) => <View {...p} />,
        ModalHeader: (p: any) => <View {...p} />,
        ModalBody: (p: any) => <View {...p} />,
        ModalFooter: (p: any) => <View {...p} />,
    };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const mockRequestOtp = jest.fn(async (..._a: unknown[]) => ({ ok: true } as const));
const mockConfirmOtp = jest.fn(async (..._a: unknown[]) => ({ ok: true } as const));
jest.mock('@/lib/subscription/email-capture', () => ({
    requestEmailOtp: (...a: unknown[]) => mockRequestOtp(...a),
    confirmEmailOtp: (...a: unknown[]) => mockConfirmOtp(...a),
    subscribeEmailCapture: jest.fn(() => () => {}),
    completeEmailCapture: jest.fn(),
}));

import { EmailCaptureSheet } from '../EmailCaptureSheet';

beforeEach(() => {
    jest.clearAllMocks();
});

it('Not now reports dismissed', async () => {
    const onOutcome = jest.fn();
    const onClose = jest.fn();
    const { findByTestId } = render(
        <EmailCaptureSheet isOpen onClose={onClose} onOutcome={onOutcome} />,
    );

    fireEvent.press(await findByTestId('email-capture-not-now'));

    expect(onOutcome).toHaveBeenCalledWith('dismissed');
    expect(onClose).toHaveBeenCalled();
});

it('the full email -> OTP -> done flow reports verified on close', async () => {
    const onOutcome = jest.fn();
    const { findByTestId } = render(
        <EmailCaptureSheet isOpen onClose={jest.fn()} onOutcome={onOutcome} />,
    );

    fireEvent.changeText(await findByTestId('email-capture-email-input'), 'a@b.com');
    fireEvent.press(await findByTestId('email-capture-continue'));
    fireEvent.changeText(await findByTestId('email-capture-otp-input'), '123456');
    fireEvent.press(await findByTestId('email-capture-confirm'));
    fireEvent.press(await findByTestId('email-capture-done'));

    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith('verified'));
    expect(mockConfirmOtp).toHaveBeenCalledWith('a@b.com', '123456');
});
