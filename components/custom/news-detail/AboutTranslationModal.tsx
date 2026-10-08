import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
import { Button, ButtonText } from '@/components/ui/button';
import { HelpModal } from '@/components/ui/help-modal';
import { Text } from '@/components/ui/text';
import { TRANSLATION_GUIDE_URL } from '@/lib/config/branding';
import { getLocalizedLanguageName } from '@/lib/language-names';
import { useColors } from '@/lib/theme/tokens';
import type { ArticleTranslationSupport } from '@/lib/translation-service';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

interface AboutTranslationModalProps {
    open: boolean;
    onClose: () => void;
    /** Resolved by the read routes for the same article. */
    support: ArticleTranslationSupport;
    sourceLanguage?: string | null;
    appLanguage: string;
    /** The publication as shown on the "Read on" button. */
    publication: string | null;
}

/**
 * What the "?" beside "Read on Google Translate" explains (FinalRead #9): can
 * this phone translate the article while you read, what Google Translate
 * means (browsing through Google), and that some sites block it. A small
 * centred modal on the modal material; Got it is the primary orange.
 */
const AboutTranslationModal: React.FC<AboutTranslationModalProps> = ({
    open,
    onClose,
    support,
    sourceLanguage,
    appLanguage,
    publication,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const [guideOpen, setGuideOpen] = useState(false);
    // The guide opens once the card is fully gone: iOS will not present a
    // second Modal over one still leaving.
    const wantsGuide = useRef(false);
    if (support.status === 'same-language') return null;

    const language = getLocalizedLanguageName(sourceLanguage, appLanguage) ?? t('clusterDetail.unknownLanguage');
    const translatable = support.status === 'translatable';
    const body = translatable
        ? t('articleDetail.aboutTranslationBody', { language })
        : support.reason === 'os-outdated'
            ? t('clusterDetail.notTranslatableOsOutdated', {
                language,
                requiredVersion: support.requiredOSMajor,
                currentVersion: support.currentOSMajor,
            })
            : t('clusterDetail.notTranslatable', { language });
    const line = { color: colors.ink2, fontSize: 16, lineHeight: 22 } as const;

    return (
        <>
            <HelpModal
                open={open}
                onClose={onClose}
                onClosed={() => {
                    if (!wantsGuide.current) return;
                    wantsGuide.current = false;
                    setGuideOpen(true);
                }}
                title={t('articleDetail.aboutTranslation')}
                testID="about-translation"
            >
                        <View style={{ gap: 10 }}>
                            <Text style={line}>{body}</Text>
                            {translatable ? <Text style={line}>{t('articleDetail.aboutTranslationFallback')}</Text> : null}
                            <Text style={line}>
                                {publication
                                    ? t('articleDetail.translateBlockedOn', { publication })
                                    : t('articleDetail.translateBlockedNote')}
                            </Text>
                            {translatable ? (
                                <Pressable
                                    testID="about-translation-guide"
                                    accessibilityRole="link"
                                    accessibilityLabel={t('clusterDetail.translationGuideLink')}
                                    // One modal at a time: this one closes, then the guide opens.
                                    onPress={() => {
                                        wantsGuide.current = true;
                                        onClose();
                                    }}
                                    style={{ minHeight: 44, justifyContent: 'center' }}
                                >
                                    <Text style={{ color: colors.accentText, fontSize: 16, fontWeight: '600' }}>
                                        {t('clusterDetail.translationGuideLink')}
                                    </Text>
                                </Pressable>
                            ) : null}
                        </View>
                    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 16, marginTop: 24 }}>
                        <Button action="primary" onPress={onClose} testID="about-translation-close">
                            <ButtonText>{t('tabExplainer.close')}</ButtonText>
                        </Button>
                    </View>
            </HelpModal>
            <VideoPlayerModal visible={guideOpen} uri={TRANSLATION_GUIDE_URL} onClose={() => setGuideOpen(false)} />
        </>
    );
};

export default AboutTranslationModal;
