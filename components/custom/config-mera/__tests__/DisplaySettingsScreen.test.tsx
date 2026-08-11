/* eslint-disable @typescript-eslint/no-require-imports */
// Tests for Settings → Display.
//
// This screen now owns what used to be three screens' worth of controls:
// text size + static-background (always here), and — folded in from the
// deleted SecuritySettingsScreen — the require-PIN toggle, Change PIN, and
// blur-images. Plus a new startup-tab picker.
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

const mockSetStaticGradient = jest.fn();
let mockStaticGradient = false;

jest.mock('@/lib/stores/display-prefs-store', () => ({
    useDisplayPrefsStore: (selector: any) =>
        selector({ staticGradient: mockStaticGradient, setStaticGradient: mockSetStaticGradient }),
}));

const mockSetTextScale = jest.fn();
let mockTextScale = 1;

// The store is mocked wholesale — it reaches WatermelonDB, and `requireActual`
// would instantiate the SQLite adapter. The step list is NOT mocked: it lives in
// `lib/typography/scale.ts` precisely so it can be imported without the DB, so
// the option set under test is the shipped one.
jest.mock('@/lib/stores/text-scale-store', () => ({
    useTextScaleStore: (selector: any) =>
        selector({ scale: mockTextScale, setScale: mockSetTextScale }),
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

const mockSetStartupTab = jest.fn();
let mockStartupTab: 'feed' | 'for_you' | 'around' = 'feed';

jest.mock('@/lib/stores/startup-tab-store', () => ({
    useStartupTabStore: (selector: any) =>
        selector({ startupTab: mockStartupTab, setStartupTab: mockSetStartupTab }),
}));

import DisplaySettingsScreen from '../DisplaySettingsScreen';

import { TEXT_SCALE_STEPS } from '@/lib/typography/scale';

beforeEach(() => {
    jest.clearAllMocks();
    mockStaticGradient = false;
    mockTextScale = 1;
    mockLockEnabled = false;
    mockBlurImages = false;
    mockStartupTab = 'feed';
});

describe('DisplaySettingsScreen', () => {
    it('renders the screen chrome and both sections', () => {
        const { getByText } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByText('display.screenTitle')).toBeTruthy();
        expect(getByText('display.screenSubtitle')).toBeTruthy();
        expect(getByText('display.sectionText')).toBeTruthy();
        expect(getByText('display.sectionVisuals')).toBeTruthy();
        expect(getByText('display.staticGradientTitle')).toBeTruthy();
        expect(getByText('display.staticGradientDescription')).toBeTruthy();
    });

    it('reflects the stored preference on the switch', () => {
        mockStaticGradient = true;
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByTestId('static-gradient-switch').props.accessibilityState.checked).toBe(true);
    });

    it('fires setStaticGradient with the flipped value on toggle', () => {
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('static-gradient-switch'));
        expect(mockSetStaticGradient).toHaveBeenCalledWith(true);
    });

    it('calls onBack from the header back button', () => {
        const onBack = jest.fn();
        const { getByTestId } = render(<DisplaySettingsScreen onBack={onBack} />);
        fireEvent.press(getByTestId('display-back'));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    // ── text size ─────────────────────────────────────────────────────────
    it('renders one option per shipped text-scale step', () => {
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        for (const name of ['compact', 'default', 'large', 'larger']) {
            expect(getByTestId(`text-size-${name}`)).toBeTruthy();
        }
        expect(TEXT_SCALE_STEPS).toHaveLength(4);
    });

    // "Largest" (1.5) was removed — only four steps ship now.
    it('does not render a "largest" option', () => {
        const { queryByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(queryByTestId('text-size-largest')).toBeNull();
    });

    it('marks the stored step as selected', () => {
        mockTextScale = 1.3;
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByTestId('text-size-larger').props.accessibilityState.selected).toBe(true);
        expect(getByTestId('text-size-default').props.accessibilityState.selected).toBe(false);
    });

    it('defaults the selection to 1x when nothing is stored', () => {
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByTestId('text-size-default').props.accessibilityState.selected).toBe(true);
    });

    it('persists the tapped step', () => {
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('text-size-larger'));
        expect(mockSetTextScale).toHaveBeenCalledWith(TEXT_SCALE_STEPS[3]);
    });

    it('renders the live preview block', () => {
        const { getByTestId, getByText } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByTestId('text-size-preview')).toBeTruthy();
        expect(getByText('display.textSizePreviewHeadline')).toBeTruthy();
    });

    // Every option must clear the 44pt minimum target — the whole control is
    // an accessibility affordance, so a cramped one would be self-defeating.
    it('gives every option a 44pt minimum touch height', () => {
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        for (const name of ['compact', 'default', 'large', 'larger']) {
            expect(getByTestId(`text-size-${name}`).props.style.minHeight).toBe(44);
        }
    });
});

// ── Security, folded in from the deleted SecuritySettingsScreen ───────────
describe('DisplaySettingsScreen — require-PIN toggle', () => {
    it('with the lock off, hides Change PIN (there is no PIN to change)', () => {
        const { queryByText } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(queryByText('security.requirePinTitle')).toBeTruthy();
        expect(queryByText('security.changePin')).toBeNull();
    });

    it('turning the lock on opens PIN setup without persisting anything yet', () => {
        const { getByTestId, queryByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('lock-switch'));
        expect(queryByTestId('pin-setup-screen')).toBeTruthy();
        // The preference must not be written before a PIN actually exists.
        expect(mockSetLockEnabled).not.toHaveBeenCalled();
    });

    it('cancelling PIN setup returns to the menu with the lock still off', () => {
        const { getByTestId, queryByTestId, queryByText } = render(
            <DisplaySettingsScreen onBack={jest.fn()} />,
        );
        fireEvent.press(getByTestId('lock-switch'));
        fireEvent.press(getByTestId('pin-setup-cancel'));
        expect(queryByTestId('pin-setup-screen')).toBeNull();
        expect(queryByText('security.requirePinTitle')).toBeTruthy();
        expect(mockSetLockEnabled).not.toHaveBeenCalled();
    });

    it('completing PIN setup records the opt-in and returns to the menu', async () => {
        const { getByTestId, queryByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('lock-switch'));
        fireEvent.press(getByTestId('pin-setup-complete'));
        await waitFor(() => expect(mockSetLockEnabled).toHaveBeenCalledWith(true));
        await waitFor(() => expect(queryByTestId('pin-setup-screen')).toBeNull());
    });

    it('turning the lock off disables it directly (no PIN prompt) and shows Change PIN while on', async () => {
        mockLockEnabled = true;
        const { getByTestId, queryByText, queryByTestId } = render(
            <DisplaySettingsScreen onBack={jest.fn()} />,
        );
        expect(queryByText('security.changePin')).toBeTruthy();
        fireEvent.press(getByTestId('lock-switch'));
        await waitFor(() => expect(mockSetLockEnabled).toHaveBeenCalledWith(false));
        expect(queryByTestId('pin-setup-screen')).toBeNull();
    });

    it('Change PIN goes through verification of the current PIN first', () => {
        mockLockEnabled = true;
        const { getByText, queryByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByText('security.changePin'));
        expect(queryByTestId('pin-lock-screen')).toBeTruthy();
    });
});

describe('DisplaySettingsScreen — blur-images toggle', () => {
    it('renders the blur-images row bound to the store value', () => {
        mockBlurImages = true;
        const { getByTestId, getByText } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByText('security.blurImagesTitle')).toBeTruthy();
        expect(getByTestId('blur-images-switch').props.accessibilityState.checked).toBe(true);
    });

    it('fires setBlurImages with the flipped value on toggle', () => {
        mockBlurImages = false;
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('blur-images-switch'));
        expect(mockSetBlurImages).toHaveBeenCalledWith(true);
    });

    // The Android-hides-static-gradient-but-not-blur behavior (why blur moved
    // OUTSIDE the SHOWS_STATIC_GRADIENT_ROW gate, per that constant's doc
    // comment in DisplaySettingsScreen.tsx) is a module-load-time Platform.OS
    // read, not reachable from this file without re-importing the module
    // under a mocked react-native — see DisplaySettingsScreen.android.test.tsx
    // (this same directory) for that coverage.
});

// ── Startup tab (new) ───────────────────────────────────────────────────
describe('DisplaySettingsScreen — startup tab picker', () => {
    it('renders one option per tab, plus the section chrome', () => {
        const { getByTestId, getByText } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByText('display.sectionStartup')).toBeTruthy();
        expect(getByText('display.startupTabTitle')).toBeTruthy();
        expect(getByTestId('startup-tab-feed')).toBeTruthy();
        expect(getByTestId('startup-tab-for_you')).toBeTruthy();
        expect(getByTestId('startup-tab-around')).toBeTruthy();
    });

    it('marks the stored preference as selected', () => {
        mockStartupTab = 'around';
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByTestId('startup-tab-around').props.accessibilityState.selected).toBe(true);
        expect(getByTestId('startup-tab-feed').props.accessibilityState.selected).toBe(false);
    });

    it('defaults to Feed selected when nothing is stored', () => {
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByTestId('startup-tab-feed').props.accessibilityState.selected).toBe(true);
    });

    it('persists the tapped tab using its real route name, not its label', () => {
        const { getByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('startup-tab-for_you'));
        expect(mockSetStartupTab).toHaveBeenCalledWith('for_you');
    });
});
