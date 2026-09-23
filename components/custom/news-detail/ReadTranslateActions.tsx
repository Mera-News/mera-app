import TranslationNotice from '@/components/custom/news-detail/TranslationNotice';
import { Box } from '@/components/ui/box';
import { Button, ButtonIcon, ButtonText } from '@/components/ui/button';
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
import { useTranslation } from 'react-i18next';

/** Both read routes share one look: a white outline, white label. */
const ROUTE_COLOR = '#FFFFFF';
/** Space between the two buttons, across and down. */
const ROUTE_GAP = 12;

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
 * N8: both read routes are EQUALLY usable, so they look the same.
 *
 * - Article in the reader's language: only "Read on {{publication}}".
 * - Any other language: `TranslationNotice` (names the source language), then
 *   "Read on {{publication}}" and "Read on Google Translate" as two identical
 *   white outline buttons, then a one-line note that some sites block Google
 *   Translate. The owner asked for no favourite, so the old green fill that
 *   marked one route as "the readable one" is gone.
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

    const publication = publicationName?.trim()
        ? titleCasePublication(publicationName)
        : null;
    const sameLanguage = support.status === 'same-language';

    const routeButton = (
        testID: string,
        icon: keyof typeof MaterialIcons.glyphMap,
        label: string,
        onPress: () => void,
    ) => (
        <Button
            testID={testID}
            variant="outline"
            action="secondary"
            className="rounded-full border-white"
            style={{
                flexGrow: 1,
                flexShrink: 1,
                borderWidth: 1,
                borderColor: ROUTE_COLOR,
                backgroundColor: 'transparent',
            }}
            onPress={onPress}
        >
            <ButtonIcon as={() => <MaterialIcons name={icon} size={18} color={ROUTE_COLOR} />} />
            <ButtonText
                numberOfLines={1}
                ellipsizeMode="tail"
                className="ml-2 text-white"
                style={{ flexShrink: 1, color: ROUTE_COLOR }}
            >
                {label}
            </ButtonText>
        </Button>
    );

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
                {routeButton(
                    'detail-read-publisher',
                    'open-in-new',
                    publication ? t('articleDetail.readOn', { publication }) : t('articleDetail.readArticle'),
                    () => onOpenUrl(articleUrl),
                )}
                {sameLanguage
                    ? null
                    : routeButton(
                          'detail-read-google-translate',
                          'g-translate',
                          t('articleDetail.readOnGoogleTranslate'),
                          () => openInAppBrowser(googleTranslateUrl),
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
