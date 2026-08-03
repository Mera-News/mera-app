/* eslint-disable @typescript-eslint/no-require-imports */
// Tests for Settings → Display. The one thing worth pinning: the toggle is
// bound to the display-prefs store in both directions, because it is the only
// way a user can turn the animated backdrop off.
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

import DisplaySettingsScreen from '../DisplaySettingsScreen';

beforeEach(() => {
    jest.clearAllMocks();
    mockStaticGradient = false;
});

describe('DisplaySettingsScreen', () => {
    it('renders the screen chrome and the static-background row', () => {
        const { getByText } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByText('display.title')).toBeTruthy();
        expect(getByText('display.subtitle')).toBeTruthy();
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
});
