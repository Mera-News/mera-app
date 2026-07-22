// TranslatableDynamic (r6b) — verifies the `onDisplayChange` callback fires
// (in an effect) with the effective displayed text, so a parent can mirror the
// exact title variant the reader sees. Covers the two no-translation paths:
//   • appLanguage 'en' → the English `text` is shown (showingOriginal false);
//   • original already in the app language → the original is shown
//     (showingOriginal true).
/* eslint-disable @typescript-eslint/no-require-imports */

let mockAppLanguage = 'en';

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/lib/stores/app-language-store', () => {
    const makeState = () => ({
        appLanguage: mockAppLanguage,
        cache: new Map<string, string>(),
        pending: new Set<string>(),
        addPending: jest.fn(),
        removePending: jest.fn(),
        cacheTranslation: jest.fn(),
    });
    const useAppLanguageStore = (selector?: (s: any) => unknown) =>
        selector ? selector(makeState()) : makeState();
    (useAppLanguageStore as any).getState = () => makeState();
    return { useAppLanguageStore };
});

jest.mock('@/lib/translation-service', () => ({
    translateText: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('@/lib/visibility-tick', () => ({
    subscribeScrollTick: jest.fn(() => () => {}),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), warn: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

jest.mock('@/components/ui/heading', () => {
    const { Text } = require('react-native');
    return { Heading: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});

import { render, waitFor } from '@testing-library/react-native';
import React from 'react';
import TranslatableDynamic from '../TranslatableDynamic';

describe('TranslatableDynamic onDisplayChange', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAppLanguage = 'en';
    });

    it('fires with the English text when appLanguage is en (showingOriginal false)', async () => {
        const onDisplayChange = jest.fn();
        render(
            <TranslatableDynamic
                text="Breaking news headline"
                originalText="Manchete de última hora"
                originalLanguage="pt"
                onDisplayChange={onDisplayChange}
            />,
        );
        await waitFor(() => expect(onDisplayChange).toHaveBeenCalled());
        expect(onDisplayChange).toHaveBeenLastCalledWith({
            showingOriginal: false,
            displayedText: 'Breaking news headline',
        });
    });

    it('fires with the original text when it already matches the app language (showingOriginal true)', async () => {
        mockAppLanguage = 'pt';
        const onDisplayChange = jest.fn();
        render(
            <TranslatableDynamic
                text="Breaking news headline"
                originalText="Manchete de última hora"
                originalLanguage="pt"
                onDisplayChange={onDisplayChange}
            />,
        );
        await waitFor(() => expect(onDisplayChange).toHaveBeenCalled());
        expect(onDisplayChange).toHaveBeenLastCalledWith({
            showingOriginal: true,
            displayedText: 'Manchete de última hora',
        });
    });
});
