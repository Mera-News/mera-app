// ReadTranslateActions — shared read/translate CTA block used by both detail
// screens: the translation notice, then "Read on Google Translate" above
// "Read on {publication}" in one wrapping row, then the blocked-site note.
// Only the colours change with getArticleTranslationSupport, and those three
// states x two buttons are the regression net below — green always marks the
// route that gets the reader something readable.
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
// Icons render their real icon-font glyph (a private-use character), as on
// device, so a label that would leak it is caught (see icon-glyph-a11y).
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import { exposedGlyphTexts, privateUseLabelLeaks } from '@/lib/__test-helpers__/icon-glyph-a11y';
import { configure, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import ReadTranslateActions, { titleCasePublication } from '../ReadTranslateActions';

// The pill (label + icon) is a hidden visual under a childless labelled
// button, so text and pill queries must see hidden elements.
configure({ defaultIncludeHiddenElements: true });

const ARTICLE_URL = 'https://publisher.example.com/story';
// What appendReferrer returns for ARTICLE_URL — the UTM-wrapped article URL
// that must be fed into buildGoogleTranslateUrl so the reader lands attributed.
const ARTICLE_URL_REF = 'https://publisher.example.com/story?utm_source=mera.news&utm_medium=referral';
const GT_URL = 'https://translate.google.com/translate?sl=auto&tl=en&u=story';

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

        it('names the publisher by its display name in the app language (ux2 A7)', () => {
            const { usePublicationDisplayStore } = require('@/lib/stores/publication-display-store');
            usePublicationDisplayStore.setState({ language: 'en', names: { '人民日报': 'Renmin Ribao' } });
            try {
                mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
                const { getByText } = renderActions({ sourceLanguage: 'en', publicationName: '人民日报' });
                expect(getByText('articleDetail.readOn::{"publication":"Renmin Ribao"}')).toBeTruthy();
            } finally {
                usePublicationDisplayStore.setState({ language: null, names: {} });
            }
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

        it('labels the Google button in every state that shows it', () => {
            for (const status of ['translatable', 'not-translatable'] as const) {
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
        it('offers only Read on source for an article in the reader\'s language', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const { getByTestId, queryByTestId } = renderActions({ sourceLanguage: 'en' });
            expect(getByTestId(PUBLISHER_BUTTON)).toBeTruthy();
            expect(queryByTestId(GT_BUTTON)).toBeNull();
            expect(queryByTestId('detail-translate-blocked-note')).toBeNull();
        });

        it.each(['translatable', 'not-translatable'] as const)(
            '%s: both routes in one wrapping row, Google Translate first, then the note',
            (status) => {
                mockGetArticleTranslationSupport.mockReturnValue({ status, reason: 'unsupported-language' });
                const { getByTestId, UNSAFE_root } = renderActions();
                const row = getByTestId('detail-read-routes');
                // Side by side when both labels fit, stacked when not: the row
                // wraps and each button grows to fill its line.
                expect(styleOf(row)).toEqual(expect.objectContaining({ flexDirection: 'row', flexWrap: 'wrap' }));
                const ids = UNSAFE_root
                    .findAll((n: any) => typeof n.props?.testID === 'string')
                    .map((n: any) => n.props.testID);
                // Owner: Google Translate above the original. Render order is
                // also VoiceOver order, so the two agree.
                expect(ids.indexOf(GT_BUTTON)).toBeLessThan(ids.indexOf(PUBLISHER_BUTTON));
                expect(ids.indexOf('detail-translate-blocked-note')).toBeGreaterThan(ids.indexOf(PUBLISHER_BUTTON));
                expect(getByTestId('detail-translate-blocked-note').props.children).toBe(
                    'articleDetail.translateBlockedNote',
                );
            },
        );

        it('puts the translation notice above the two routes', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' });
            const { UNSAFE_root } = renderActions();
            const order = UNSAFE_root.findAll(
                (n: any) => typeof n.props?.testID === 'string' || n.type === 'Text',
            ).map((n: any) => n.props?.testID ?? String(n.props?.children ?? ''));
            const noticeAt = order.findIndex((v: string) => v.includes('clusterDetail.translatable'));
            expect(noticeAt).toBeGreaterThan(-1);
            expect(noticeAt).toBeLessThan(order.indexOf(GT_BUTTON));
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

    // Owner: green OUTLINE marks the route that gets the reader something
    // readable; the old fill stays gone. All three states pinned.
    describe('green outline signal', () => {
        const GREEN = '#86EFAC';
        // The outline is drawn by the visible pill inside the 44pt frame.
        const outline = (b: any) => {
            let root = b;
            while (root.parent) root = root.parent;
            const pill = root.findAll((n: any) => n.props?.testID === `${b.props.testID}-pill`)[0];
            return { border: styleOf(pill).borderColor, fill: styleOf(pill).backgroundColor };
        };

        it('same language: only Read on source, GREEN outline', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'same-language' });
            const { getByTestId, queryByTestId } = renderActions({ sourceLanguage: 'en' });
            expect(outline(getByTestId(PUBLISHER_BUTTON))).toEqual({ border: GREEN, fill: 'transparent' });
            expect(queryByTestId(GT_BUTTON)).toBeNull();
        });

        it('device CAN translate: both GREEN outlines', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' });
            const { getByTestId } = renderActions();
            expect(outline(getByTestId(PUBLISHER_BUTTON))).toEqual({ border: GREEN, fill: 'transparent' });
            expect(outline(getByTestId(GT_BUTTON))).toEqual({ border: GREEN, fill: 'transparent' });
        });

        it('device can NOT translate: source WHITE, Google Translate GREEN', () => {
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'not-translatable', reason: 'unsupported-language' });
            const { getByTestId, getByText } = renderActions();
            expect(outline(getByTestId(PUBLISHER_BUTTON))).toEqual({ border: WHITE, fill: 'transparent' });
            expect(outline(getByTestId(GT_BUTTON))).toEqual({ border: GREEN, fill: 'transparent' });
            // The label follows its outline.
            expect(styleOf(getByText('articleDetail.readOnGoogleTranslate')).color).toBe(GREEN);
        });

        it('keeps both buttons the same shape: no fill in any state', () => {
            for (const status of ['same-language', 'translatable', 'not-translatable'] as const) {
                mockGetArticleTranslationSupport.mockReturnValue({ status, reason: 'unsupported-language' });
                const { queryByTestId, unmount } = renderActions(status === 'same-language' ? { sourceLanguage: 'en' } : {});
                for (const id of [PUBLISHER_BUTTON, GT_BUTTON]) {
                    const b = queryByTestId(`${id}-frame`);
                    if (b) expect(styleOf(b).flexGrow).toBe(1);
                }
                unmount();
            }
        });
    });

    // Owner: "let's reduce these button sizes by 20%". Height, side padding,
    // label and icon at about 0.8x; the gap between them too. Width stays full.
    // The visible pill is below 44pt, so the pressable is a transparent 44pt
    // frame pulled back to the pill's height by negative margins (not hitSlop).
    describe('size (20% smaller)', () => {
        beforeEach(() => mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' }));

        it.each([GT_BUTTON, PUBLISHER_BUTTON])('%s: a 28pt pill with 14pt side padding', (id) => {
            const { getByTestId } = renderActions();
            expect(styleOf(getByTestId(`${id}-pill`))).toEqual(
                expect.objectContaining({ height: 28, paddingHorizontal: 14, borderWidth: 1 }),
            );
        });

        it.each([GT_BUTTON, PUBLISHER_BUTTON])('%s: keeps a 44pt touch target that lays out at the pill height', (id) => {
            const { getByTestId } = renderActions();
            const frame = styleOf(getByTestId(`${id}-frame`));
            expect(frame).toEqual(expect.objectContaining({ height: 44, marginVertical: -8, flexGrow: 1 }));
            expect((frame.height as number) + 2 * (frame.marginVertical as number)).toBe(28);
            expect(getByTestId(id).props.hitSlop).toBeUndefined();
        });

        it('a 13/20 label and a 14pt icon', () => {
            const { getByText, getByTestId } = renderActions();
            expect(styleOf(getByText('articleDetail.readOnGoogleTranslate'))).toEqual(
                expect.objectContaining({ fontSize: 13, lineHeight: 20 }),
            );
            const icons = getByTestId(`${GT_BUTTON}-pill`).findAll((n: any) => n.props?.name === 'g-translate');
            expect(icons[0].props.size).toBe(14);
        });

        it('a 10pt gap between the routes', () => {
            const { getByTestId } = renderActions();
            expect(styleOf(getByTestId('detail-read-routes')).gap).toBe(10);
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
            mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' });
            const { getByTestId } = renderActions();
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

// VoiceOver read the icon's font glyph: "<glyph>, Read on Google Translate".
// Each button carries its visible text as an explicit label.
describe('accessibility labels', () => {
    it.each(['translatable', 'not-translatable', 'same-language'] as const)('%s: no label carries an icon glyph', (status) => {
        mockGetArticleTranslationSupport.mockReturnValue({ status, reason: 'unsupported-language' });
        const r = renderActions(status === 'same-language' ? { sourceLanguage: 'en' } : {});
        expect(privateUseLabelLeaks(r.UNSAFE_root)).toEqual([]);
    });

    it('each button is labelled with exactly its visible text', () => {
        mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' });
        const r = renderActions();
        expect(r.getByTestId(GT_BUTTON).props.accessibilityLabel).toBe('articleDetail.readOnGoogleTranslate');
        expect(r.getByTestId(PUBLISHER_BUTTON).props.accessibilityLabel).toBe(
            'articleDetail.readOn::{"publication":"The Hindu"}',
        );
    });
});

// Captured (ux2 batch 27): an open-in-new glyph StaticText right after "Read on
// Ars Technica". Each button is childless, laid over its hidden pill.
describe('icon glyphs', () => {
    it.each(['translatable', 'not-translatable', 'same-language'] as const)('%s: no private-use StaticText anywhere', (status) => {
        mockGetArticleTranslationSupport.mockReturnValue({ status, reason: 'unsupported-language' });
        const r = renderActions(status === 'same-language' ? { sourceLanguage: 'en' } : {});
        // Presence first: the route glyphs, plus TranslationNotice's translate
        // glyph whenever the notice shows.
        const glyphs = r.UNSAFE_root.findAll((n: any) => n.type === 'Text' && /[\uE000-\uF8FF]/.test(String(n.props.children)));
        expect(glyphs.length).toBe(status === 'same-language' ? 1 : 3);
        expect(exposedGlyphTexts(r.UNSAFE_root)).toEqual([]);
    });

    it('each button is childless, so it cannot compose a glyph', () => {
        mockGetArticleTranslationSupport.mockReturnValue({ status: 'translatable' });
        const r = renderActions();
        for (const id of [GT_BUTTON, PUBLISHER_BUTTON]) {
            const b = r.getByTestId(id);
            expect(b.findAll((n: any) => n !== b && typeof n.type === 'string' && n.type !== 'View')).toHaveLength(0);
        }
    });
});
