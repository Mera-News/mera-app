import TranslationNotice, {
    NOT_TRANSLATABLE_COLOR,
    TRANSLATABLE_COLOR,
} from '@/components/custom/news-detail/TranslationNotice';
import { Button, ButtonIcon, ButtonText } from '@/components/ui/button';
import { VStack } from '@/components/ui/vstack';
import { getLocalizedLanguageName } from '@/lib/language-names';
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

interface ReadTranslateActionsProps {
    /** The publisher's article URL. */
    articleUrl: string;
    /** Article's detected source language code. Drives
     *  {@link getArticleTranslationSupport} to decide which layout to render. */
    sourceLanguage?: string | null;
    /** The screen's own "open article" handler (records the publication visit,
     *  opens the in-app browser, etc.) — called with `articleUrl` for the
     *  primary read/translate button. */
    onOpenUrl: (url: string) => void;
}

/**
 * Shared read/translate call-to-action block for the article detail screens
 * (`ArticleSuggestionScreen`, `ArticleDetailScreen`). Layout depends on
 * {@link getArticleTranslationSupport}:
 *
 * - `same-language`: primary "Read Article" button, plus a secondary "View in
 *   Google Translate" button ALWAYS shown below it — prod data has
 *   mislabeled-language articles, so Google Translate must stay reachable even
 *   when on-device translation is (believed to be) moot.
 * - `translatable`: a GREEN-outline "View article & translate on device"
 *   button, a helper line inviting the on-device translator (with a link to
 *   the guide video), then the secondary Google Translate button.
 * - `not-translatable`: a WHITE-outline "View original article in {{language}}"
 *   button, an informational helper line, then a PASTEL-YELLOW "Read in your
 *   language (Google Translate)" button — the suggested path when the device
 *   can't translate this source language.
 *
 * Colour carries the meaning here: yellow is "there's another way to read
 * this", not "something is wrong". Gluestack's `action` variants have no
 * yellow or green, and `action="negative"` is what forced the old red border,
 * so borders are set through `style` (an RN inline style beats the variant's
 * className) on a neutral `action="secondary"` base.
 *
 * The publisher name deliberately does NOT appear on these buttons — the card
 * meta row already names the source.
 */
const ReadTranslateActions: React.FC<ReadTranslateActionsProps> = ({
    articleUrl,
    sourceLanguage,
    onOpenUrl,
}) => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();

    const support = getArticleTranslationSupport(sourceLanguage, appLanguage);
    const languageName = getLocalizedLanguageName(sourceLanguage, appLanguage);
    // Wrap the article URL with Mera's UTM referrer params BEFORE handing it to
    // Google Translate, so the article the reader lands on stays attributed to
    // Mera (Google Translate carries the wrapped `u` param through).
    const googleTranslateUrl = buildGoogleTranslateUrl(appendReferrer(articleUrl), appLanguage);

    const googleTranslateButton = (label: string, size: 'sm' | 'md') => (
        <Button
            variant="outline"
            action="secondary"
            size={size}
            className="rounded-full"
            style={{ borderColor: NOT_TRANSLATABLE_COLOR }}
            onPress={() => openInAppBrowser(googleTranslateUrl)}
        >
            <ButtonIcon
                as={() => (
                    <MaterialIcons
                        name="translate"
                        size={size === 'sm' ? 16 : 18}
                        color={NOT_TRANSLATABLE_COLOR}
                    />
                )}
            />
            <ButtonText className="text-amber-200 ml-2">{label}</ButtonText>
        </Button>
    );

    return (
        <VStack space="xs">
            {support.status === 'not-translatable' ? (
                <>
                    <Button
                        variant="outline"
                        action="secondary"
                        className="rounded-full"
                        style={{ borderColor: VIEW_ORIGINAL_COLOR }}
                        onPress={() => onOpenUrl(articleUrl)}
                    >
                        <ButtonIcon
                            as={() => (
                                <MaterialIcons
                                    name="open-in-new"
                                    size={18}
                                    color={VIEW_ORIGINAL_COLOR}
                                />
                            )}
                        />
                        <ButtonText className="text-white ml-2">
                            {languageName
                                ? t('articleDetail.viewOriginalIn', { language: languageName })
                                : t('articleDetail.viewOriginal')}
                        </ButtonText>
                    </Button>
                    <TranslationNotice sourceLanguage={sourceLanguage} support={support} />
                    {googleTranslateButton(t('clusterDetail.readViaGoogleTranslate'), 'md')}
                </>
            ) : (
                <>
                    <Button
                        variant="outline"
                        action="secondary"
                        className="rounded-full"
                        style={{
                            borderColor: support.status === 'translatable'
                                ? TRANSLATABLE_COLOR
                                : VIEW_ORIGINAL_COLOR,
                        }}
                        onPress={() => onOpenUrl(articleUrl)}
                    >
                        <ButtonIcon
                            as={() => (
                                <MaterialIcons
                                    name={support.status === 'translatable' ? 'translate' : 'open-in-new'}
                                    size={18}
                                    color={support.status === 'translatable'
                                        ? TRANSLATABLE_COLOR
                                        : VIEW_ORIGINAL_COLOR}
                                />
                            )}
                        />
                        <ButtonText
                            className={
                                support.status === 'translatable'
                                    ? 'text-green-300 ml-2'
                                    : 'text-white ml-2'
                            }
                        >
                            {support.status === 'translatable'
                                ? t('articleDetail.viewAndTranslateOnDevice')
                                : t('articleDetail.readArticle')}
                        </ButtonText>
                    </Button>
                    {support.status === 'translatable' ? (
                        <TranslationNotice
                            sourceLanguage={sourceLanguage}
                            support={support}
                            showGuideLink
                        />
                    ) : null}
                    {googleTranslateButton(t('clusterDetail.viewInGoogleTranslate'), 'sm')}
                </>
            )}
        </VStack>
    );
};

export default ReadTranslateActions;
