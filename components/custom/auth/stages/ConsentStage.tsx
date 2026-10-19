import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import ConsentContent from '@/components/custom/auth/ConsentContent';
import { consentNoticeKey, deviceFailureKey } from '@/components/custom/auth/device-sign-in-copy';
import { ScrollView } from '@/components/ui/scroll-view';
import { Button, ButtonText } from '@/components/ui/button';
import type { DeviceSignInFailureReason, DeviceSignInPath } from '@/lib/device-auth';
import { useColors } from '@/lib/theme/tokens';

import { signInWithPhone, type DeviceSignInSuccess } from '../useAuthScreen';
import { BackArrow, PhoneUnsupported } from './parts';
import { styles } from './styles';

// ── 5 · Before you start ─────────────────────────────────────────────────────

function ConsentStage({
    mode,
    signInPath,
    expectedUserId,
    onAgreedForEmail,
    onSignedIn,
    onDifferentAccount,
    onUnsupportedToEmail,
    onBack,
}: {
    mode: 'device' | 'email';
    signInPath: DeviceSignInPath;
    expectedUserId: string | null;
    onAgreedForEmail: () => void;
    onSignedIn: (result: DeviceSignInSuccess) => void;
    onDifferentAccount: (result: DeviceSignInSuccess) => void;
    /** Only the gate has an email to fall back to; a new user stays here. */
    onUnsupportedToEmail?: () => void;
    onBack: () => void;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const [working, setWorking] = useState(false);
    const [failure, setFailure] = useState<DeviceSignInFailureReason | null>(null);
    const [unsupported, setUnsupported] = useState(false);

    const agree = async () => {
        if (working) return;
        if (mode === 'email') {
            onAgreedForEmail();
            return;
        }
        setWorking(true);
        setFailure(null);
        setUnsupported(false);
        const outcome = await signInWithPhone(expectedUserId);
        if (outcome.kind === 'signed-in') {
            onSignedIn(outcome.result); // leave `working`: this screen is replaced
            return;
        }
        setWorking(false);
        if (outcome.kind === 'different') onDifferentAccount(outcome.result);
        else if (outcome.kind === 'unsupported') {
            if (onUnsupportedToEmail) onUnsupportedToEmail();
            else setUnsupported(true);
        }
        else setFailure(outcome.reason);
    };

    const noticeKey = mode === 'device' ? consentNoticeKey(signInPath) : null;
    const failureText = failure ? t(deviceFailureKey(failure)) : '';

    return (
        <View style={styles.pad} testID="auth-consent">
            {/* The top bar: back on the left of the logo's row (the hoisted
                logo is centred over it). Then ONE centred stack, like the
                begin step; taller than the screen, it scrolls from the top. */}
            <View style={styles.topBar}>
                <BackArrow onPress={onBack} style={styles.backInBar} />
            </View>
            <ScrollView contentContainerStyle={styles.consentStack}>
                <ConsentContent
                    testIDPrefix="auth-consent"
                    title={t('auth.track.beforeYouStart')}
                    body={t('consent.welcomeBody')}
                    notice={
                        noticeKey ? (
                            <Text testID="auth-consent-device-notice" style={[styles.text, styles.centerText, { color: colors.ink2 }]}>
                                {t(noticeKey)}
                            </Text>
                        ) : undefined
                    }
                    ctaLabel={t('consent.accept')}
                    busyLabel={t('auth.deviceSignInWorking')}
                    busy={working}
                    onAccept={() => void agree()}
                >
                    {failure !== null ? (
                        <View style={styles.gap8}>
                            <Text testID="auth-device-failure" style={[styles.text, { color: colors.negative, textAlign: 'center' }]}>
                                {failureText}
                            </Text>
                            <Button variant="outline" action="secondary" onPress={() => void agree()} testID="auth-device-retry">
                                <ButtonText>{t('auth.tryAgain')}</ButtonText>
                            </Button>
                        </View>
                    ) : null}
                    {unsupported ? <PhoneUnsupported testID="auth-device-unsupported" /> : null}
                </ConsentContent>
            </ScrollView>
        </View>
    );
}

export { ConsentStage };
