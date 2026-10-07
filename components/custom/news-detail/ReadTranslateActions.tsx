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

/** Both read routes: a 48pt pill (FinalRead #7). */
const BUTTON_HEIGHT = 48;
const ICON_SIZE = 18;
const HELP_TARGET = 44;
const HELP_RING = 26;
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
     *  {@link getArticleTranslationSupport} to decide the button colours. */
    sourceLanguage?: string | null;
    /** Publisher name, shown on the primary button ("Read on {{publication}}").
     *  Optional: when absent/blank the button falls back to the generic
     *  "Read Article" label. */
    publicationName?: string | null;
    /** The screen's own "open article" handler (records the publication visit,
     *  opens the in-app browser, etc.) — called with `articleUrl` for the
     *  primary read button. */
    onOpenUrl: (url: string) => void;
}

/**
 * Shared read/translate block for the article detail screens
 * (`ArticleSuggestionScreen`, `ArticleDetailScreen`), FinalRead #7:
 *
 *   [ Read on <publication> ]            filled orange, always
 *   [ Read on Google Translate ] (?)     glass, only for another language
 *
 * The ? opens About translation: whether this phone can translate the article
 * while you read, what Google Translate means, and that some sites block it.
 * Render order is VoiceOver order. The publisher's primary label and icon are
 * a hidden visual under a childless labelled button (an icon glyph inside a
 * button surfaces on iOS as its own StaticText).
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
        primary: boolean,
    ) => {
        const ink = primary ? colors.onAccent : colors.ink;
        return (
            <View testID={`${testID}-frame`} style={{ flex: 1, height: BUTTON_HEIGHT }}>
                <View
                    testID={`${testID}-pill`}
                    pointerEvents="none"
                    {...HIDDEN}
                    style={{
                        flex: 1,
                        borderRadius: BUTTON_HEIGHT / 2,
                        paddingHorizontal: 20,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                        backgroundColor: primary ? colors.accent : colors.trackFill,
                        borderWidth: primary ? 0 : 1,
                        borderColor: colors.trackBorder,
                    }}
                >
                    <MaterialIcons name={icon} size={ICON_SIZE} color={ink} {...HIDDEN} />
                    <Text
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        scaleTier="chrome"
                        style={{ flexShrink: 1, color: ink, fontSize: 16, lineHeight: 22, fontWeight: primary ? '700' : '600' }}
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
    };

    return (
        <View style={{ gap: 10 }} testID="detail-read-routes">
            <View style={{ flexDirection: 'row' }}>
                {route(
                    'detail-read-publisher',
                    'open-in-new',
                    publication ? t('articleDetail.readOn', { publication }) : t('articleDetail.readArticle'),
                    () => onOpenUrl(articleUrl),
                    true,
                )}
            </View>
            {sameLanguage ? null : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {route(
                        'detail-read-google-translate',
                        'g-translate',
                        t('articleDetail.readOnGoogleTranslate'),
                        () => openInAppBrowser(googleTranslateUrl),
                        false,
                    )}
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

export default ReadTranslateActions;
