/* eslint-disable @typescript-eslint/no-require-imports */
// Tests for the opt-in PIN toggle in Settings → Security. The behaviour that
// matters and is easy to regress: turning the lock ON must not write the
// preference until a fresh PIN has actually been set, so a cancelled setup
// leaves the user exactly as they were.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// The animated gradient backdrop is pure decoration and asserts nothing here,
// but it imports react-native-reanimated, whose worklets runtime cannot
// initialise under Jest. Stubbing the component keeps reanimated out of this
// suite's module graph entirely — cheaper and less fragile than mocking the
// whole animation library for a view that renders no testable content.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
}));

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// --- gluestack ui + icons → RN primitives ---------------------------------
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View testID="spinner" {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/switch', () => {
    const { Pressable } = require('react-native');
    return {
        Switch: ({ onToggle, value, testID, ...p }: any) => (
            <Pressable
                testID={testID ?? 'lock-switch'}
                accessibilityState={{ checked: value }}
                onPress={() => onToggle(!value)}
                {...p}
            />
        ),
    };
});
jest.mock('@/components/ui/toast', () => ({
    useToast: () => ({ show: jest.fn() }),
    Toast: (p: any) => { const { View } = require('react-native'); return <View {...p} />; },
    ToastTitle: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
    ToastDescription: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
}));
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

// --- PIN screens → stubs that expose their callbacks -----------------------
jest.mock('@/components/custom/auth/PinSetupScreen', () => {
    const { Pressable, View } = require('react-native');
    return {
        __esModule: true,
        default: ({ onComplete, onCancel }: any) => (
            <View testID="pin-setup-screen">
                <Pressable testID="pin-setup-complete" onPress={onComplete} />
                <Pressable testID="pin-setup-cancel" onPress={onCancel} />
            </View>
        ),
    };
});
jest.mock('@/components/custom/auth/PinLockScreen', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="pin-lock-screen" {...p} /> };
});

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), captureException: jest.fn() },
}));

const mockSetLockEnabled = jest.fn(() => Promise.resolve());
let mockLockEnabled = false;

jest.mock('@/lib/stores/pin-store', () => ({
    usePinStore: (selector: any) =>
        selector({ lockEnabled: mockLockEnabled, setLockEnabled: mockSetLockEnabled }),
}));

const mockSetBlurImages = jest.fn();
let mockBlurImages = false;

jest.mock('@/lib/stores/blur-images-store', () => ({
    useBlurImagesStore: (selector: any) =>
        selector({ blurImages: mockBlurImages, setBlurImages: mockSetBlurImages }),
}));

import SecuritySettingsScreen from '../SecuritySettingsScreen';

beforeEach(() => {
    jest.clearAllMocks();
    mockLockEnabled = false;
    mockBlurImages = false;
});

describe('SecuritySettingsScreen — require-PIN toggle', () => {
    it('with the lock off, hides Change PIN (there is no PIN to change)', () => {
        const { queryByText } = render(<SecuritySettingsScreen onBack={jest.fn()} />);
        expect(queryByText('security.requirePinTitle')).toBeTruthy();
        expect(queryByText('security.changePin')).toBeNull();
    });

    it('turning the lock on opens PIN setup without persisting anything yet', () => {
        const { getByTestId, queryByTestId } = render(<SecuritySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('lock-switch'));
        expect(queryByTestId('pin-setup-screen')).toBeTruthy();
        // The preference must not be written before a PIN actually exists.
        expect(mockSetLockEnabled).not.toHaveBeenCalled();
    });

    it('cancelling PIN setup returns to the menu with the lock still off', () => {
        const { getByTestId, queryByTestId, queryByText } = render(
            <SecuritySettingsScreen onBack={jest.fn()} />,
        );
        fireEvent.press(getByTestId('lock-switch'));
        fireEvent.press(getByTestId('pin-setup-cancel'));
        expect(queryByTestId('pin-setup-screen')).toBeNull();
        expect(queryByText('security.requirePinTitle')).toBeTruthy();
        expect(mockSetLockEnabled).not.toHaveBeenCalled();
    });

    it('completing PIN setup records the opt-in and returns to the menu', async () => {
        const { getByTestId, queryByTestId } = render(<SecuritySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('lock-switch'));
        fireEvent.press(getByTestId('pin-setup-complete'));
        await waitFor(() => expect(mockSetLockEnabled).toHaveBeenCalledWith(true));
        await waitFor(() => expect(queryByTestId('pin-setup-screen')).toBeNull());
    });

    it('turning the lock off disables it directly (no PIN prompt) and shows Change PIN while on', async () => {
        mockLockEnabled = true;
        const { getByTestId, queryByText, queryByTestId } = render(
            <SecuritySettingsScreen onBack={jest.fn()} />,
        );
        expect(queryByText('security.changePin')).toBeTruthy();
        fireEvent.press(getByTestId('lock-switch'));
        await waitFor(() => expect(mockSetLockEnabled).toHaveBeenCalledWith(false));
        expect(queryByTestId('pin-setup-screen')).toBeNull();
    });

    it('Change PIN goes through verification of the current PIN first', () => {
        mockLockEnabled = true;
        const { getByText, queryByTestId } = render(<SecuritySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByText('security.changePin'));
        expect(queryByTestId('pin-lock-screen')).toBeTruthy();
    });
});

describe('SecuritySettingsScreen — blur-images toggle', () => {
    it('renders the blur-images row bound to the store value', () => {
        mockBlurImages = true;
        const { getByTestId, getByText } = render(<SecuritySettingsScreen onBack={jest.fn()} />);
        expect(getByText('security.blurImagesTitle')).toBeTruthy();
        expect(getByTestId('blur-images-switch').props.accessibilityState.checked).toBe(true);
    });

    it('fires setBlurImages with the flipped value on toggle', () => {
        mockBlurImages = false;
        const { getByTestId } = render(<SecuritySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('blur-images-switch'));
        expect(mockSetBlurImages).toHaveBeenCalledWith(true);
    });
});
