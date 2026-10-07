import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
import { Button, ButtonText } from '@/components/ui/button';
import { Modal, ModalBackdrop, ModalBody, ModalContent } from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { TRANSLATION_GUIDE_URL } from '@/lib/config/branding';
import { getLocalizedLanguageName } from '@/lib/language-names';
import { useColors } from '@/lib/theme/tokens';
import type { ArticleTranslationSupport } from '@/lib/translation-service';
import React, { useState } from 'react';
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
            <Modal isOpen={open} onClose={onClose} size="md">
                <ModalBackdrop />
                <ModalContent testID="about-translation">
                    <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 20, fontWeight: '700' }}>
                        {t('articleDetail.aboutTranslation')}
                    </Text>
                    <ModalBody>
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
                                        onClose();
                                        setGuideOpen(true);
                                    }}
                                    style={{ minHeight: 44, justifyContent: 'center' }}
                                >
                                    <Text style={{ color: colors.accentText, fontSize: 16, fontWeight: '600' }}>
                                        {t('clusterDetail.translationGuideLink')}
                                    </Text>
                                </Pressable>
                            ) : null}
                        </View>
                    </ModalBody>
                    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 16 }}>
                        <Button action="primary" onPress={onClose} testID="about-translation-close">
                            <ButtonText>{t('tabExplainer.close')}</ButtonText>
                        </Button>
                    </View>
                </ModalContent>
            </Modal>
            <VideoPlayerModal visible={guideOpen} uri={TRANSLATION_GUIDE_URL} onClose={() => setGuideOpen(false)} />
        </>
    );
};

export default AboutTranslationModal;
