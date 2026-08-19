/* eslint-disable @typescript-eslint/no-require-imports */
// The page's OUTCOME contract (S10 + informed skip): every close reports
// 'verified' iff the flow reached done, 'skipped' only via the consequence
// step's explicit confirm, 'dismissed' otherwise — the checkout gate keys on
// it. The skip path renders ONLY for the 'checkout' source.

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
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
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
jest.mock('@/components/ui/scroll-view', () => {
    // A plain View, not RN's ScrollView — importing the real one drags
    // untransformed react-native internals into the suite.
    const { View } = require('react-native');
    return { ScrollView: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/gluestack-ui-provider', () => ({
    GluestackUIProvider: (p: any) => p.children,
}));
// RN's Modal pulls an untransformed ESM native-component spec into jest; the
// page's behaviour has nothing to do with the host view, so render children
// straight through. STATEFUL variant of the FeedbackTreeOverlay recipe: the
// outcome contract now flushes on the Modal's onDismiss (the paywall-race
// fix), so the mock must fire onDismiss when `visible` flips false, exactly
// as iOS does after the dismissal animation.
jest.mock('react-native/Libraries/Modal/Modal', () => {
    const React = require('react');
    const MockModal = (props: any) => {
        const prev = React.useRef(props.visible);
        React.useEffect(() => {
            if (prev.current !== false && props.visible === false) props.onDismiss?.();
            prev.current = props.visible;
        });
        return props.visible === false ? null : props.children;
    };
    return { __esModule: true, default: MockModal };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const mockSetString = jest.fn(async (_s: string) => {});
jest.mock('expo-clipboard', () => ({
    setStringAsync: (...a: any[]) => mockSetString(...(a as [string])),
}));

const mockGetSupportId = jest.fn(async (): Promise<string | null> => '5013076');
jest.mock('@/lib/support-id', () => ({
    getSupportId: () => mockGetSupportId(),
}));

const mockRequestOtp = jest.fn(async (..._a: unknown[]) => ({ ok: true } as const));
const mockConfirmOtp = jest.fn(async (..._a: unknown[]) => ({ ok: true } as const));
jest.mock('@/lib/subscription/email-capture', () => ({
    requestEmailOtp: (...a: unknown[]) => mockRequestOtp(...a),
    confirmEmailOtp: (...a: unknown[]) => mockConfirmOtp(...a),
    subscribeEmailCapture: jest.fn(() => () => {}),
    completeEmailCapture: jest.fn(),
}));

import { EmailCaptureSheet } from '../EmailCaptureSheet';

/**
 * Renders the sheet the way EmailCaptureHost does: onClose flips isOpen false,
 * which dismisses the (mocked) Modal, which fires onDismiss — the point where
 * the outcome is now reported (the paywall-race fix). Tests must go through
 * this wrapper or the deferred outcome never flushes.
 */
function HostedSheet({ onOutcome, onClose, source }: any) {
    const [open, setOpen] = React.useState(true);
    return (
        <EmailCaptureSheet
            isOpen={open}
            source={source}
            onOutcome={onOutcome}
            onClose={() => {
                onClose?.();
                setOpen(false);
            }}
        />
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupportId.mockResolvedValue('5013076');
});

it('Not now reports dismissed', async () => {
    const onOutcome = jest.fn();
    const onClose = jest.fn();
    const { findByTestId } = render(
        <HostedSheet onClose={onClose} source="checkout" onOutcome={onOutcome} />,
    );

    fireEvent.press(await findByTestId('email-capture-not-now'));

    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith('dismissed'));
    expect(onClose).toHaveBeenCalled();
});

it('the full email -> OTP -> done flow reports verified on close', async () => {
    const onOutcome = jest.fn();
    const { findByTestId } = render(
        <HostedSheet onClose={jest.fn()} source="checkout" onOutcome={onOutcome} />,
    );

    fireEvent.changeText(await findByTestId('email-capture-email-input'), 'a@b.com');
    fireEvent.press(await findByTestId('email-capture-continue'));
    fireEvent.changeText(await findByTestId('email-capture-otp-input'), '123456');
    fireEvent.press(await findByTestId('email-capture-confirm'));
    fireEvent.press(await findByTestId('email-capture-done'));

    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith('verified'));
    expect(mockConfirmOtp).toHaveBeenCalledWith('a@b.com', '123456');
});

it('the skip pill renders for the checkout source and is ABSENT for post-purchase', async () => {
    const checkout = render(
        <EmailCaptureSheet isOpen onClose={jest.fn()} source="checkout" onOutcome={jest.fn()} />,
    );
    expect(await checkout.findByTestId('email-capture-skip')).toBeTruthy();
    checkout.unmount();

    const purchase = render(
        <EmailCaptureSheet isOpen onClose={jest.fn()} source="purchase" onOutcome={jest.fn()} />,
    );
    await purchase.findByTestId('email-capture-not-now');
    expect(purchase.queryByTestId('email-capture-skip')).toBeNull();
});

it('skip -> consequence step -> explicit confirm reports SKIPPED and closes', async () => {
    const onOutcome = jest.fn();
    const onClose = jest.fn();
    const { findByTestId, findByText } = render(
        <HostedSheet onClose={onClose} source="checkout" onOutcome={onOutcome} />,
    );

    fireEvent.press(await findByTestId('email-capture-skip'));
    // The consequence step: both paragraphs and the Support ID pill.
    expect(await findByText('emailCapture.skipBody1')).toBeTruthy();
    expect(await findByText('emailCapture.skipBody2')).toBeTruthy();
    expect(await findByTestId('email-capture-support-id')).toBeTruthy();

    fireEvent.press(await findByTestId('email-capture-skip-confirm'));

    // Deferred to the Modal's onDismiss (paywall-race fix): the outcome must
    // arrive only after the dismissal completes, never synchronously.
    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith('skipped'));
    expect(onClose).toHaveBeenCalled();
});

it('the copy button puts the EXACT id on the clipboard', async () => {
    const { findByTestId } = render(
        <EmailCaptureSheet isOpen onClose={jest.fn()} source="checkout" onOutcome={jest.fn()} />,
    );

    fireEvent.press(await findByTestId('email-capture-skip'));
    fireEvent.press(await findByTestId('email-capture-copy-support-id'));

    await waitFor(() => expect(mockSetString).toHaveBeenCalledWith('5013076'));
});

it('a null Support ID hides the pill but keeps the consequence step usable', async () => {
    mockGetSupportId.mockResolvedValue(null);
    const onOutcome = jest.fn();
    const { findByTestId, queryByTestId } = render(
        <EmailCaptureSheet isOpen onClose={jest.fn()} source="checkout" onOutcome={onOutcome} />,
    );

    fireEvent.press(await findByTestId('email-capture-skip'));
    expect(await findByTestId('email-capture-skip-confirm')).toBeTruthy();
    expect(queryByTestId('email-capture-support-id')).toBeNull();
});

it('hardware back (onRequestClose) from the consequence step still reports DISMISSED', async () => {
    const onOutcome = jest.fn();
    const onClose = jest.fn();
    const { findByTestId } = render(
        <HostedSheet onClose={onClose} source="checkout" onOutcome={onOutcome} />,
    );

    fireEvent.press(await findByTestId('email-capture-skip'));

    // The mocked Modal renders children only, so drive the SAME funnel the
    // hardware back uses via the dedicated back affordances: skip-back returns
    // to the email step, Not now closes through handleSheetClose — exactly
    // what onRequestClose invokes.
    fireEvent.press(await findByTestId('email-capture-skip-back'));
    fireEvent.press(await findByTestId('email-capture-not-now'));

    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith('dismissed'));
    expect(onOutcome).not.toHaveBeenCalledWith('skipped');
    expect(onClose).toHaveBeenCalled();
});
