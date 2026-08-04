import TranslationNotice from '@/components/custom/news-detail/TranslationNotice';
import { Button, ButtonIcon, ButtonText } from '@/components/ui/button';
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

/** White — the neutral "just open the page as published" action. */
const VIEW_ORIGINAL_COLOR = '#FFFFFF';
/** The app's green — same token `CardActionBar` uses for a registered verdict. */
const GREEN_COLOR = '#22C55E';
/** Icon/label colour ON a green-filled button. White on #22C55E is ~2.2:1, so
 *  filled buttons flip to near-black instead. */
const ON_GREEN_COLOR = '#052E16';

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
 * ONE layout in every state — the translation-support status only changes the
 * notice line and the two buttons' colours, never their order:
 *
 * 1. The Google Translate button — THREE-QUARTER width, centred, deliberately
 *    smaller than the publisher button. Always rendered: prod data has
 *    mislabeled-language articles, so Google Translate must stay reachable
 *    even when on-device translation is (believed to be) moot.
 * 2. `TranslationNotice` (hidden when the article is already in the reader's
 *    language; it is what names the source language, so the buttons don't).
 *    It sits BETWEEN the buttons so it reads as context for the choice.
 * 3. The full-width "Read on {{publication}}" button.
 *
 * Colour marks the route that will actually get the reader something they can
 * read:
 *
 * | article language          | Google Translate | Read on {publication} |
 * |---------------------------|------------------|-----------------------|
 * | same as the reader's      | white outline    | GREEN FILL            |
 * | other, device CAN translate | GREEN FILL     | green outline         |
 * | other, device CANNOT      | GREEN FILL       | white outline         |
 *
 * Gluestack's `action` variants have no green, so every button is a neutral
 * `variant="outline" action="secondary"` base whose fill/border/label colour is
 * restated BOTH as a Tailwind class and as the matching inline style — see the
 * note on `googleFillClass` for why one of the two is not enough. The half
 * width is an inline style rather than a `w-1/2` class for the same reason.
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

    // Green marks the readable route. Same language ⇒ the publisher page is it;
    // otherwise Google Translate is, and the publisher link is merely ALSO an
    // option when the device can translate on its own.
    const sameLanguage = support.status === 'same-language';
    const googleFilled = !sameLanguage;
    const publisherColor = sameLanguage
        ? ON_GREEN_COLOR
        : support.status === 'translatable'
            ? GREEN_COLOR
            : VIEW_ORIGINAL_COLOR;

    // Every colour is expressed TWICE — as a Tailwind class AND as the matching
    // inline style. Gluestack's `buttonTextStyle` tva sets a label colour of its
    // own per variant (`text-typography-800` on a solid secondary), and which of
    // className/style wins the merge differs between the Pressable root and the
    // Text; stating both means the outcome is the same colour either way.
    // The class/hex pairs are Tailwind defaults (this config overrides no
    // greens): green-500 = #22C55E, green-950 = #052E16.
    const googleFillClass = googleFilled
        ? 'bg-green-500 border-green-500'
        : 'border-white';
    const googleLabelClass = googleFilled ? 'text-green-950' : 'text-white';
    const publisherFillClass = sameLanguage
        ? 'bg-green-500 border-green-500'
        : support.status === 'translatable'
            ? 'border-green-500'
            : 'border-white';
    const publisherLabelClass = sameLanguage
        ? 'text-green-950'
        : support.status === 'translatable'
            ? 'text-green-500'
            : 'text-white';

    return (
        // `md` and not `xs`: the four things in this column — the action row
        // above, this Google button, the notice, the publisher button — should
        // read as one evenly-spaced stack. The parent VStack on both detail
        // screens uses the SAME token for exactly that reason; if you change
        // one, change all three or the rhythm breaks at the seam.
        <VStack space="md">
            <Button
                testID="detail-read-google-translate"
                variant="outline"
                action="secondary"
                size="sm"
                className={`rounded-full ${googleFillClass}`}
                style={{
                    // 3/4, not 1/2. At 375pt a half-width button left ~120pt of
                    // label room for a string needing ~170, so "Read on Google
                    // Translate" truncated to "Read on Google Tr…". Still
                    // visibly subordinate to the full-width publisher button,
                    // which is the point of sizing it down at all.
                    width: '75%',
                    alignSelf: 'center',
                    borderWidth: 1,
                    backgroundColor: googleFilled ? GREEN_COLOR : 'transparent',
                    borderColor: googleFilled ? GREEN_COLOR : VIEW_ORIGINAL_COLOR,
                }}
                onPress={() => openInAppBrowser(googleTranslateUrl)}
            >
                <ButtonIcon
                    as={() => (
                        <MaterialIcons
                            name="g-translate"
                            size={16}
                            color={googleFilled ? ON_GREEN_COLOR : VIEW_ORIGINAL_COLOR}
                        />
                    )}
                />
                <ButtonText
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    className={`ml-2 ${googleLabelClass}`}
                    style={{
                        flexShrink: 1,
                        color: googleFilled ? ON_GREEN_COLOR : VIEW_ORIGINAL_COLOR,
                    }}
                >
                    {t('articleDetail.readOnGoogleTranslate')}
                </ButtonText>
            </Button>

            {/* BETWEEN the two buttons, deliberately: it explains what language the
                article is in and which route will read it, so it sits with the
                choice rather than above it. Its copy no longer says "below" —
                the Google button is now ABOVE it, and a directional word has
                already been invalidated twice by layout changes. */}
            <TranslationNotice
                sourceLanguage={sourceLanguage}
                support={support}
                showGuideLink={support.status === 'translatable'}
            />

            <Button
                testID="detail-read-publisher"
                variant="outline"
                action="secondary"
                className={`rounded-full ${publisherFillClass}`}
                style={{
                    borderWidth: 1,
                    backgroundColor: sameLanguage ? GREEN_COLOR : 'transparent',
                    borderColor: sameLanguage ? GREEN_COLOR : publisherColor,
                }}
                onPress={() => onOpenUrl(articleUrl)}
            >
                <ButtonIcon
                    as={() => (
                        <MaterialIcons
                            name="open-in-new"
                            size={18}
                            color={publisherColor}
                        />
                    )}
                />
                <ButtonText
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    className={`ml-2 ${publisherLabelClass}`}
                    style={{ flexShrink: 1, color: publisherColor }}
                >
                    {publication
                        ? t('articleDetail.readOn', { publication })
                        : t('articleDetail.readArticle')}
                </ButtonText>
            </Button>
        </VStack>
    );
};

export default ReadTranslateActions;
