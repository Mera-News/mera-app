// ReadTranslateActions — shared read/translate CTA block used by both detail
// screens (r6 P5). Verifies the three getArticleTranslatableStatus layouts:
// same-language (Read-on + GT, GT ALWAYS present — prod has mislabeled-
// language articles so GT must stay reachable even here), translatable
// (Translate & Read + helper + GT), and not-translatable (red View-original +
// neutral helper + solid suggested GT button).
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

const mockGetArticleTranslatableStatus = jest.fn();
const mockGetLanguageName = jest.fn();
const mockBuildGoogleTranslateUrl = jest.fn();
jest.mock('@/lib/translation-service', () => ({
    getArticleTranslatableStatus: (...args: unknown[]) => mockGetArticleTranslatableStatus(...args),
    getLanguageName: (...args: unknown[]) => mockGetLanguageName(...args),
    buildGoogleTranslateUrl: (...args: unknown[]) => mockBuildGoogleTranslateUrl(...args),
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
        mockGetLanguageName.mockReturnValue('Odia');
        mockBuildGoogleTranslateUrl.mockReturnValue(GT_URL);
        mockAppendReferrer.mockReturnValue(ARTICLE_URL_REF);
    });

    it('same-language: renders "Read on <publication>" and ALWAYS renders the Google Translate button', () => {
        mockGetArticleTranslatableStatus.mockReturnValue('same-language');
        const onOpenUrl = jest.fn();
        const { getByText, queryByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                publicationName="The Daily"
                sourceLanguage="en"
                onOpenUrl={onOpenUrl}
            />,
        );

        expect(
            getByText('articleDetail.readOn::{"publication":"The Daily"}'),
        ).toBeTruthy();
        expect(getByText('clusterDetail.viewInGoogleTranslate')).toBeTruthy();
        // No helper copy in this state.
        expect(queryByText(/clusterDetail\.translatable::/)).toBeNull();
        expect(queryByText(/clusterDetail\.notTranslatable::/)).toBeNull();
    });

    it('same-language: falls back to the generic label when no publication is known', () => {
        mockGetArticleTranslatableStatus.mockReturnValue('same-language');
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="en"
                onOpenUrl={jest.fn()}
            />,
        );
        expect(getByText('articleDetail.readArticle')).toBeTruthy();
    });

    it('translatable: renders "Translate & Read on <publication>", the helper line + guide link, and the GT button', () => {
        mockGetArticleTranslatableStatus.mockReturnValue('translatable');
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                publicationName="The Daily"
                sourceLanguage="or"
                onOpenUrl={jest.fn()}
            />,
        );

        expect(
            getByText('articleDetail.translateAndReadOn::{"publication":"The Daily"}'),
        ).toBeTruthy();
        expect(
            getByText(/clusterDetail\.translatable::\{"language":"Odia"\}/),
        ).toBeTruthy();
        expect(getByText('clusterDetail.translationGuideLink')).toBeTruthy();
        expect(getByText('clusterDetail.viewInGoogleTranslate')).toBeTruthy();
    });

    it('not-translatable: renders "View original", the neutral helper, and the solid suggested-GT button (no secondary GT button)', () => {
        mockGetArticleTranslatableStatus.mockReturnValue('not-translatable');
        const { getByText, queryByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                publicationName="The Daily"
                sourceLanguage="or"
                onOpenUrl={jest.fn()}
            />,
        );

        expect(getByText('articleDetail.viewOriginal')).toBeTruthy();
        expect(
            getByText('clusterDetail.notTranslatable::{"language":"Odia"}'),
        ).toBeTruthy();
        expect(getByText('clusterDetail.readViaGoogleTranslate')).toBeTruthy();
        // The plain secondary GT button is replaced by the suggested one above.
        expect(queryByText('clusterDetail.viewInGoogleTranslate')).toBeNull();
        // No guide link in this state.
        expect(queryByText('clusterDetail.translationGuideLink')).toBeNull();
    });

    it('calls onOpenUrl with the article URL when the primary button is pressed', () => {
        mockGetArticleTranslatableStatus.mockReturnValue('translatable');
        const onOpenUrl = jest.fn();
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                publicationName="The Daily"
                sourceLanguage="or"
                onOpenUrl={onOpenUrl}
            />,
        );
        fireEvent.press(
            getByText('articleDetail.translateAndReadOn::{"publication":"The Daily"}'),
        );
        expect(onOpenUrl).toHaveBeenCalledWith(ARTICLE_URL);
    });

    it('calls onOpenUrl with the article URL when the not-translatable "View original" button is pressed', () => {
        mockGetArticleTranslatableStatus.mockReturnValue('not-translatable');
        const onOpenUrl = jest.fn();
        const { getByText } = render(
            <ReadTranslateActions
                articleUrl={ARTICLE_URL}
                sourceLanguage="or"
                onOpenUrl={onOpenUrl}
            />,
        );
        fireEvent.press(getByText('articleDetail.viewOriginal'));
        expect(onOpenUrl).toHaveBeenCalledWith(ARTICLE_URL);
    });

    it('opens the built Google Translate URL when the GT button is pressed (same-language state)', () => {
        mockGetArticleTranslatableStatus.mockReturnValue('same-language');
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
        mockGetArticleTranslatableStatus.mockReturnValue('not-translatable');
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
