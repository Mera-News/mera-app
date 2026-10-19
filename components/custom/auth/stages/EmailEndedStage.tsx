import React from 'react';
import { Platform, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button, ButtonText } from '@/components/ui/button';
import { useColors } from '@/lib/theme/tokens';

import { emailCutoffLabel } from '../move-to-phone';
import { GateIcon } from './parts';
import { styles } from './styles';

// ── The gate after the cutoff: email sign-in has ended ──────────────────────

function EmailEndedStage({ onUsePhone }: { onUsePhone?: () => void }) {
    const { t, i18n } = useTranslation();
    const colors = useColors();
    return (
        <View style={[styles.pad, styles.center]} testID="auth-email-ended">
            <GateIcon name="lock-outline" />
            <Text accessibilityRole="header" style={[styles.title, styles.centerText, { color: colors.ink }]}>
                {t('auth.emailEnded.title')}
            </Text>
            <Text style={[styles.text, styles.centerText, { color: colors.ink2 }]}>
                {t(Platform.OS === 'ios' ? 'auth.emailEnded.bodyIos' : 'auth.emailEnded.bodyAndroid', { date: emailCutoffLabel(i18n.language) })}
            </Text>
            <View style={styles.flex} />
            {onUsePhone ? (
                <View style={styles.actions}>
                    <Button action="primary" onPress={onUsePhone} testID="email-ended-use-phone">
                        <ButtonText>{t('auth.signInWithoutEmail')}</ButtonText>
                    </Button>
                </View>
            ) : null}
        </View>
    );
}

export { EmailEndedStage };
