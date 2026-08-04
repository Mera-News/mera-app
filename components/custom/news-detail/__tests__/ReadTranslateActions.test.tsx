// ReadTranslateActions — shared read/translate CTA block used by both detail
// screens. ONE layout in every state: the translation notice, then a HALF-width
// centred Google Translate button, then the full-width "Read on {publication}"
// button. Only the colours change with getArticleTranslationSupport, and those
// three states x two buttons are the regression net below — green (#22C55E)
// always marks the route that gets the reader something readable.
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
import ReadTranslateActions, { titleCasePublication } from '../ReadTranslateActions';

const ARTICLE_URL = 'https://publisher.example.com/story';
// What appendReferrer returns for ARTICLE_URL — the UTM-wrapped article URL
// that must be fed into buildGoogleTranslateUrl so the reader lands attributed.
const ARTICLE_URL_REF = 'https://publisher.example.com/story?utm_source=mera.news&utm_medium=referral';
const GT_URL = 'https://translate.google.com/translate?sl=auto&tl=en&u=story';

const GREEN = '#22C55E';
const WHITE = '#FFFFFF';

const GT_BUTTON = 'detail-read-google-translate';
const PUBLISHER_BUTTON = 'detail-read-publisher';

const renderActions = (props: Partial<React.ComponentProps<typeof ReadTranslateActions>> = {}) =>
    render(
        <ReadTranslateActions
            articleUrl={ARTICLE_URL}
            sourceLanguage="or"
            publicationName="the hindu"
            onOpenUrl={jest.fn()}
            {...props}
        />,
    );

/** RN flattens the style prop into an array in some paths — normalise. */
const styleOf = (node: any): Record<string, unknown> => {
    const style = node.props.style;
    return Array.isArray(style) ? Object.assign({}, ...style) : style;
};

describe('ReadTranslateActions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetLocalizedLanguageName.mockReturnValue('Odia');
        mockBuildGoogleTranslateUrl.mockReturnValue(GT_URL);
        mockAppendReferrer.mockReturnValue(ARTICLE_URL_REF);
    });

    describe('labels', () => {
        it('names the publisher in Title Case on the primary button', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const { getByText } = renderActions({ sourceLanguage: 'en' });
            expect(getByText('articleDetail.readOn::{"publication":"The Hindu"}')).toBeTruthy();
        });

        it('falls back to the generic label when no publication name is supplied', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const { getByText } = renderActions({ sourceLanguage: 'en', publicationName: null });
            expect(getByText('articleDetail.readArticle')).toBeTruthy();
        });

        it('falls back to the generic label when the publication name is blank', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const { getByText } = renderActions({ sourceLanguage: 'en', publicationName: '   ' });
            expect(getByText('articleDetail.readArticle')).toBeTruthy();
        });

        it('truncates rather than pre-trimming a long publisher name', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const { getByText } = renderActions({
                sourceLanguage: 'en',
                publicationName: 'The Extremely Long Regional Daily Herald And Evening Post',
            });
            const label = getByText(
                'articleDetail.readOn::{"publication":"The Extremely Long Regional Daily Herald And Evening Post"}',
            );
            expect(label.props.numberOfLines).toBe(1);
            expect(label.props.ellipsizeMode).toBe('tail');
        });

        it('labels the Google button in every state', () => {
            for (const status of ['same-language', 'translatable', 'not-translatable'] as const) {
                mockGetArticleTranslationSupport.mockReturnValue({
                    status,
                    reason: 'unsupported-language',
                });
                const { getByText, unmount } = renderActions();
                expect(getByText('articleDetail.readOnGoogleTranslate')).toBeTruthy();
                unmount();
            }
        });
    });

    describe('title casing', () => {
        it('capitalises all-lowercase words but leaves acronyms alone', () => {
            expect(titleCasePublication('the hindu')).toBe('The Hindu');
            expect(titleCasePublication('BBC News')).toBe('BBC News');
            expect(titleCasePublication('ABC.net.au')).toBe('ABC.net.au');
            expect(titleCasePublication('  times of india  ')).toBe('Times Of India');
        });
    });

    describe('layout', () => {
        it('renders the Google button at half width, centred, above the publisher button', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const { getByTestId, UNSAFE_root } = renderActions({ sourceLanguage: 'en' });

            const gt = getByTestId(GT_BUTTON);
            expect(styleOf(gt).width).toBe('50%');
            expect(styleOf(gt).alignSelf).toBe('center');

            // Order: the Google button must precede the publisher button.
            const ids = UNSAFE_root
                .findAll((n: any) => typeof n.props?.testID === 'string')
                .map((n: any) => n.props.testID);
            expect(ids.indexOf(GT_BUTTON)).toBeLessThan(ids.indexOf(PUBLISHER_BUTTON));
        });

        it('shows the translation notice + guide link only when the device can translate', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' });
            const translatable = renderActions();
            expect(
                translatable.getByText(/clusterDetail\.translatable::\{"language":"Odia"\}/),
            ).toBeTruthy();
            expect(translatable.getByText('clusterDetail.translationGuideLink')).toBeTruthy();
            translatable.unmount();

            mockGetArticleTranslationSupport.mockReturnValue({
                status: 'not-translatable',
                reason: 'unsupported-language',
            });
            const blocked = renderActions();
            expect(
                blocked.getByText('clusterDetail.notTranslatable::{"language":"Odia"}'),
            ).toBeTruthy();
            expect(blocked.queryByText('clusterDetail.translationGuideLink')).toBeNull();
            blocked.unmount();

            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const same = renderActions({ sourceLanguage: 'en' });
            expect(same.queryByText(/clusterDetail\.translatable::/)).toBeNull();
            expect(same.queryByText(/clusterDetail\.notTranslatable::/)).toBeNull();
        });

        it('os-outdated: tells the user which iOS version would fix it', () => {
            mockGetArticleTranslationSupport.mockReturnValue({
                status: 'not-translatable',
                reason: 'os-outdated',
                requiredOSMajor: 18,
                currentOSMajor: 17,
            });
            const { getByText } = renderActions({ sourceLanguage: 'hi' });
            expect(
                getByText(
                    'clusterDetail.notTranslatableOsOutdated::{"language":"Odia","requiredVersion":18,"currentVersion":17}',
                ),
            ).toBeTruthy();
        });
    });

    // The colour matrix — green marks the route that will actually get the
    // reader something they can read. All six cells are pinned.
    describe('colour matrix', () => {
        it('same-language: white Google button, GREEN-FILLED publisher button', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const { getByTestId } = renderActions({ sourceLanguage: 'en' });

            const gt = styleOf(getByTestId(GT_BUTTON));
            expect(gt.backgroundColor).toBe('transparent');
            expect(gt.borderColor).toBe(WHITE);

            const publisher = styleOf(getByTestId(PUBLISHER_BUTTON));
            expect(publisher.backgroundColor).toBe(GREEN);
            expect(publisher.borderColor).toBe(GREEN);
        });

        it('translatable: GREEN-FILLED Google button, green-OUTLINE publisher button', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' });
            const { getByTestId } = renderActions();

            const gt = styleOf(getByTestId(GT_BUTTON));
            expect(gt.backgroundColor).toBe(GREEN);
            expect(gt.borderColor).toBe(GREEN);

            const publisher = styleOf(getByTestId(PUBLISHER_BUTTON));
            expect(publisher.backgroundColor).toBe('transparent');
            expect(publisher.borderColor).toBe(GREEN);
        });

        it('not-translatable: GREEN-FILLED Google button, plain WHITE publisher button', () => {
            mockGetArticleTranslationSupport.mockReturnValue({
                status: 'not-translatable',
                reason: 'unsupported-language',
            });
            const { getByTestId } = renderActions();

            const gt = styleOf(getByTestId(GT_BUTTON));
            expect(gt.backgroundColor).toBe(GREEN);
            expect(gt.borderColor).toBe(GREEN);

            const publisher = styleOf(getByTestId(PUBLISHER_BUTTON));
            expect(publisher.backgroundColor).toBe('transparent');
            expect(publisher.borderColor).toBe(WHITE);
        });

        it('a filled button flips its label to near-black — white on #22C55E is unreadable', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const { getByText } = renderActions({ sourceLanguage: 'en' });
            const publisherLabel = getByText('articleDetail.readOn::{"publication":"The Hindu"}');
            expect(styleOf(publisherLabel).color).toBe('#052E16');

            const gtLabel = getByText('articleDetail.readOnGoogleTranslate');
            expect(styleOf(gtLabel).color).toBe(WHITE);
        });
    });

    describe('actions', () => {
        it('calls onOpenUrl with the article URL when the publisher button is pressed', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' });
            const onOpenUrl = jest.fn();
            const { getByTestId } = renderActions({ onOpenUrl });
            fireEvent.press(getByTestId(PUBLISHER_BUTTON));
            expect(onOpenUrl).toHaveBeenCalledWith(ARTICLE_URL);
        });

        it('opens the built Google Translate URL when the Google button is pressed', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const { getByTestId } = renderActions({ sourceLanguage: 'en' });
            fireEvent.press(getByTestId(GT_BUTTON));
            // GT URL is built from the UTM-wrapped article URL, not the raw one.
            expect(mockAppendReferrer).toHaveBeenCalledWith(ARTICLE_URL);
            expect(mockBuildGoogleTranslateUrl).toHaveBeenCalledWith(ARTICLE_URL_REF, 'en');
            expect(mockOpenInAppBrowser).toHaveBeenCalledWith(GT_URL);
        });

        it('keeps the Google Translate button reachable even in the not-translatable state', () => {
            mockGetArticleTranslationSupport.mockReturnValue({
                status: 'not-translatable',
                reason: 'unsupported-language',
            });
            const { getByTestId } = renderActions();
            fireEvent.press(getByTestId(GT_BUTTON));
            expect(mockOpenInAppBrowser).toHaveBeenCalledWith(GT_URL);
        });
    });
});
