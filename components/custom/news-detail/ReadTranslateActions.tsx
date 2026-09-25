import TranslationNotice, { TRANSLATABLE_COLOR } from '@/components/custom/news-detail/TranslationNotice';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import {
    buildGoogleTranslateUrl,
    getArticleTranslationSupport,
} from '@/lib/translation-service';
import { appendReferrer, openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';

/** A route that will NOT get the reader something they can read as-is. */
const ROUTE_COLOR = '#FFFFFF';
/** A route that WILL: the same green as the translation notice's
 *  "can translate" hint (green-300), about 12:1 against the dark page. Used
 *  as an OUTLINE and label only, never a fill (owner: equal-looking buttons,
 *  the colour is the only signal). */
const READABLE_COLOR = TRANSLATABLE_COLOR;
// Owner: "reduce these button sizes by 20%". Each value is the old one x0.8
// (old: the gluestack `md` Button, h-10 / px-5 = 35 / 17.5pt at NativeWind's
// rem 14, a text-base 16/24 label, an 18pt icon, `ml-2` = 7pt, a 12pt gap).
/** Space between the two buttons, across and down. */
const ROUTE_GAP = 10;
/** The visible pill. */
const PILL_HEIGHT = 28;
const PILL_PADDING_X = 14;
const LABEL_FONT = 13;
const LABEL_LINE = 20;
const ICON_SIZE = 14;
const ICON_GAP = 6;
/** The touch target stays 44pt: a transparent frame, pulled back to the
 *  pill's height by negative margins so the layout sees 28pt (never hitSlop). */
const TOUCH_TARGET = 44;
const FRAME_BLEED = (TOUCH_TARGET - PILL_HEIGHT) / 2;

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
 * Shared read/translate call-to-action block for the article detail screens
 * (`ArticleSuggestionScreen`, `ArticleDetailScreen`).
 *
 * N8: both read routes are the same size and shape, OUTLINES only; the only
 * signal is colour. GREEN = this route gets the reader something readable:
 *
 * | article language          | Read on {publication} | Read on Google Translate |
 * |---------------------------|-----------------------|--------------------------|
 * | same as the reader's      | green outline         | not shown                |
 * | other, device CAN translate | green outline       | green outline            |
 * | other, device CANNOT      | white outline         | green outline            |
 *
 * `TranslationNotice` (names the source language) sits above the buttons and a
 * one-line "some sites block Google Translate" note below them.
 *
 * Side by side when both labels fit, stacked when they do not: the row WRAPS,
 * each button sized by its own label and growing to fill its line, so the
 * choice is made by the real text width in each language and text size, not
 * by a character count. At 375pt the English pair already stacks; wider
 * screens and short publisher names get the row.
 *
 * Colours are stated as a class AND as the matching inline style: gluestack's
 * `buttonTextStyle` tva sets a label colour of its own per variant, and which
 * of className/style wins differs between the Pressable root and the Text.
 */
const ReadTranslateActions: React.FC<ReadTranslateActionsProps> = ({
    articleUrl,
    sourceLanguage,
    publicationName,
    onOpenUrl,
}) => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();

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

    // Green marks a route that gets the reader something readable: the
    // publisher page when the article is in their language or the device can
    // translate it, and Google Translate always. White is the publisher page
    // the device cannot translate. Outline + label only, same size either way.
    const publisherReadable = sameLanguage || support.status === 'translatable';
    const routeButton = (
        testID: string,
        icon: keyof typeof MaterialIcons.glyphMap,
        label: string,
        onPress: () => void,
        readable: boolean,
    ) => {
        const color = readable ? READABLE_COLOR : ROUTE_COLOR;
        return (
            // The pressable is the transparent 44pt FRAME; the outline is the
            // pill inside it (see TOUCH_TARGET).
            <Button
                testID={testID}
                // Exactly the visible text. Without it VoiceOver read the icon's
                // font glyph first ("<glyph>, Read on Google Translate").
                accessibilityRole="button"
                accessibilityLabel={label}
                // `outline` as before, not `link` (whose label underlines while
                // pressed); its border is zeroed here, the pill draws it.
                variant="outline"
                action="secondary"
                className="bg-transparent border-0"
                style={{
                    flexGrow: 1,
                    flexShrink: 1,
                    height: TOUCH_TARGET,
                    marginVertical: -FRAME_BLEED,
                    paddingHorizontal: 0,
                    borderWidth: 0,
                    backgroundColor: 'transparent',
                    justifyContent: 'center',
                }}
                onPress={onPress}
            >
                <View
                    testID={`${testID}-pill`}
                    // Class AND style, see the header: gluestack's tva sets its
                    // own colours, and which one wins differs between root and label.
                    className={`rounded-full ${readable ? 'border-green-300' : 'border-white'}`}
                    style={{
                        flexGrow: 1,
                        flexShrink: 1,
                        height: PILL_HEIGHT,
                        paddingHorizontal: PILL_PADDING_X,
                        borderWidth: 1,
                        borderColor: color,
                        borderRadius: PILL_HEIGHT / 2,
                        backgroundColor: 'transparent',
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <MaterialIcons name={icon} size={ICON_SIZE} color={color} />
                    <ButtonText
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        className={readable ? 'text-green-300' : 'text-white'}
                        style={{ flexShrink: 1, color, fontSize: LABEL_FONT, lineHeight: LABEL_LINE, marginLeft: ICON_GAP }}
                    >
                        {label}
                    </ButtonText>
                </View>
            </Button>
        );
    };

    return (
        // `md` and not `xs`: the action row above, the notice, the buttons and
        // the note read as one evenly spaced stack. The parent VStack on both
        // detail screens uses the SAME token for exactly that reason.
        <VStack space="md">
            {/* Hidden for a same-language article; it names the source
                language, so the buttons don't. */}
            <TranslationNotice
                sourceLanguage={sourceLanguage}
                support={support}
                showGuideLink={support.status === 'translatable'}
            />
            <Box
                testID="detail-read-routes"
                style={{ flexDirection: 'row', flexWrap: 'wrap', gap: ROUTE_GAP }}
            >
                {/* Owner: Google Translate ABOVE the original (first when the two
                    share a line). Render order is also VoiceOver order. */}
                {sameLanguage
                    ? null
                    : routeButton(
                          'detail-read-google-translate',
                          'g-translate',
                          t('articleDetail.readOnGoogleTranslate'),
                          () => openInAppBrowser(googleTranslateUrl),
                          true,
                      )}
                {routeButton(
                    'detail-read-publisher',
                    'open-in-new',
                    publication ? t('articleDetail.readOn', { publication }) : t('articleDetail.readArticle'),
                    () => onOpenUrl(articleUrl),
                    publisherReadable,
                )}
            </Box>
            {sameLanguage ? null : (
                // Not a failure we can detect: a publisher that refuses to be
                // framed gives Google Translate a blank page, so the reader is
                // told the way out up front.
                <Text
                    testID="detail-translate-blocked-note"
                    size="xs"
                    className="text-typography-400 text-center"
                >
                    {t('articleDetail.translateBlockedNote')}
                </Text>
            )}
        </VStack>
    );
};

export default ReadTranslateActions;
