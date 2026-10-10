import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import validator from 'validator';

import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { sendOTP } from '@/lib/auth-client';
import logger from '@/lib/logger';
import { useColors, useThemeMode } from '@/lib/theme/tokens';

import { BackArrow } from './parts';
import { styles } from './styles';

// ── Continue with email ──────────────────────────────────────────────────────

function EmailStage({
    initialEmail,
    onBack,
    onSent,
}: {
    initialEmail: string;
    onBack: () => void;
    onSent: (email: string) => void;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const keyboard = useThemeMode();
    const [email, setEmail] = useState(initialEmail);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState('');
    const valid = validator.isEmail(email.trim());

    const send = async () => {
        if (!valid || sending) return;
        setSending(true);
        setError('');
        const address = email.trim();
        try {
            const result = await sendOTP(address);
            if (result.success) onSent(address);
            else setError(result.error || t('common.tryAgain'));
        } catch (err) {
            logger.captureException(err, { tags: { screen: 'AuthScreen', method: 'sendOTP' } });
            setError(t('auth.networkError'));
        } finally {
            setSending(false);
        }
    };

    return (
        <View style={styles.pad} testID="auth-email">
            <BackArrow onPress={onBack} />
            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                {t('auth.track.continueWithEmail')}
            </Text>
            <Text style={[styles.text, { color: colors.ink2, marginTop: 8 }]}>{t('auth.track.emailBody')}</Text>
            <TextInput
                testID="auth-email-input"
                value={email}
                onChangeText={(v) => {
                    setEmail(v);
                    if (error) setError('');
                }}
                placeholder={t('auth.emailPlaceholder')}
                placeholderTextColor={colors.ink3}
                keyboardType="email-address"
                keyboardAppearance={keyboard}
                textContentType="emailAddress"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="send"
                onSubmitEditing={() => void send()}
                style={[styles.field, { color: colors.ink, borderColor: colors.line, backgroundColor: colors.surface }]}
            />
            {error ? <Text style={[styles.text, { color: colors.negative, marginTop: 10 }]}>{error}</Text> : null}
            <Button action="primary" onPress={() => void send()} isDisabled={!valid || sending} className="mt-4" testID="auth-send-otp">
                {sending ? <ButtonSpinner /> : null}
                <ButtonText>{t('auth.track.sendCode')}</ButtonText>
            </Button>
        </View>
    );
}

export { EmailStage };
