/* eslint-disable @typescript-eslint/no-require-imports */
// Settings -> Language, and the two places it now touches the app restart.
//
// 1. The OS-settings trip. This screen sends the reader to iOS Settings or the
//    Android locale settings to download a language pack. Every true
//    background -> foreground return reloads the app, so without a hold the
//    return lands on a fresh process with useLanguageSwitch's pendingCode, its
//    busy flag and its timeout all gone — the reader has to pick the language
//    again, with no error and nothing to explain why.
// 2. The RTL restart prompt, which goes through the one restart authority
//    rather than calling Updates.reloadAsync() itself.
//
// Copy is asserted by KEY, never by English text — `t` is mocked to echo it.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

// TWO of RN's own components carry untranspiled ESM native-component specs
// under this jest config: ScrollView
// (AndroidHorizontalScrollContentViewNativeComponent) and Modal
// (RCTModalHostViewNativeComponent). Both throw during render, React unmounts
// the tree, and the visible failure names neither. Proxy so every OTHER RN
// export stays lazy and real — spreading `...actual` would touch every getter
// and pull both specs in anyway. Same pattern as ManageDataScreen.test.tsx,
// extended by one.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) =>
        ReactLib.createElement(actual.View, rest, children);
    StubScrollView.Context = ReactLib.createContext(null);
    // Honours `visible`, so the picker's mounted/unmounted states stay real.
    const StubModal = ({ children, visible, ...rest }: any) =>
        visible ? ReactLib.createElement(actual.View, rest, children) : null;
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') return StubScrollView;
            if (prop === 'Modal') return StubModal;
            // Linking has to come through the proxy too. Mocking
            // `react-native/Libraries/Linking/Linking` directly does NOT reach
            // this screen: it imports `Linking` from the RN index, and the
            // index's getter hands back the real module regardless.
            if (prop === 'Linking') {
                return { openURL: (u: string) => mockOpenURL(u), sendIntent: (i: string) => mockSendIntent(i) };
            }
            return (target as any)[prop];
        },
    });
});

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (k: string, opts?: any) => (opts ? `${k}:${JSON.stringify(opts)}` : k),
        i18n: { language: 'en' },
    }),
}));

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/gluestack-ui-provider', () => {
    const { View } = require('react-native');
    return { GluestackUIProvider: (p: any) => <View {...p} /> };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('../LanguageSwitchProgress', () => ({ __esModule: true, default: () => null }));
jest.mock('../LanguageDownloadHint', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/VideoPlayerModal', () => ({ __esModule: true, default: () => null }));

// --- the holds under test --------------------------------------------------
const mockImmediateRelease = jest.fn();
const mockHoldRestartAcrossPurchase = jest.fn((_label: string) => mockImmediateRelease);
jest.mock('@/lib/subscriptions/subscribe-flow', () => ({
    holdRestartAcrossPurchase: (label: string) => mockHoldRestartAcrossPurchase(label),
}));

const mockRequestRestart = jest.fn(async (_reason: string) => {});
jest.mock('@/lib/app-restart', () => ({
    requestRestart: (reason: string) => mockRequestRestart(reason),
}));

// --- OS settings -----------------------------------------------------------
const mockOpenURL = jest.fn(async (_u: string) => {});
const mockSendIntent = jest.fn(async (_i: string) => {});
jest.mock('@/lib/hooks/use-language-switch', () => ({
    useLanguageSwitch: () => ({
        requestSwitch: jest.fn(),
        notifyPickerDismissed: jest.fn(),
        cancel: jest.fn(),
        stage: 'idle',
        pendingCode: null,
        busy: false,
    }),
}));

jest.mock('@/lib/stores/app-language-store', () => ({
    useAppLanguageStore: Object.assign(
        (sel: any) => sel({ appLanguage: 'en' }),
        { getState: () => ({ appLanguage: 'en' }) },
    ),
}));

jest.mock('@/lib/translation-service', () => ({
    getLanguageName: (c: string) => c,
    SUPPORTED_LANGUAGES: [{ code: 'en', name: 'English' }, { code: 'ar', name: 'Arabic' }],
}));

jest.mock('@/lib/config/branding', () => ({ TRANSLATION_GUIDE_URL: 'https://example.invalid/guide' }));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { Platform } from 'react-native';
import logger from '@/lib/logger';
import LanguageSettingsScreen from '../LanguageSettingsScreen';

const mockLogger = logger as unknown as { captureException: jest.Mock };

const mountScreen = async () => {
    const r = render(<LanguageSettingsScreen />);
    await waitFor(() => r.getByTestId('language-open-os-settings'));
    return r;
};

beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'ios';
    mockOpenURL.mockResolvedValue(undefined);
    mockSendIntent.mockResolvedValue(undefined);
});

describe('the language-pack trip to OS settings', () => {
    it('holds the restart off, under its own label', async () => {
        const r = await mountScreen();

        fireEvent.press(r.getByTestId('language-open-os-settings'));

        await waitFor(() => expect(mockOpenURL).toHaveBeenCalled());
        expect(mockHoldRestartAcrossPurchase).toHaveBeenCalledWith('language-pack');
    });

    // The label is not cosmetic: it surfaces in `activeHolds()` and in the
    // `hold:` blocker string app-restart logs, which is the primary evidence a
    // simulator pass reads. A language-pack trip logging as a purchase misleads
    // whoever looks next.
    it('never labels itself a purchase', async () => {
        const r = await mountScreen();
        fireEvent.press(r.getByTestId('language-open-os-settings'));
        await waitFor(() => expect(mockHoldRestartAcrossPurchase).toHaveBeenCalled());
        expect(mockHoldRestartAcrossPurchase).not.toHaveBeenCalledWith('purchase');
    });

    it('is taken BEFORE the app leaves, not after', async () => {
        const order: string[] = [];
        mockHoldRestartAcrossPurchase.mockImplementation((_l: string) => {
            order.push('hold');
            return mockImmediateRelease;
        });
        mockOpenURL.mockImplementation(async () => { order.push('openURL'); });
        const r = await mountScreen();

        fireEvent.press(r.getByTestId('language-open-os-settings'));

        await waitFor(() => expect(order).toEqual(['hold', 'openURL']));
    });

    // The release is timer-owned. Calling it on the happy path would release
    // before the trip it protects — the user has not even left yet when
    // openURL resolves.
    it('does not release on the happy path', async () => {
        const r = await mountScreen();
        fireEvent.press(r.getByTestId('language-open-os-settings'));
        await waitFor(() => expect(mockOpenURL).toHaveBeenCalled());
        expect(mockImmediateRelease).not.toHaveBeenCalled();
    });

    // The one place the immediate release IS valid, for the same reason
    // openSubscribePage's catch is: nothing opened, so there is no trip to
    // protect and no reason to make the next return wait out the ceiling.
    // `App-Prefs:General` is not a guaranteed-openable scheme and this rejected
    // unhandled before.
    it('releases immediately and reports when nothing opened', async () => {
        mockOpenURL.mockRejectedValue(new Error('cannot open URL'));
        const r = await mountScreen();

        fireEvent.press(r.getByTestId('language-open-os-settings'));

        await waitFor(() => expect(mockImmediateRelease).toHaveBeenCalledTimes(1));
        expect(mockLogger.captureException).toHaveBeenCalled();
    });

    it('uses the Android locale intent on Android, and still holds', async () => {
        Platform.OS = 'android';
        const r = await mountScreen();

        fireEvent.press(r.getByTestId('language-open-os-settings'));

        await waitFor(() => expect(mockSendIntent).toHaveBeenCalledWith('android.settings.LOCALE_SETTINGS'));
        expect(mockOpenURL).not.toHaveBeenCalled();
        expect(mockHoldRestartAcrossPurchase).toHaveBeenCalledWith('language-pack');
    });

    it('releases on an Android intent that fails', async () => {
        Platform.OS = 'android';
        mockSendIntent.mockRejectedValue(new Error('no activity'));
        const r = await mountScreen();

        fireEvent.press(r.getByTestId('language-open-os-settings'));

        await waitFor(() => expect(mockImmediateRelease).toHaveBeenCalledTimes(1));
    });

    it('takes a fresh hold per trip rather than reusing one', async () => {
        const r = await mountScreen();
        fireEvent.press(r.getByTestId('language-open-os-settings'));
        await waitFor(() => expect(mockOpenURL).toHaveBeenCalledTimes(1));
        fireEvent.press(r.getByTestId('language-open-os-settings'));
        await waitFor(() => expect(mockOpenURL).toHaveBeenCalledTimes(2));

        expect(mockHoldRestartAcrossPurchase).toHaveBeenCalledTimes(2);
    });
});
