import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { TRANSLATION_GUIDE_URL } from '@/lib/config/branding';
import { getLocalizedLanguageName } from '@/lib/language-names';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import {
    getArticleTranslationSupport,
    type ArticleTranslationSupport,
} from '@/lib/translation-service';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Green — the device can translate this article while the user reads it. */
export const TRANSLATABLE_COLOR = '#86EFAC';
/** Pastel yellow — the device can't, but Google Translate can. Not an error. */
export const NOT_TRANSLATABLE_COLOR = '#FDE68A';

interface TranslationNoticeProps {
    /** Article's detected source language code. */
    sourceLanguage?: string | null;
    /** Pre-computed support, when the parent already resolved it. */
    support?: ArticleTranslationSupport;
    /** Show the "how to translate" video link on the translatable notice. */
    showGuideLink?: boolean;
}

/**
 * The one-line translation-status banner under an article headline.
 *
 * Both article-detail surfaces render this: `ReadTranslateActions` (the CTA
 * block on the suggestion/article screens) and `NewsClusterScreen`. It used
 * to be duplicated between them and the two copies had already drifted apart
 * — same layout, different colours and different copy paths.
 *
 * `not-translatable` deliberately reads as informational, not as an error:
 * the Google Translate button beside it always works. (Do NOT reintroduce a
 * directional word here or in the copy — the button has moved above this
 * notice once already, and "below" then pointed at the publisher link.)
 */
const TranslationNotice: React.FC<TranslationNoticeProps> = ({
    sourceLanguage,
    support,
    showGuideLink = false,
}) => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();
    const [showGuideVideo, setShowGuideVideo] = useState(false);

    const resolved = support ?? getArticleTranslationSupport(sourceLanguage, appLanguage);
    if (resolved.status === 'same-language') return null;

    const languageName =
        getLocalizedLanguageName(sourceLanguage, appLanguage)
        ?? t('clusterDetail.unknownLanguage');
    const translatable = resolved.status === 'translatable';

    // 'os-outdated' is the one case where we can tell the user how to fix it,
    // so it gets its own copy naming both versions.
    const message = translatable
        ? t('clusterDetail.translatable', { language: languageName })
        : resolved.reason === 'os-outdated'
            ? t('clusterDetail.notTranslatableOsOutdated', {
                language: languageName,
                requiredVersion: resolved.requiredOSMajor,
                currentVersion: resolved.currentOSMajor,
            })
            : t('clusterDetail.notTranslatable', { language: languageName });

    return (
        <>
            <HStack className="items-center justify-center px-2" space="xs">
                <MaterialIcons
                    name="translate"
                    size={14}
                    color={translatable ? TRANSLATABLE_COLOR : NOT_TRANSLATABLE_COLOR}
                />
                <Text
                    size="xs"
                    italic
                    className={`flex-1 ${translatable ? 'text-green-300' : 'text-typography-400'}`}
                >
                    {message}
                    {translatable && showGuideLink ? (
                        <Text
                            size="xs"
                            italic
                            className="text-orange-400 underline"
                            onPress={() => setShowGuideVideo(true)}
                        >
                            {' '}{t('clusterDetail.translationGuideLink')}
                        </Text>
                    ) : null}
                </Text>
            </HStack>

            {showGuideLink ? (
                <VideoPlayerModal
                    visible={showGuideVideo}
                    uri={TRANSLATION_GUIDE_URL}
                    onClose={() => setShowGuideVideo(false)}
                />
            ) : null}
        </>
    );
};

export default TranslationNotice;
