import React from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button, ButtonText } from '@/components/ui/button';
import { useSupportAction } from '@/lib/intercom';
import { useColors } from '@/lib/theme/tokens';

import { GateIcon } from './parts';
import { styles } from './styles';

// ── The gate: a code for a different account ─────────────────────────────────

/**
 * The emailed code signed in an account other than this device's. Nothing was
 * wiped and the session was signed out again (email-code-sign-in.ts): the way
 * on is the email on this account, or help.
 */
function ReauthMismatchStage({ onOtherEmail }: { onOtherEmail: () => void }) {
    const { t } = useTranslation();
    const colors = useColors();
    const { openSupport } = useSupportAction();
    return (
        <View style={[styles.pad, styles.center]} testID="auth-reauth-mismatch">
            <GateIcon name="error-outline" />
            <Text accessibilityRole="header" style={[styles.title, styles.centerText, { color: colors.ink }]}>
                {t('gate.mismatchTitle')}
            </Text>
            <Text style={[styles.text, styles.centerText, { color: colors.ink2 }]}>{t('gate.mismatchBody')}</Text>
            <View style={styles.flex} />
            <View style={styles.actions}>
                <Button action="primary" onPress={onOtherEmail} testID="reauth-mismatch-other-email">
                    <ButtonText>{t('gate.mismatchOtherEmail')}</ButtonText>
                </Button>
                <Button variant="outline" action="secondary" onPress={() => void openSupport()} testID="reauth-mismatch-help">
                    <ButtonText>{t('account.contactSupport')}</ButtonText>
                </Button>
            </View>
        </View>
    );
}

export { ReauthMismatchStage };
