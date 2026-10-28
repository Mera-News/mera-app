import { Button, ButtonText } from '@/components/ui/button';
import { HelpModal } from '@/components/ui/help-modal';
import { Text } from '@/components/ui/text';
import { getLocalizedLanguageName } from '@/lib/algorithms/language-names';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

interface AboutTranslationModalProps {
    open: boolean;
    onClose: () => void;
    appLanguage: string;
    /** The publication as shown on the "Read on" button. */
    publication: string | null;
}

/**
 * What the "About Google Translate" line under "Read on Google Translate"
 * explains: the language Google shows the article in, that the page loads
 * through Google, and that some sites block it. Google Translate only; how to
 * translate on the phone itself is the video under "Read on <publication>".
 */
const AboutTranslationModal: React.FC<AboutTranslationModalProps> = ({
    open,
    onClose,
    appLanguage,
    publication,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const language = getLocalizedLanguageName(appLanguage, appLanguage) ?? appLanguage;
    const line = { color: colors.ink2, fontSize: 16, lineHeight: 22 } as const;

    return (
        <HelpModal open={open} onClose={onClose} title={t('articleDetail.aboutGoogleTranslate')} testID="about-translation">
            <View style={{ gap: 10 }}>
                <Text style={line}>{t('articleDetail.googleTranslateBody', { language })}</Text>
                <Text style={line}>
                    {publication
                        ? t('articleDetail.translateBlockedOn', { publication })
                        : t('articleDetail.translateBlockedNote')}
                </Text>
            </View>
            <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 16, marginTop: 24 }}>
                <Button action="primary" onPress={onClose} testID="about-translation-close">
                    <ButtonText>{t('tabExplainer.close')}</ButtonText>
                </Button>
            </View>
        </HelpModal>
    );
};

export default AboutTranslationModal;
