import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { OtpBoxes, type OtpState } from '@/components/custom/auth/OtpBoxes';
import { authClient, sendOTP } from '@/lib/auth-client';
import { setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { clearIdentityFault, recordAuthenticatedUser } from '@/lib/security/identity-gate';
import { useUserStore } from '@/lib/stores/user-store';
import { useColors } from '@/lib/theme/tokens';
import { maskEmail } from '@/lib/utils/mask-email';

interface OTPVerificationViewProps {
    email: string;
    onVerificationSuccess?: (userId: string) => void;
    onBack?: () => void;
    /** "Check your email" on first launch; the sign-in gate says "Enter the code". */
    title?: string;
    /** First launch: "Use a different email" back to the address field. */
    onUseDifferentEmail?: () => void;
    /** Under the boxes (the gate's "Sign in without email"). */
    footer?: React.ReactNode;
}

const RESEND_COOLDOWN_S = 30;
/** Long enough for the boxes to go green one by one (30 ms apart) first. */
const RIGHT_CODE_HOLD_MS = 320;

/**
 * The code step (FinalJourney #22, #23; FinalStart #9): six boxes over one
 * hidden field, filled by the iPhone's "From Mail" suggestion in one tap; the
 * sixth digit submits by itself. A wrong code shakes the boxes red and clears
 * nothing; a right one turns them green and moves on.
 *
 * Verification bookkeeping is unchanged and happens here, before anything
 * navigates: the recorded user (identity gates read it while the session atom
 * settles), the cached email, needsReauth off and the identity fault cleared.
 */
const OTPVerificationView: React.FC<OTPVerificationViewProps> = ({
    email,
    onVerificationSuccess,
    onBack,
    title,
    onUseDifferentEmail,
    footer,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const [otp, setOtp] = useState('');
    const [state, setState] = useState<OtpState>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN_S);
    const [resending, setResending] = useState(false);
    const verifying = useRef(false);

    useEffect(() => {
        if (resendCooldown <= 0) return;
        const timer = setInterval(() => setResendCooldown((s) => s - 1), 1000);
        return () => clearInterval(timer);
    }, [resendCooldown]);

    const verify = async (code: string) => {
        if (verifying.current) return;
        verifying.current = true;
        setErrorMessage('');
        try {
            const { data, error } = await authClient.signIn.emailOtp({ email, otp: code });
            if (error || !data?.user) {
                setState('wrong');
                setErrorMessage(t('auth.track.wrongCode'));
                return;
            }
            recordAuthenticatedUser(data.user.id);
            setSetting('cached_user_email', email).catch(() => {});
            useUserStore.getState().setNeedsReauth(false);
            clearIdentityFault().catch(() => {});
            setState('right');
            const userId = data.user.id;
            setTimeout(() => onVerificationSuccess?.(userId), RIGHT_CODE_HOLD_MS);
        } catch (error) {
            logger.captureException(error, { tags: { feature: 'otp', method: 'verify' } });
            setState('wrong');
            setErrorMessage(t('auth.otpError'));
        } finally {
            verifying.current = false;
        }
    };

    const resend = async () => {
        if (resendCooldown > 0 || resending) return;
        setResending(true);
        setErrorMessage('');
        try {
            const result = await sendOTP(email);
            if (result.success) {
                setOtp('');
                setState('idle');
                setResendCooldown(RESEND_COOLDOWN_S);
            } else {
                setErrorMessage(result.error || t('common.tryAgain'));
            }
        } catch (error) {
            logger.captureException(error, { tags: { feature: 'otp', method: 'resend' } });
            setErrorMessage(t('common.tryAgain'));
        } finally {
            setResending(false);
        }
    };

    return (
        <View style={styles.root} testID="auth-otp">
            {onBack ? (
                <Pressable
                    onPress={onBack}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.back')}
                    style={styles.back}
                    testID="auth-otp-back"
                >
                    <MaterialIcons name="arrow-back" size={24} color={colors.ink} />
                </Pressable>
            ) : null}
            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                {title ?? t('auth.track.checkEmailTitle')}
            </Text>
            <Text style={[styles.body, { color: colors.ink2 }]}>
                {t('auth.track.sentTo', { email: maskEmail(email) })}
            </Text>

            <View style={styles.boxes}>
                <OtpBoxes
                    value={otp}
                    state={state}
                    autoFocus
                    editable={state !== 'right'}
                    a11yLabel={t('auth.track.codeA11y')}
                    onChange={(v) => {
                        setOtp(v);
                        if (state === 'wrong') {
                            setState('idle');
                            setErrorMessage('');
                        }
                    }}
                    onComplete={(code) => void verify(code)}
                    testID="auth-otp-boxes"
                />
            </View>

            {errorMessage ? (
                <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.negative }]}>
                    {errorMessage}
                </Text>
            ) : null}

            <View style={styles.links}>
                {resendCooldown > 0 ? (
                    <Text style={[styles.muted, { color: colors.ink3 }]}>
                        {t('auth.resendIn', { seconds: resendCooldown })}
                    </Text>
                ) : (
                    <Pressable onPress={() => void resend()} disabled={resending} hitSlop={12} accessibilityRole="button">
                        <Text style={[styles.link, { color: colors.accentText }]}>{t('auth.resendCode')}</Text>
                    </Pressable>
                )}
                {onUseDifferentEmail ? (
                    <Pressable onPress={onUseDifferentEmail} hitSlop={12} accessibilityRole="button">
                        <Text style={[styles.link, { color: colors.accentText }]}>{t('auth.track.useDifferentEmail')}</Text>
                    </Pressable>
                ) : null}
            </View>

            {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: 20, paddingTop: 8 },
    back: { width: 44, height: 44, justifyContent: 'center', marginBottom: 8 },
    title: { fontSize: 26, fontWeight: '700' },
    body: { fontSize: 15, lineHeight: 21, marginTop: 8 },
    boxes: { marginTop: 24 },
    error: { fontSize: 14, lineHeight: 20, marginTop: 14 },
    links: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
    muted: { fontSize: 14 },
    link: { fontSize: 14, fontWeight: '600' },
    footer: { marginTop: 28, gap: 12 },
});

export default OTPVerificationView;
