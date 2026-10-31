import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { useColors } from '@/lib/theme/tokens';

import { styles } from './styles';

// ── Sign in with this phone? ──────────────────────────────────────────────────

function DifferentAccountSheet({
    onKeep,
    onContinue,
}: {
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
                {t('auth.differentAccount.bodyGeneric')}
            </Text>
            <View style={styles.sheetActions}>
                <Button action="negative" onPress={() => void run(onContinue)} isDisabled={busy} style={{ minHeight: 44 }} testID="auth-different-account-continue">
                    {busy ? <ButtonSpinner /> : null}
                    <ButtonText>{t('auth.differentAccount.continue')}</ButtonText>
                </Button>
                <Button variant="outline" action="secondary" onPress={() => void run(onKeep)} isDisabled={busy} style={{ minHeight: 44 }} testID="auth-different-account-back">
                    <ButtonText>{t('auth.differentAccount.useEmail')}</ButtonText>
                </Button>
            </View>
        </View>
    );
}

export { DifferentAccountSheet };
