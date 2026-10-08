import AboutTranslationModal from '@/components/custom/news-detail/AboutTranslationModal';
import { Text } from '@/components/ui/text';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useColors } from '@/lib/theme/tokens';
import {
    buildGoogleTranslateUrl,
    getArticleTranslationSupport,
} from '@/lib/translation-service';
import { appendReferrer, openInAppBrowser } from '@/lib/web-browser-utils';
import { useMeraCorner } from '@/components/custom/mera-button/corner';
import { MERA_BUTTON_SIZE } from '@/lib/navigation/tab-bar';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { I18nManager, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';

/** Both read routes: equal OUTLINE pills, 48pt (owner, over FinalRead #7). */
const BUTTON_HEIGHT = 48;
const ICON_SIZE = 18;
const PAD_X = 14;
const ICON_GAP = 8;
/** A button's width beyond its label: padding both sides, the icon, its gap. */
const BUTTON_CHROME = 2 * PAD_X + ICON_SIZE + ICON_GAP;
const HELP_TARGET = 44;
const HELP_RING = 26;
/** Gap before the ? column when stacked; between all three when on one row. */
const STACK_GAP = 6;
const ROW_GAP = 8;
/** Both rows keep clear of the Mera button's column on the side its corner is
 *  on: the button sits 14pt from the screen edge and the page is padded
 *  17.5pt, so its far edge plus an 8pt gap is this far in. */
const MERA_COLUMN_CLEARANCE = 14 + MERA_BUTTON_SIZE + 8 - 17.5;
const HIDDEN = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;

/**
 * Title-case a publisher name WITHOUT destroying acronyms: only words that are
 * entirely lowercase get capitalised, so "the hindu" → "The Hindu" while
 * "BBC News" and "ABC.net.au" are left exactly as published. Words in
 * caseless scripts (Devanagari, Arabic, CJK) pass through untouched because
 * `toUpperCase()` is the identity there.
 */
export function titleCasePublication(name: string): string {
    return name
        .trim()
        .split(' ')
        .map((word) =>
            /[A-Z]/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
        )
        .join(' ');
}

interface ReadTranslateActionsProps {
    /** The publisher's article URL. */
    articleUrl: string;
    /** Article's detected source language code. Drives
     *  {@link getArticleTranslationSupport}: another language adds Google Translate. */
    sourceLanguage?: string | null;
    /** Publisher name: the original button's label, spoken as "Read on
     *  {{publication}}". When absent/blank it falls back to "Read Article". */
    publicationName?: string | null;
    /** The screen's own "open article" handler (records the publication visit,
     *  opens the in-app browser, etc.) — called with `articleUrl` for the
     *  primary read button. */
    onOpenUrl: (url: string) => void;
}

/**
 * Shared read/translate block for the article detail screens
 * (`ArticleSuggestionScreen`, `ArticleDetailScreen`). Two equal OUTLINE
 * choices (owner): the original in the accent, Google Translate in green.
 *
 *   ( ↗ <publication>        )               same width, ? column kept empty
 *   ( G文 Google Translate   ) (?)           only for another language
 *
 * When both labels fit at the current text scale they share ONE row:
 * [original] [translate] [?]. The fit is measured (`onTextLayout` on hidden
 * copies), never a per-locale table; until it is known the rows stack.
 * The ? opens About translation. Render order is VoiceOver order; the spoken
 * labels keep the full strings ("Read on <publication>", "Read on Google
 * Translate"). Each visual is hidden under a childless labelled button (an
 * icon glyph inside a button surfaces on iOS as its own StaticText).
 */
const ReadTranslateActions: React.FC<ReadTranslateActionsProps> = ({
    articleUrl,
    sourceLanguage,
    publicationName,
    onOpenUrl,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const appLanguage = useAppLanguage();
    const [aboutOpen, setAboutOpen] = useState(false);
    const [width, setWidth] = useState(0);
    const [labelW, setLabelW] = useState<{ pub?: number; gt?: number }>({});
    // Corners are PHYSICAL; RN swaps left/right padding in RTL, so a physical
    // right edge is paddingLeft there.
    const meraOnRight = useMeraCorner().endsWith('r');
    const meraSide = meraOnRight !== I18nManager.isRTL ? 'paddingRight' : 'paddingLeft';

    const support = getArticleTranslationSupport(sourceLanguage, appLanguage);
    // Wrap the article URL with Mera's UTM referrer params BEFORE handing it to
    // Google Translate, so the article the reader lands on stays attributed to
    // Mera (Google Translate carries the wrapped `u` param through).
    const googleTranslateUrl = buildGoogleTranslateUrl(appendReferrer(articleUrl), appLanguage);

    // Display only: the publication in the app language when known. The
    // visit `onOpenUrl` records is keyed by the screen's raw name, not this.
    const publicationShown = useDisplayPublication(publicationName?.trim() ?? '');
    const publication = publicationShown ? titleCasePublication(publicationShown) : null;
    const sameLanguage = support.status === 'same-language';

    const pubLabel = publication ?? t('articleDetail.readArticle');
    const pubA11y = publication ? t('articleDetail.readOn', { publication }) : t('articleDetail.readArticle');
    const gtLabel = t('articleDetail.googleTranslate');

    // One row only when BOTH labels fit their half of it.
    const half = (width - MERA_COLUMN_CLEARANCE - HELP_TARGET - 2 * ROW_GAP) / 2;
    const oneRow =
        !sameLanguage &&
        width > 0 &&
        labelW.pub !== undefined &&
        labelW.gt !== undefined &&
        Math.max(labelW.pub, labelW.gt) + BUTTON_CHROME <= half;

    const labelStyle = { fontSize: 16, lineHeight: 22, fontWeight: '600' } as const;
    const measure = (key: 'pub' | 'gt') => (e: { nativeEvent: { lines: { width: number }[] } }) => {
        const w = Math.max(0, ...e.nativeEvent.lines.map((l) => l.width));
        setLabelW((prev) => (prev[key] === w ? prev : { ...prev, [key]: w }));
    };

    const route = (
        testID: string,
        icon: keyof typeof MaterialIcons.glyphMap,
        label: string,
        a11yLabel: string,
        onPress: () => void,
        outline: string,
        ink: string,
    ) => (
        <View testID={`${testID}-frame`} style={{ flex: 1, height: BUTTON_HEIGHT }}>
            <View
                testID={`${testID}-pill`}
                pointerEvents="none"
                {...HIDDEN}
                style={{
                    flex: 1,
                    borderRadius: BUTTON_HEIGHT / 2,
                    paddingHorizontal: PAD_X,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: ICON_GAP,
                    borderWidth: 1.5,
                    borderColor: outline,
                }}
            >
                <MaterialIcons name={icon} size={ICON_SIZE} color={ink} {...HIDDEN} />
                <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    scaleTier="chrome"
                    style={[labelStyle, { flexShrink: 1, color: ink }]}
                >
                    {label}
                </Text>
            </View>
            <Pressable
                testID={testID}
                accessibilityRole="button"
                accessibilityLabel={a11yLabel}
                onPress={onPress}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );

    const original = route(
        'detail-read-publisher',
        'open-in-new',
        pubLabel,
        pubA11y,
        () => onOpenUrl(articleUrl),
        colors.accentMark,
        colors.accentText,
    );
    const translate = route(
        'detail-read-google-translate',
        'g-translate',
        gtLabel,
        t('articleDetail.readOnGoogleTranslate'),
        () => openInAppBrowser(googleTranslateUrl),
        colors.positive,
        colors.positive,
    );
    const help = (
        <View style={{ width: HELP_TARGET, height: HELP_TARGET }}>
            <View
                pointerEvents="none"
                {...HIDDEN}
                style={{
                    margin: (HELP_TARGET - HELP_RING) / 2,
                    width: HELP_RING,
                    height: HELP_RING,
                    borderRadius: HELP_RING / 2,
                    borderWidth: 1.5,
                    borderColor: colors.helpRing,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <Text style={{ color: colors.muted, fontSize: 14, fontWeight: '700' }}>?</Text>
            </View>
            <Pressable
                testID="detail-about-translation"
                accessibilityRole="button"
                accessibilityLabel={t('articleDetail.aboutTranslation')}
                onPress={() => setAboutOpen(true)}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );
    const row = { flexDirection: 'row', alignItems: 'center', [meraSide]: MERA_COLUMN_CLEARANCE } as const;

    return (
        <View
            style={{ gap: 10 }}
            testID="detail-read-routes"
            onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        >
            {sameLanguage ? (
                <View style={row}>{original}</View>
            ) : oneRow ? (
                <View style={[row, { gap: ROW_GAP }]}>
                    {original}
                    {translate}
                    {help}
                </View>
            ) : (
                <>
                    <View style={[row, { gap: STACK_GAP }]}>
                        {original}
                        <View style={{ width: HELP_TARGET }} />
                    </View>
                    <View style={[row, { gap: STACK_GAP }]}>
                        {translate}
                        {help}
                    </View>
                </>
            )}
            {/* The fit check: both labels at the current text scale, unclamped,
                off screen and invisible to assistive tech. */}
            {sameLanguage ? null : (
                <View pointerEvents="none" {...HIDDEN} style={styles.measure}>
                    <Text scaleTier="chrome" style={labelStyle} onTextLayout={measure('pub')}>
                        {pubLabel}
                    </Text>
                    <Text scaleTier="chrome" style={labelStyle} onTextLayout={measure('gt')}>
                        {gtLabel}
                    </Text>
                </View>
            )}
            <AboutTranslationModal
                open={aboutOpen}
                onClose={() => setAboutOpen(false)}
                support={support}
                sourceLanguage={sourceLanguage}
                appLanguage={appLanguage}
                publication={publication}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    measure: { position: 'absolute', top: 0, left: 0, width: 4000, opacity: 0, alignItems: 'flex-start' },
});

export default ReadTranslateActions;
