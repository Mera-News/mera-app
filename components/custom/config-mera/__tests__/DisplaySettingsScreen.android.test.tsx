/* eslint-disable @typescript-eslint/no-require-imports */
// Android-only coverage for DisplaySettingsScreen's Visuals section.
//
// `SHOWS_STATIC_GRADIENT_ROW` (Platform.OS !== 'android') is read at MODULE
// LOAD time, so exercising the Android branch needs Platform.OS mocked
// BEFORE the component module is imported — a separate file, not a
// runtime toggle inside DisplaySettingsScreen.test.tsx. This is the whole
// reason blur images moved OUTSIDE that gate when Security was folded in:
// blur must survive on Android (the platform the user was reporting from),
// unlike the static-gradient row.
// A Proxy over the actual module, NOT an object spread — spreading would
// enumerate (and eagerly evaluate) every lazy getter on react-native's
// export object, including deprecated NativeComponent specs that Jest's
// default transform can't parse. Same pattern as ManageDataScreen.test.tsx's
// ScrollView stub, just overriding `Platform` instead.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const mockedPlatform = { OS: 'android', select: (o: any) => o.android ?? o.default };
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'Platform') return mockedPlatform;
            return (target as any)[prop];
        },
    });
});

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

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

jest.mock('@/components/custom/auth/PinSetupScreen', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="pin-setup-screen" {...p} /> };
});
jest.mock('@/components/custom/auth/PinLockScreen', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="pin-lock-screen" {...p} /> };
});

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), captureException: jest.fn() },
}));

jest.mock('@/lib/stores/display-prefs-store', () => ({
    useDisplayPrefsStore: (selector: any) => selector({ staticGradient: false, setStaticGradient: jest.fn() }),
}));
jest.mock('@/lib/stores/text-scale-store', () => ({
    useTextScaleStore: (selector: any) => selector({ scale: 1, setScale: jest.fn() }),
}));
jest.mock('@/lib/stores/pin-store', () => ({
    usePinStore: (selector: any) => selector({ lockEnabled: false, setLockEnabled: jest.fn() }),
}));
jest.mock('@/lib/stores/blur-images-store', () => ({
    useBlurImagesStore: (selector: any) => selector({ blurImages: true, setBlurImages: jest.fn() }),
}));
jest.mock('@/lib/stores/startup-tab-store', () => ({
    useStartupTabStore: (selector: any) => selector({ startupTab: 'feed', setStartupTab: jest.fn() }),
}));

import { render } from '@testing-library/react-native';
import React from 'react';
import DisplaySettingsScreen from '../DisplaySettingsScreen';

describe('DisplaySettingsScreen on Android', () => {
    it('hides the static-gradient row but keeps blur images', () => {
        const { getByTestId, queryByTestId } = render(<DisplaySettingsScreen onBack={jest.fn()} />);
        expect(getByTestId('blur-images-switch')).toBeTruthy();
        expect(queryByTestId('static-gradient-switch')).toBeNull();
    });
});
