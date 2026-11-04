import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { hapticLight } from '@/lib/haptics';
import { useColors } from '@/lib/theme/tokens';

import { useAccountProblem } from '../useAccountProblem';
import { GateIcon } from './parts';
import { styles } from './styles';

// ── The gate: an account without an email ───────────────────────────────────

function ReauthNoEmailStage({
    supportId,
    onReset,
    onSignIn,
}: {
    supportId: string | null;
    onReset: () => void;
    /** Goes to the consent stage. Absent on Forgot PIN and on a phone that cannot attest. */
    onSignIn?: () => void;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const { contactSupport, supportEnabled, resetThisPhone, supportBusy, resetting } = useAccountProblem({ onReset });
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        if (!supportId) return;
        await Clipboard.setStringAsync(supportId).catch(() => undefined);
        void hapticLight();
        setCopied(true);
    };

    return (
        <View style={[styles.pad, styles.center]} testID="auth-reauth-no-email">
            <GateIcon name="error-outline" />
            <Text accessibilityRole="header" style={[styles.title, styles.centerText, { color: colors.ink }]}>
                {t('gate.noEmailTitle')}
            </Text>
            <Text style={[styles.text, styles.centerText, { color: colors.ink2 }]}>{t(onSignIn ? 'gate.signInBody' : 'gate.noEmailBody')}</Text>
            {supportId ? (
                <View style={[styles.pill, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                    <Text style={[styles.pillText, { color: colors.ink }]} selectable>
                        {t('support.supportId', { id: supportId })}
                    </Text>
                    <Pressable
                        onPress={() => void copy()}
                        accessibilityRole="button"
                        accessibilityLabel={t('support.copySupportId')}
                        style={styles.copy}
                        testID="reauth-copy-support-id"
                    >
                        <Text style={[styles.pillAction, { color: colors.accentText }]}>
                            {copied ? t('support.copied') : t('common.copy')}
                        </Text>
                    </Pressable>
                </View>
            ) : null}
            <View style={styles.flex} />
            <View style={styles.actions}>
                {onSignIn ? (
                    <Button action="primary" onPress={onSignIn} isDisabled={supportBusy || resetting} testID="reauth-sign-in">
                        <ButtonText>{t('gate.signIn')}</ButtonText>
                    </Button>
                ) : null}
                <Button
                    variant={onSignIn ? 'outline' : 'solid'}
                    action={onSignIn ? 'secondary' : 'primary'}
                    onPress={() => void contactSupport()}
                    isDisabled={!supportEnabled || supportBusy || resetting}
                    testID="reauth-contact-support"
                >
                    {supportBusy ? <ButtonSpinner /> : null}
                    <ButtonText>{t('gate.contactSupport')}</ButtonText>
                </Button>
                <Button
                    variant="outline"
                    action="secondary"
                    onPress={() => void resetThisPhone()}
                    isDisabled={supportBusy || resetting}
                    testID="reauth-reset-phone"
                >
                    {resetting ? <ButtonSpinner /> : null}
                    <ButtonText>{t('gate.resetPhone')}</ButtonText>
                </Button>
            </View>
        </View>
    );
}

export { ReauthNoEmailStage };
