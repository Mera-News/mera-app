import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { sendOTP } from '@/lib/auth-client';
import logger from '@/lib/logger';
import { useColors } from '@/lib/theme/tokens';
import { maskEmail } from '@/lib/algorithms/mask-email';

import { GateIcon } from './parts';
import { styles } from './styles';

// ── The gate: an account with an email ──────────────────────────────────────

function ReauthEmailStage({
    email,
    onSent,
    onWithoutEmail,
}: {
    email: string;
    onSent: () => void;
    onWithoutEmail?: () => void;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const [sending, setSending] = useState(false);
    const [error, setError] = useState('');

    const send = async () => {
        if (sending) return;
        setSending(true);
        setError('');
        try {
            const result = await sendOTP(email);
            if (result.success) onSent();
            else setError(result.error || t('common.tryAgain'));
        } catch (err) {
            logger.captureException(err, { tags: { screen: 'AuthScreen', method: 'reauthSendOTP' } });
            setError(t('auth.networkError'));
        } finally {
            setSending(false);
        }
    };

    return (
        <View style={[styles.pad, styles.center]} testID="auth-reauth-email">
            <GateIcon name="lock-outline" />
            <Text accessibilityRole="header" style={[styles.title, styles.centerText, { color: colors.ink }]}>
                {t('gate.reauthTitle')}
            </Text>
            <Text style={[styles.text, styles.centerText, { color: colors.ink2 }]}>{t('gate.reauthBody')}</Text>
            <View style={[styles.pill, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                <MaterialIcons name="account-circle" size={18} color={colors.ink3} />
                <Text style={[styles.pillText, { color: colors.ink }]}>{maskEmail(email)}</Text>
            </View>
            {error ? <Text style={[styles.text, styles.centerText, { color: colors.negative }]}>{error}</Text> : null}
            <View style={styles.flex} />
            <View style={styles.actions}>
                <Button action="primary" onPress={() => void send()} isDisabled={sending} testID="reauth-send-code">
                    {sending ? <ButtonSpinner /> : null}
                    <ButtonText>{t('auth.track.sendCode')}</ButtonText>
                </Button>
                {onWithoutEmail ? (
                    <Button variant="outline" action="secondary" onPress={onWithoutEmail} testID="reauth-without-email">
                        <ButtonText>{t('auth.signInWithoutEmail')}</ButtonText>
                    </Button>
                ) : null}
            </View>
        </View>
    );
}

export { ReauthEmailStage };
