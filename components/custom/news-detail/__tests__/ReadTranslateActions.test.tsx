// ReadTranslateActions — shared read/translate CTA block used by both detail
// screens. Verifies the three getArticleTranslationSupport layouts:
// same-language (Read Article + GT, GT ALWAYS present — prod has mislabeled-
// language articles so GT must stay reachable even here), translatable (green
// "view & translate on device" + helper + GT), and not-translatable (white
// View-original-in-<language> + informational helper + suggested GT button).
// The publisher name deliberately appears on none of them.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, opts?: Record<string, unknown>) =>
            opts ? `${key}::${JSON.stringify(opts)}` : key,
    }),
}));

jest.mock('@/lib/stores/app-language-store', () => ({
    useAppLanguage: () => 'en',
}));

const mockGetArticleTranslationSupport = jest.fn();
const mockBuildGoogleTranslateUrl = jest.fn();
jest.mock('@/lib/translation-service', () => ({
    getArticleTranslationSupport: (...args: unknown[]) => mockGetArticleTranslationSupport(...args),
    buildGoogleTranslateUrl: (...args: unknown[]) => mockBuildGoogleTranslateUrl(...args),
}));

const mockGetLocalizedLanguageName = jest.fn();
jest.mock('@/lib/language-names', () => ({
    getLocalizedLanguageName: (...args: unknown[]) => mockGetLocalizedLanguageName(...args),
}));

const mockOpenInAppBrowser = jest.fn();
const mockAppendReferrer = jest.fn();
jest.mock('@/lib/web-browser-utils', () => ({
    openInAppBrowser: (...args: unknown[]) => mockOpenInAppBrowser(...args),
    appendReferrer: (...args: unknown[]) => mockAppendReferrer(...args),
}));

jest.mock('@/lib/config/branding', () => ({
    TRANSLATION_GUIDE_URL: 'https://example.com/guide.mp4',
}));

jest.mock('@/components/custom/VideoPlayerModal', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('@/components/ui/button', () => {
    const { Pressable, Text, View } = require('react-native');
    return {
        Button: (p: any) => <Pressable {...p} />,
        ButtonIcon: (p: any) => <View {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
    };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import ReadTranslateActions from '../ReadTranslateActions';

const ARTICLE_URL = 'https://publisher.example.com/story';
// What appendReferrer returns for ARTICLE_URL — the UTM-wrapped article URL
// that must be fed into buildGoogleTranslateUrl so the reader lands attributed.
const ARTICLE_URL_REF = 'https://publisher.example.com/story?utm_source=mera.news&utm_medium=referral';
const GT_URL = 'https://translate.google.com/translate?sl=auto&tl=en&u=story';

describe('ReadTranslateActions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetLocalizedLanguageName.mockReturnValue('Odia');
        mockBuildGoogleTranslateUrl.mockReturnValue(GT_URL);
        mockAppendReferrer.mockReturnValue(ARTICLE_URL_REF);
    });

    it('same-language: renders the generic read label and ALWAYS renders the Google Translate button', () => {
        mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
        const { getByText, queryByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="en"
                onOpenUrl={jest.fn()}
            />,
        );

        expect(getByText('articleDetail.readArticle')).toBeTruthy();
        expect(getByText('clusterDetail.viewInGoogleTranslate')).toBeTruthy();
        // No helper copy in this state.
        expect(queryByText(/clusterDetail\.translatable::/)).toBeNull();
        expect(queryByText(/clusterDetail\.notTranslatable::/)).toBeNull();
    });

    it('never names the publisher on the button — the card meta row owns that', () => {
        mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
        const { queryByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="en"
                onOpenUrl={jest.fn()}
            />,
        );
        expect(queryByText(/articleDetail\.readOn/)).toBeNull();
        expect(queryByText(/articleDetail\.translateAndReadOn/)).toBeNull();
    });

    it('translatable: renders the on-device translate label, the helper line + guide link, and the GT button', () => {
        mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' });
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="or"
                onOpenUrl={jest.fn()}
            />,
        );

        expect(getByText('articleDetail.viewAndTranslateOnDevice')).toBeTruthy();
        expect(
            getByText(/clusterDetail\.translatable::\{"language":"Odia"\}/),
        ).toBeTruthy();
        expect(getByText('clusterDetail.translationGuideLink')).toBeTruthy();
        expect(getByText('clusterDetail.viewInGoogleTranslate')).toBeTruthy();
    });

    it('not-translatable: names the source language on the View-original button', () => {
        mockGetArticleTranslationSupport.mockReturnValue({
            status: 'not-translatable',
            reason: 'unsupported-language',
        });
        const { getByText, queryByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="or"
                onOpenUrl={jest.fn()}
            />,
        );

        expect(
            getByText('articleDetail.viewOriginalIn::{"language":"Odia"}'),
        ).toBeTruthy();
        expect(
            getByText('clusterDetail.notTranslatable::{"language":"Odia"}'),
        ).toBeTruthy();
        expect(getByText('clusterDetail.readViaGoogleTranslate')).toBeTruthy();
        // The plain secondary GT button is replaced by the suggested one above.
        expect(queryByText('clusterDetail.viewInGoogleTranslate')).toBeNull();
        // No guide link in this state.
        expect(queryByText('clusterDetail.translationGuideLink')).toBeNull();
    });

    it('not-translatable: falls back to the unnamed label when the language is unknown', () => {
        mockGetArticleTranslationSupport.mockReturnValue({
            status: 'not-translatable',
            reason: 'unsupported-language',
        });
        mockGetLocalizedLanguageName.mockReturnValue(null);
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="zzz"
                onOpenUrl={jest.fn()}
            />,
        );
        expect(getByText('articleDetail.viewOriginal')).toBeTruthy();
    });

    it('os-outdated: tells the user which iOS version would fix it', () => {
        mockGetArticleTranslationSupport.mockReturnValue({
            status: 'not-translatable',
            reason: 'os-outdated',
            requiredOSMajor: 18,
            currentOSMajor: 17,
        });
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="hi"
                onOpenUrl={jest.fn()}
            />,
        );
        expect(
            getByText(
                'clusterDetail.notTranslatableOsOutdated::{"language":"Odia","requiredVersion":18,"currentVersion":17}',
            ),
        ).toBeTruthy();
    });

    it('calls onOpenUrl with the article URL when the primary button is pressed', () => {
        mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' });
        const onOpenUrl = jest.fn();
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="or"
                onOpenUrl={onOpenUrl}
            />,
        );
        fireEvent.press(getByText('articleDetail.viewAndTranslateOnDevice'));
        expect(onOpenUrl).toHaveBeenCalledWith(ARTICLE_URL);
    });

    it('calls onOpenUrl with the article URL when the not-translatable "View original" button is pressed', () => {
        mockGetArticleTranslationSupport.mockReturnValue({
            status: 'not-translatable',
            reason: 'unsupported-language',
        });
        const onOpenUrl = jest.fn();
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="or"
                onOpenUrl={onOpenUrl}
            />,
        );
        fireEvent.press(getByText('articleDetail.viewOriginalIn::{"language":"Odia"}'));
        expect(onOpenUrl).toHaveBeenCalledWith(ARTICLE_URL);
    });

    it('opens the built Google Translate URL when the GT button is pressed (same-language state)', () => {
        mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="en"
                onOpenUrl={jest.fn()}
            />,
        );
        fireEvent.press(getByText('clusterDetail.viewInGoogleTranslate'));
        // GT URL is built from the UTM-wrapped article URL, not the raw one.
        expect(mockAppendReferrer).toHaveBeenCalledWith(ARTICLE_URL);
        expect(mockBuildGoogleTranslateUrl).toHaveBeenCalledWith(ARTICLE_URL_REF, 'en');
        expect(mockOpenInAppBrowser).toHaveBeenCalledWith(GT_URL);
    });

    it('opens the built Google Translate URL when the suggested GT button is pressed (not-translatable state)', () => {
        mockGetArticleTranslationSupport.mockReturnValue({
            status: 'not-translatable',
            reason: 'unsupported-language',
        });
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="or"
                onOpenUrl={jest.fn()}
            />,
        );
        fireEvent.press(getByText('clusterDetail.readViaGoogleTranslate'));
        // GT URL is built from the UTM-wrapped article URL, not the raw one.
        expect(mockAppendReferrer).toHaveBeenCalledWith(ARTICLE_URL);
        expect(mockBuildGoogleTranslateUrl).toHaveBeenCalledWith(ARTICLE_URL_REF, 'en');
        expect(mockOpenInAppBrowser).toHaveBeenCalledWith(GT_URL);
    });
});
