// TranslatableDynamic (r6b) — verifies the `onDisplayChange` callback fires
// (in an effect) with the effective displayed text AND the language that text
// is in, so a parent can mirror the exact title variant the reader sees. Covers
// the no-translation paths:
//   • appLanguage 'en' → the English `text` is shown (showingOriginal false);
//   • original already in the app language → the original is shown
//     (showingOriginal true);
//   • translation unavailable/pending → the ORIGINAL is shown while
//     showingOriginal is still false, which is exactly why `displayedLanguage`
//     exists and the boolean isn't enough (see lib/hooks/useShareArticle.ts).
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
            displayedLanguage: 'en',
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
            displayedLanguage: 'pt',
        });
    });

    it('reports the original language while the translation is unavailable, though showingOriginal is false', async () => {
        // translateText is mocked to resolve null, so this is the permanent
        // "OS can't translate this" state as well as the pending window.
        mockAppLanguage = 'de';
        const onDisplayChange = jest.fn();
        render(
            <TranslatableDynamic
                text="Breaking news headline"
                originalText="Manchete de última hora"
                originalLanguage="pt-BR"
                onDisplayChange={onDisplayChange}
            />,
        );
        await waitFor(() => expect(onDisplayChange).toHaveBeenCalled());
        expect(onDisplayChange).toHaveBeenLastCalledWith({
            showingOriginal: false,
            displayedText: 'Manchete de última hora',
            // canonicalized: `pt-BR` → `pt`
            displayedLanguage: 'pt',
        });
    });

    it('reports English when there is no original to fall back to', async () => {
        mockAppLanguage = 'de';
        const onDisplayChange = jest.fn();
        render(
            <TranslatableDynamic
                text="Breaking news headline"
                onDisplayChange={onDisplayChange}
            />,
        );
        await waitFor(() => expect(onDisplayChange).toHaveBeenCalled());
        expect(onDisplayChange).toHaveBeenLastCalledWith({
            showingOriginal: false,
            displayedText: 'Breaking news headline',
            displayedLanguage: 'en',
        });
    });
});
