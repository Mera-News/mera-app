/* eslint-disable @typescript-eslint/no-require-imports */
// Tests for Settings → Text & Display.
//
// Two bindings are worth pinning, because each is the ONLY way a user can reach
// the setting behind it: the static-background toggle (display-prefs store) and
// the text-size stepper (text-scale store).
//
// Copy is asserted by KEY, never by English text — `t` is mocked to echo the
// key, and the new strings are spliced into the locale files separately.
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

// The animated gradient backdrop is pure decoration here, but it imports
// react-native-reanimated, whose worklets runtime cannot initialise under
// Jest. Stubbing the component keeps reanimated out of this suite's module
// graph entirely — same reasoning as SecuritySettingsScreen.test.tsx.
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
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

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

import DisplaySettingsScreen from '../DisplaySettingsScreen';

import { TEXT_SCALE_STEPS } from '@/lib/typography/scale';

beforeEach(() => {
    jest.clearAllMocks();
    mockStaticGradient = false;
    mockTextScale = 1;
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
