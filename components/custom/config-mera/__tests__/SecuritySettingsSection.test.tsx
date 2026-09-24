/* eslint-disable @typescript-eslint/no-require-imports */
// Tests for Settings > Security.
//
// Settings > Security: the PIN lock, directly in the Settings list. The ONLY
// surface that may turn the lock on (mera-app-persona invariant 7).
//
// Copy is asserted by KEY, never by English text — `t` is mocked to echo the
// key, and the new strings are spliced into the locale files separately.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// The animated gradient backdrop is pure decoration here, but it imports
// react-native-reanimated, whose worklets runtime cannot initialise under
// Jest. Stubbing the component keeps reanimated out of this suite's module
// graph entirely.
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
    useTranslation: () => ({ t: (k: string, opts?: any) => (opts ? `${k}:${JSON.stringify(opts)}` : k) }),
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
jest.mock('@/components/ui/scroll-view', () => { const { View } = require('react-native'); return { ScrollView: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/switch', () => {
    const { Pressable } = require('react-native');
    return {
        Switch: ({ onToggle, value, testID, ...p }: any) => (
            <Pressable
                testID={testID}
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
// Icons render a real private-use glyph, so a label that leaks one fails.
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

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

const mockSetStaticGradient = jest.fn();
let mockStaticGradient = false;

jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return { __esModule: true, GlassPanel: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/gluestack-ui-provider', () => ({ GluestackUIProvider: ({ children }: any) => children }));
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'Modal') {
                return ({ visible, children }: any) => (visible ? children : null);
            }
            return (target as any)[prop];
        },
    });
});

const mockSetLockEnabled = jest.fn(() => Promise.resolve());
let mockLockEnabled = false;
jest.mock('@/lib/stores/pin-store', () => ({
    usePinStore: (selector: any) =>
        selector({ lockEnabled: mockLockEnabled, setLockEnabled: mockSetLockEnabled }),
}));

import SecuritySettingsSection from '../SecuritySettingsSection';

beforeEach(() => {
    jest.clearAllMocks();
    mockLockEnabled = false;
});

describe('SecuritySettingsSection — require-PIN toggle', () => {
    it('with the lock off, hides Change PIN (there is no PIN to change)', () => {
        const { queryByText } = render(<SecuritySettingsSection />);
        expect(queryByText('security.requirePinTitle')).toBeTruthy();
        expect(queryByText('security.changePin')).toBeNull();
    });

    it('turning the lock on opens PIN setup without persisting anything yet', () => {
        const { getByTestId, queryByTestId } = render(<SecuritySettingsSection />);
        fireEvent.press(getByTestId('lock-switch'));
        expect(queryByTestId('pin-setup-screen')).toBeTruthy();
        // The preference must not be written before a PIN actually exists.
        expect(mockSetLockEnabled).not.toHaveBeenCalled();
    });

    it('cancelling PIN setup returns to the menu with the lock still off', () => {
        const { getByTestId, queryByTestId, queryByText } = render(<SecuritySettingsSection />);
        fireEvent.press(getByTestId('lock-switch'));
        fireEvent.press(getByTestId('pin-setup-cancel'));
        expect(queryByTestId('pin-setup-screen')).toBeNull();
        expect(queryByText('security.requirePinTitle')).toBeTruthy();
        expect(mockSetLockEnabled).not.toHaveBeenCalled();
    });

    it('completing PIN setup records the opt-in and returns to the menu', async () => {
        const { getByTestId, queryByTestId } = render(<SecuritySettingsSection />);
        fireEvent.press(getByTestId('lock-switch'));
        fireEvent.press(getByTestId('pin-setup-complete'));
        await waitFor(() => expect(mockSetLockEnabled).toHaveBeenCalledWith(true));
        await waitFor(() => expect(queryByTestId('pin-setup-screen')).toBeNull());
    });

    it('turning the lock off disables it directly (no PIN prompt) and shows Change PIN while on', async () => {
        mockLockEnabled = true;
        const { getByTestId, queryByText, queryByTestId } = render(
            <SecuritySettingsSection />,
        );
        expect(queryByText('security.changePin')).toBeTruthy();
        fireEvent.press(getByTestId('lock-switch'));
        await waitFor(() => expect(mockSetLockEnabled).toHaveBeenCalledWith(false));
        expect(queryByTestId('pin-setup-screen')).toBeNull();
    });

    it('Change PIN goes through verification of the current PIN first', () => {
        mockLockEnabled = true;
        const { getByText, queryByTestId } = render(<SecuritySettingsSection />);
        fireEvent.press(getByText('security.changePin'));
        expect(queryByTestId('pin-lock-screen')).toBeTruthy();
    });
});

describe('SecuritySettingsSection — every flow can be left', () => {
    it('Change PIN verification has its own Cancel (no swipe back inside a Modal)', () => {
        mockLockEnabled = true;
        const { getByText, getByTestId, queryByTestId } = render(<SecuritySettingsSection />);
        fireEvent.press(getByText('security.changePin'));
        expect(queryByTestId('pin-lock-screen')).toBeTruthy();
        fireEvent.press(getByTestId('pin-verify-cancel'));
        expect(queryByTestId('pin-lock-screen')).toBeNull();
        expect(mockSetLockEnabled).not.toHaveBeenCalled();
    });
});

describe('SecuritySettingsSection accessibility', () => {
    it('reads no icon glyph, Change PIN included', () => {
        mockLockEnabled = true;
        const { privateUseLabelLeaks } = require('@/lib/__test-helpers__/icon-glyph-a11y');
        const r = render(<SecuritySettingsSection />);
        expect(r.getByTestId('settings-row-change-pin').props.accessibilityLabel).toBe('security.changePin');
        expect(privateUseLabelLeaks(r.UNSAFE_root)).toEqual([]);
    });

    // Captured: the lock icon beside "Ask for a 4-digit PIN when you open Mera"
    // was its own StaticText holding only the glyph.
    it('hides the standalone lock icon from accessibility', () => {
        const r = render(<SecuritySettingsSection />);
        const glyphs = r.UNSAFE_root.findAll(
            (n: any) => typeof n.type === 'string' && /^[\uE000-\uF8FF]$/.test(String(n.props.children ?? '')),
        );
        expect(glyphs.length).toBeGreaterThan(0);
        for (const n of glyphs) {
            let hidden = false;
            for (let p: any = n; p; p = p.parent) {
                if (p.props?.accessibilityElementsHidden === true && p.props?.importantForAccessibility === 'no-hide-descendants') hidden = true;
                if (p.props?.accessible === true && p !== n) break;
            }
            // A glyph inside an accessible control is read through the
            // control's explicit label; only STANDALONE glyphs must be hidden.
            const inControl = (() => {
                for (let p: any = n.parent; p; p = p.parent) if (p.props?.accessible === true) return true;
                return false;
            })();
            if (!inControl) expect(hidden).toBe(true);
        }
    });
});
