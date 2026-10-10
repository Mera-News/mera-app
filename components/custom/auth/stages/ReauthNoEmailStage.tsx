import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { SUPPORT_EMAIL } from '@/lib/config/branding';
import { showFeedback } from '@/lib/feedback';
import { hapticLight } from '@/lib/haptics';
import { useSupportAction } from '@/lib/intercom';
import { buildSupportMailtoUrl } from '@/lib/support-id';
import { useColors } from '@/lib/theme/tokens';

import { GateIcon, IconAction } from './parts';
import { styles } from './styles';

// ── The gate: an account without an email ───────────────────────────────────

function ReauthNoEmailStage({
    supportId,
    onTryAgain,
}: {
    supportId: string | null;
    /** True when it led somewhere (signed in, or the switch question). */
    onTryAgain: () => Promise<boolean>;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const { openSupport } = useSupportAction();
    const [working, setWorking] = useState(false);
    const [failed, setFailed] = useState(false);
    const [copied, setCopied] = useState(false);
    const mounted = useRef(true);
    useEffect(() => () => {
        mounted.current = false;
    }, []);

    const tryAgain = async () => {
        if (working) return;
        setWorking(true);
        setFailed(false);
        const ok = await onTryAgain().catch(() => false);
        if (!mounted.current) return;
        setWorking(false);
        if (!ok) setFailed(true);
    };

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
            <Text style={[styles.text, styles.centerText, { color: colors.ink2 }]}>{t('gate.noEmailBody')}</Text>
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
            {failed ? (
                <Text style={[styles.text, styles.centerText, { color: colors.negative }]}>{t('auth.deviceSignInFailed')}</Text>
            ) : null}
            <View style={styles.flex} />
            <View style={styles.actions}>
                <Button action="primary" onPress={() => void tryAgain()} isDisabled={working} testID="reauth-try-again">
                    {working ? <ButtonSpinner /> : null}
                    <ButtonText>{t('auth.tryAgain')}</ButtonText>
                </Button>
                <View style={styles.iconRow}>
                    <IconAction icon="support-agent" label={t('account.contactSupport')} onPress={() => void openSupport()} testID="reauth-talk-to-support" />
                    <IconAction icon="bug-report" label={t('preferences.reportBug')} onPress={() => showFeedback()} testID="reauth-report-bug" />
                    <IconAction
                        icon="mail-outline"
                        label={t('gate.emailSupport')}
                        onPress={() => void Linking.openURL(buildSupportMailtoUrl(SUPPORT_EMAIL, supportId)).catch(() => undefined)}
                        testID="reauth-email-support"
                    />
                </View>
            </View>
        </View>
    );
}

export { ReauthNoEmailStage };
