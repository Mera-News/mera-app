import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { authClient, sendOTP } from '@/lib/auth-client';
import logger from '@/lib/logger';
import { setSetting } from '@/lib/database/services/setting-service';
import { useThemeColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface OTPVerificationViewProps {
    email: string;
    onVerificationSuccess?: () => void;
    onBack?: () => void;
}

const OTPVerificationView: React.FC<OTPVerificationViewProps> = ({ email, onVerificationSuccess, onBack }) => {
    const [otp, setOTP] = useState('');
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [resendLoading, setResendLoading] = useState(false);
    const [resendCooldown, setResendCooldown] = useState(0);
    const [resendMessage, setResendMessage] = useState('');
    const hasSubmittedRef = useRef(false);
    const { t } = useTranslation();
    const colors = useThemeColors();

    useEffect(() => {
        if (resendCooldown <= 0) return;
        const timer = setInterval(() => setResendCooldown((s) => s - 1), 1000);
        return () => clearInterval(timer);
    }, [resendCooldown]);

    const handleResendOTP = async () => {
        if (resendCooldown > 0 || resendLoading) return;
        setResendLoading(true);
        setResendMessage('');
        setErrorMessage('');
        try {
            const result = await sendOTP(email);
            if (result.success) {
                setOTP('');
                hasSubmittedRef.current = false;
                setResendCooldown(30);
                setResendMessage(t('auth.resendSuccess'));
            } else {
                setErrorMessage(result.error || t('common.tryAgain'));
            }
        } catch (error: any) {
            logger.captureException(error, { tags: { feature: 'otp', method: 'resend' } });
            setErrorMessage(error.message || t('common.tryAgain'));
        } finally {
            setResendLoading(false);
        }
    };

    const handleVerifyOTP = async () => {
        setErrorMessage('');

        if (!otp || otp.length < 6) {
            setErrorMessage(t('auth.invalidOtp'));
            return;
        }

        setLoading(true);
        try {
            const { data, error } = await authClient.signIn.emailOtp({
                email,
                otp,
            });
            if (error) {
                setErrorMessage(error.message || t('auth.invalidOtpServer'));
            } else if (data?.user) {
                // Remember the email for the "previous user" view on the login
                // screen if the session is ever cleared / the user lands back
                // on /login (transient connectivity, expired cookie, etc.).
                setSetting('cached_user_email', email).catch(() => {});
                onVerificationSuccess?.();
            } else {
                setErrorMessage(t('auth.invalidOtpServer'));
            }
        } catch (error: any) {
            logger.captureException(error, { tags: { feature: 'otp', method: 'verify' } });
            setErrorMessage(error.message || t('auth.otpError'));
        } finally {
            setLoading(false);
        }
    };

    // Auto-submit when 6 digits are entered
    useEffect(() => {
        if (/^\d{6}$/.test(otp) && !hasSubmittedRef.current) {
            hasSubmittedRef.current = true;
            handleVerifyOTP();
        } else if (otp.length < 6) {
            hasSubmittedRef.current = false;
        }
        // Auto-submit reacts only to otp; handleVerifyOTP is excluded (re-created
        // each render) and the ref guard prevents duplicate submissions.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [otp]);

    return (
        <Box className="flex-1 bg-background-0">
            {/* Back Button */}
            {onBack && (
                <Box className="absolute top-16 left-5 z-10">
                    <Pressable
                        onPress={onBack}
                        className="rounded-full bg-background-50 p-3 shadow-hard-2"
                    >
                        <MaterialIcons name="arrow-back" size={24} color={colors.icon} />
                    </Pressable>
                </Box>
            )}
            {/* Content */}
            <Box className="flex-1 justify-center px-5">
                {/* Logo */}
                <Box className="items-center mb-4">
                    <MeraLogo size={120} />
                </Box>

                <Text size="md" className="text-center mb-2 text-typography-500">
                    {t('auth.sentTo')} <Text size="md" className="font-bold">{email}</Text>
                </Text>

                <Box className="mb-8">
                    <HStack className="items-center" space="md">
                        <Box className="flex-1">
                            <Input size="lg">
                                <InputField
                                    placeholder={t('auth.otpPlaceholder')}
                                    value={otp}
                                    onChangeText={(text) => {
                                        setOTP(text);
                                        setErrorMessage('');
                                    }}
                                    keyboardType="number-pad"
                                    maxLength={6}
                                    autoCapitalize="none"
                                />
                            </Input>
                        </Box>
                        <Pressable
                            onPress={handleVerifyOTP}
                            disabled={loading || otp.length < 6}
                            className={`w-14 h-14 rounded-full items-center justify-center ${otp.length === 6 && !loading ? 'bg-primary-500' : 'bg-background-200'
                                }`}
                        >
                            {loading ? (
                                <Spinner size="small" color="white" />
                            ) : (
                                <MaterialIcons
                                    name="check"
                                    size={28}
                                    color={otp.length === 6 ? '#ffffff' : colors.iconMuted}
                                />
                            )}
                        </Pressable>
                    </HStack>
                    {errorMessage ? (
                        <Text size="sm" className="text-error-500 mt-2">
                            {errorMessage}
                        </Text>
                    ) : null}
                    {resendMessage && !errorMessage ? (
                        <Text size="sm" className="text-success-500 mt-2">
                            {resendMessage}
                        </Text>
                    ) : null}
                    <HStack className="items-center justify-center mt-4" space="xs">
                        {resendLoading ? (
                            <Spinner size="small" color={colors.iconMuted} />
                        ) : resendCooldown > 0 ? (
                            <Text size="sm" className="text-typography-500">
                                {t('auth.resendIn', { seconds: resendCooldown })}
                            </Text>
                        ) : (
                            <Pressable
                                onPress={handleResendOTP}
                                className="border border-primary-400 rounded-lg px-4 py-2"
                            >
                                <Text size="sm" className="text-primary-400">
                                    {t('auth.resendCode')}
                                </Text>
                            </Pressable>
                        )}
                    </HStack>
                </Box>
            </Box>
        </Box>
    );
};

export default OTPVerificationView;

