import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
import { Button, ButtonIcon, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TRANSLATION_GUIDE_URL } from '@/lib/config/branding';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import {
    buildGoogleTranslateUrl,
    getArticleTranslatableStatus,
    getLanguageName,
} from '@/lib/translation-service';
import { appendReferrer, openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ReadTranslateActionsProps {
    /** The publisher's article URL. */
    articleUrl: string;
    /** Publication display name, when known — drives the publication-aware
     *  button labels ("Read on {{publication}}" / "Translate & Read on
     *  {{publication}}"). Falls back to a generic label when absent. */
    publicationName?: string | null;
    /** Article's detected source language code. Drives
     *  {@link getArticleTranslatableStatus} to decide which layout to render. */
    sourceLanguage?: string | null;
    /** The screen's own "open article" handler (records the publication visit,
     *  opens the in-app browser, etc.) — called with `articleUrl` for the
     *  primary read/translate button. */
    onOpenUrl: (url: string) => void;
}

/**
 * Shared read/translate call-to-action block for the article detail screens
 * (`ArticleSuggestionScreen`, `ArticleDetailScreen`). Layout depends on
 * {@link getArticleTranslatableStatus}:
 *
 * - `same-language`: primary "Read on {{publication}}" button, plus a
 *   secondary "View in Google Translate" button ALWAYS shown below it — prod
 *   data has mislabeled-language articles, so Google Translate must stay
 *   reachable even when on-device translation is (believed to be) moot.
 * - `translatable`: primary "Translate & Read on {{publication}}" button, a
 *   helper line inviting the on-device translator (with a link to the guide
 *   video), then the secondary Google Translate button.
 * - `not-translatable`: a red-outline "View original" button, a neutral
 *   (non-alarming) helper line, then an OUTLINE primary "Read in your language
 *   (Google Translate)" button — the suggested path when the device can't
 *   translate this source language.
 */
const ReadTranslateActions: React.FC<ReadTranslateActionsProps> = ({
    articleUrl,
    publicationName,
    sourceLanguage,
    onOpenUrl,
}) => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();
    const [showGuideVideo, setShowGuideVideo] = useState(false);

    const status = getArticleTranslatableStatus(sourceLanguage, appLanguage);
    const languageName = getLanguageName(sourceLanguage) ?? t('clusterDetail.unknownLanguage');
    // Wrap the article URL with Mera's UTM referrer params BEFORE handing it to
    // Google Translate, so the article the reader lands on stays attributed to
    // Mera (Google Translate carries the wrapped `u` param through).
    const googleTranslateUrl = buildGoogleTranslateUrl(appendReferrer(articleUrl), appLanguage);

    const googleTranslateButton = (
        <Button
            variant="outline"
            action="secondary"
            size="sm"
            className="rounded-full"
            onPress={() => openInAppBrowser(googleTranslateUrl)}
        >
            <ButtonIcon as={() => <MaterialIcons name="translate" size={16} color="#ffffff" />} />
            <ButtonText className="text-white ml-2">
                {t('clusterDetail.viewInGoogleTranslate')}
            </ButtonText>
        </Button>
    );

    return (
        <VStack space="xs">
            {status === 'not-translatable' ? (
                <>
                    <Button
                        variant="outline"
                        action="negative"
                        className="rounded-full"
                        onPress={() => onOpenUrl(articleUrl)}
                    >
                        <ButtonIcon as={() => <MaterialIcons name="open-in-new" size={18} color="#FCA5A5" />} />
                        <ButtonText className="text-red-300 ml-2">
                            {t('articleDetail.viewOriginal')}
                        </ButtonText>
                    </Button>
                    <HStack className="items-center justify-center px-2" space="xs">
                        <MaterialIcons name="translate" size={14} color="#FBBF24" />
                        <Text size="xs" italic className="flex-1 text-typography-400">
                            {t('clusterDetail.notTranslatable', { language: languageName })}
                        </Text>
                    </HStack>
                    <Button
                        variant="outline"
                        action="primary"
                        className="rounded-full"
                        onPress={() => openInAppBrowser(googleTranslateUrl)}
                    >
                        <ButtonIcon as={() => <MaterialIcons name="translate" size={18} color="#ffffff" />} />
                        <ButtonText className="text-white ml-2">
                            {t('clusterDetail.readViaGoogleTranslate')}
                        </ButtonText>
                    </Button>
                </>
            ) : (
                <>
                    <Button
                        variant="outline"
                        action="primary"
                        className="rounded-full"
                        onPress={() => onOpenUrl(articleUrl)}
                    >
                        <ButtonIcon
                            as={() => (
                                <MaterialIcons
                                    name={status === 'translatable' ? 'translate' : 'open-in-new'}
                                    size={18}
                                    color="#ffffff"
                                />
                            )}
                        />
                        <ButtonText className="text-white ml-2">
                            {status === 'translatable'
                                ? (publicationName
                                    ? t('articleDetail.translateAndReadOn', { publication: publicationName })
                                    : t('articleDetail.translateAndRead'))
                                : (publicationName
                                    ? t('articleDetail.readOn', { publication: publicationName })
                                    : t('articleDetail.readArticle'))}
                        </ButtonText>
                    </Button>
                    {status === 'translatable' && (
                        <HStack className="items-center justify-center px-2" space="xs">
                            <MaterialIcons name="translate" size={14} color="#86EFAC" />
                            <Text size="xs" italic className="flex-1 text-green-300">
                                {t('clusterDetail.translatable', { language: languageName })}
                                <Text
                                    size="xs"
                                    italic
                                    className="text-orange-400 underline"
                                    onPress={() => setShowGuideVideo(true)}
                                >
                                    {' '}{t('clusterDetail.translationGuideLink')}
                                </Text>
                            </Text>
                        </HStack>
                    )}
                    {googleTranslateButton}
                </>
            )}

            <VideoPlayerModal
                visible={showGuideVideo}
                uri={TRANSLATION_GUIDE_URL}
                onClose={() => setShowGuideVideo(false)}
            />
        </VStack>
    );
};

export default ReadTranslateActions;
