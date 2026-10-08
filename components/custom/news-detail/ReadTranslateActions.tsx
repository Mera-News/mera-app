import AboutTranslationModal from '@/components/custom/news-detail/AboutTranslationModal';
import { Text } from '@/components/ui/text';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useColors } from '@/lib/theme/tokens';
import {
    buildGoogleTranslateUrl,
    getArticleTranslationSupport,
} from '@/lib/translation-service';
import { appendReferrer, openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';

/** Both read routes span the text column, stacked (the owner's preferred
 *  old build): a 40pt outline pill inside a 44pt touch frame pulled back by
 *  negative margins, so the layout sees 40 (never hitSlop). */
const PILL_HEIGHT = 40;
const TOUCH_TARGET = 44;
const FRAME_BLEED = (TOUCH_TARGET - PILL_HEIGHT) / 2;
const ICON_SIZE = 18;
/** The About translation line: 20pt of layout inside a 44pt touch frame. */
const ABOUT_LINE = 20;
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
 * (`ArticleSuggestionScreen`, `ArticleDetailScreen`), the owner's preferred
 * old build over FinalRead's filled + glass row:
 *
 *   ( ↗ Read on <publication>      )     neutral outline, full text column
 *   ( G文 Read on Google Translate  )     green outline, another language only
 *          (?) About translation           muted text button, opens the sheet
 *
 * Render order is VoiceOver order. Each visual is hidden under a childless
 * labelled button (an icon glyph inside a button surfaces on iOS as its own
 * StaticText).
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

    const route = (
        testID: string,
        icon: keyof typeof MaterialIcons.glyphMap,
        label: string,
        onPress: () => void,
        ink: string,
    ) => (
        <View testID={`${testID}-frame`} style={{ height: TOUCH_TARGET, marginVertical: -FRAME_BLEED, justifyContent: 'center' }}>
            <View
                testID={`${testID}-pill`}
                pointerEvents="none"
                {...HIDDEN}
                style={{
                    height: PILL_HEIGHT,
                    borderRadius: PILL_HEIGHT / 2,
                    borderWidth: 1,
                    borderColor: ink,
                    paddingHorizontal: 14,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 7,
                }}
            >
                <MaterialIcons name={icon} size={ICON_SIZE} color={ink} {...HIDDEN} />
                <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    scaleTier="chrome"
                    style={{ flexShrink: 1, color: ink, fontSize: 15, lineHeight: 20, fontWeight: '600' }}
                >
                    {label}
                </Text>
            </View>
            <Pressable
                testID={testID}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={onPress}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );

    return (
        // 13pt here + the screen VStack's ~11pt gap: about 24pt under the
        // action row, as in the old build.
        <View style={{ gap: 10, marginTop: 13 }} testID="detail-read-routes">
            {route(
                'detail-read-publisher',
                'open-in-new',
                publication ? t('articleDetail.readOn', { publication }) : t('articleDetail.readArticle'),
                () => onOpenUrl(articleUrl),
                colors.ink,
            )}
            {sameLanguage ? null : (
                <>
                    {route(
                        'detail-read-google-translate',
                        'g-translate',
                        t('articleDetail.readOnGoogleTranslate'),
                        () => openInAppBrowser(googleTranslateUrl),
                        colors.positive,
                    )}
                    <View
                        style={{
                            height: TOUCH_TARGET,
                            // The text sits 12pt under the last pill (the
                            // block's 10pt gap, then this frame's own bleed).
                            marginTop: 12 - 10 - (TOUCH_TARGET - ABOUT_LINE) / 2,
                            marginBottom: -(TOUCH_TARGET - ABOUT_LINE) / 2,
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <View
                            pointerEvents="none"
                            {...HIDDEN}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                        >
                            <MaterialIcons name="help-outline" size={16} color={colors.muted} {...HIDDEN} />
                            <Text scaleTier="chrome" style={{ color: colors.muted, fontSize: 14, lineHeight: ABOUT_LINE }}>
                                {t('articleDetail.aboutTranslation')}
                            </Text>
                        </View>
                        <Pressable
                            testID="detail-about-translation"
                            accessibilityRole="button"
                            accessibilityLabel={t('articleDetail.aboutTranslation')}
                            onPress={() => setAboutOpen(true)}
                            style={StyleSheet.absoluteFill}
                        />
                    </View>
                </>
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

export default ReadTranslateActions;
