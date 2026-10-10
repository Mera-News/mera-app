import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { useColors } from '@/lib/theme/tokens';
import { maskEmail } from '@/lib/algorithms/mask-email';

import { styles } from './styles';

// ── Sign in without email? ──────────────────────────────────────────────────

function DifferentAccountSheet({
    email,
    onKeep,
    onContinue,
}: {
    email: string | null;
    onKeep: () => Promise<void>;
    onContinue: () => Promise<void>;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const [busy, setBusy] = useState(false);
    const run = async (action: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        try {
            await action();
        } finally {
            setBusy(false);
        }
    };
    return (
        <View style={styles.sheet}>
            <Text accessibilityRole="header" style={[styles.sheetTitle, { color: colors.ink }]}>
                {t('auth.differentAccount.title')}
            </Text>
            <Text style={[styles.text, { color: colors.ink2 }]}>
                {email
                    ? t('auth.differentAccount.body', { email: maskEmail(email) })
                    : t('auth.differentAccount.bodyGeneric')}
            </Text>
            <View style={styles.sheetActions}>
                <Button variant="outline" action="secondary" onPress={() => void run(onKeep)} isDisabled={busy} className="flex-1" testID="auth-different-account-back">
                    <ButtonText>{t('auth.differentAccount.useEmail')}</ButtonText>
                </Button>
                <Button action="negative" onPress={() => void run(onContinue)} isDisabled={busy} className="flex-1" testID="auth-different-account-continue">
                    {busy ? <ButtonSpinner /> : null}
                    <ButtonText>{t('auth.differentAccount.continue')}</ButtonText>
                </Button>
            </View>
        </View>
    );
}

export { DifferentAccountSheet };
