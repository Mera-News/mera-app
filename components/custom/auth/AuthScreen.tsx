import MeraLogo from '@/components/custom/MeraLogo';
import LanguageSelector from '@/components/custom/auth/LanguageSelector';
import OTPVerificationView from '@/components/custom/auth/OTPVerificationView';
import PreviousUserView from '@/components/custom/auth/PreviousUserView';
import PolicyPill from '@/components/custom/PolicyPill';
import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
import { getSetting } from '@/lib/database/services/setting-service';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { sendOTP } from '@/lib/auth-client';
import { CONTENT_POLICY_URL, GITHUB_URL, PRIVACY_URL, TERMS_URL, TRANSLATION_GUIDE_URL, WEBSITE_URL } from '@/lib/config/branding';
import logger from '@/lib/logger';
import { getAppVersionLabel } from '@/lib/version';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { FontAwesome, MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import validator from 'validator';

interface EmailInputViewProps {
    onOTPSent: (email: string) => void;
    initialEmail?: string;
}

const EmailInputView: React.FC<EmailInputViewProps> = ({ onOTPSent, initialEmail }) => {
    const [email, setEmail] = useState(initialEmail ?? '');
    const [loading, setLoading] = useState(false);
    const [showGuideVideo, setShowGuideVideo] = useState(false);
    const toast = useToast();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();

    const handlePrivacyPolicyPress = async () => {
        await openInAppBrowser(PRIVACY_URL);
    };

    const handleTermsOfServicePress = async () => {
        await openInAppBrowser(TERMS_URL);
    };

    const handleContentPolicyPress = async () => {
        await openInAppBrowser(CONTENT_POLICY_URL);
    };

    const handleGithubPress = async () => {
        await openInAppBrowser(GITHUB_URL);
    };

    const handleWebsitePress = async () => {
        await openInAppBrowser(WEBSITE_URL);
    };

    const handleSendOTP = async () => {
        if (!email || !validator.isEmail(email)) {
            toast.show({
                placement: 'top',
                render: ({ id }) => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('auth.invalidEmailTitle')}</ToastTitle>
                        <ToastDescription>{t('auth.invalidEmailDescription')}</ToastDescription>
                    </Toast>
                ),
            });
            return;
        }

        setLoading(true);
        try {
            const result = await sendOTP(email);

            if (result.success) {
                toast.show({
                    placement: 'top',
                    render: ({ id }) => (
                        <Toast action="success" variant="solid">
                            <ToastTitle>{t('auth.codeSentTitle')}</ToastTitle>
                            <ToastDescription>{t('auth.codeSentDescription')}</ToastDescription>
                        </Toast>
                    ),
                });
                onOTPSent(email);
            } else {
                toast.show({
                    placement: 'top',
                    render: ({ id }) => (
                        <Toast action="error" variant="solid">
                            <ToastTitle>{t('auth.failedToSendTitle')}</ToastTitle>
                            <ToastDescription>{result.error || t('common.tryAgain')}</ToastDescription>
                        </Toast>
                    ),
                });
            }
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'AuthScreen', method: 'handleSendOTP' },
            });
            toast.show({
                placement: 'top',
                render: ({ id }) => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('common.error')}</ToastTitle>
                        <ToastDescription>{t('auth.networkError')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <Box className="flex-1 px-5 bg-background-0">
            {/* Main content centered */}
            <Box className="flex-1 justify-center">
                {/* Logo */}
                <Box className="items-center mb-8">
                    <MeraLogo size={150} />
                </Box>

                <Box className="mb-8">
                    <HStack className="items-center" space="md">
                        <Box className="flex-1">
                            <Input size="lg">
                                <InputField
                                    placeholder={t('auth.emailPlaceholder')}
                                    value={email}
                                    onChangeText={setEmail}
                                    keyboardType="email-address"
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            </Input>
                        </Box>
                        <Pressable
                            onPress={handleSendOTP}
                            disabled={loading || !email || !validator.isEmail(email)}
                            className={`w-14 h-14 rounded-full items-center justify-center ${email && validator.isEmail(email) && !loading ? 'bg-primary-500' : 'bg-gray-700'
                                }`}
                        >
                            {loading ? (
                                <Spinner size="small" color="white" />
                            ) : (
                                <MaterialIcons
                                    name="arrow-forward"
                                    size={28}
                                    color="#000000"
                                />
                            )}
                        </Pressable>
                    </HStack>
                </Box>

                {/* Language Selector */}
                <LanguageSelector />

                {Platform.OS === 'ios' && (
                    <VStack space="sm" className="mt-4">
                        <Pressable
                            onPress={() => setShowGuideVideo(true)}
                            className="flex-row items-center py-3 px-4 bg-gray-800 rounded-lg border border-gray-700"
                        >
                            <MaterialIcons name="play-circle-filled" size={20} color="#a78bfa" style={{ marginRight: 8 }} />
                            <Text className="text-violet-400 text-sm font-medium flex-1">
                                {t('language.watchGuide')}
                            </Text>
                        </Pressable>
                    </VStack>
                )}
            </Box>

            {/* Policy buttons at bottom */}
            <Box className="items-center" style={{ paddingBottom: insets.bottom + 32 }}>
                <HStack space="sm" className="items-center justify-center flex-wrap">
                    <PolicyPill label={t('auth.privacyPolicy')} onPress={handlePrivacyPolicyPress} />
                    <PolicyPill label={t('auth.termsOfService')} onPress={handleTermsOfServicePress} />
                    <PolicyPill label={t('auth.contentPolicy')} onPress={handleContentPolicyPress} />
                </HStack>
                <HStack space="lg" className="items-center mt-3">
                    <Pressable onPress={handleGithubPress} hitSlop={8}>
                        <FontAwesome name="github" size={20} color="#9ca3af" />
                    </Pressable>
                    <Pressable onPress={handleWebsitePress} hitSlop={8}>
                        <MaterialIcons name="language" size={22} color="#9ca3af" />
                    </Pressable>
                </HStack>
                <Text size="xs" className="text-gray-500 mt-1">
                    {getAppVersionLabel()}
                </Text>
                <Text size="xs" className="text-gray-500 mt-1">
                    © {new Date().getFullYear()} Mera Labs B.V.
                </Text>
            </Box>

            <VideoPlayerModal
                visible={showGuideVideo}
                uri={TRANSLATION_GUIDE_URL}
                onClose={() => setShowGuideVideo(false)}
            />
        </Box>
    );
};

interface AuthScreenProps {
    onLoginSuccess?: () => void;
}

type ViewMode = 'loading' | 'previous' | 'email' | 'otp';

const AuthScreen: React.FC<AuthScreenProps> = ({ onLoginSuccess }) => {
    const [currentView, setCurrentView] = useState<ViewMode>('loading');
    const [pendingEmail, setPendingEmail] = useState<string>('');
    const [cachedEmail, setCachedEmail] = useState<string | null>(null);
    const [cachedUserId, setCachedUserId] = useState<string | null>(null);

    // On mount, check whether a previous user is remembered on this device.
    // We only need both the email and the user id present — they're written
    // at OTP-verify and post-auth-routing respectively, and both are cleared
    // on logout / "Login with other user".
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [email, userId] = await Promise.all([
                    getSetting('cached_user_email'),
                    getSetting('cached_user_id'),
                ]);
                if (cancelled) return;
                if (email && userId) {
                    setCachedEmail(email);
                    setCachedUserId(userId);
                    setCurrentView('previous');
                } else {
                    setCurrentView('email');
                }
            } catch {
                if (!cancelled) setCurrentView('email');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const handleOTPSent = (email: string) => {
        setPendingEmail(email);
        setCurrentView('otp');
    };

    const handleVerificationSuccess = () => {
        setPendingEmail('');
        onLoginSuccess?.();
    };

    const handleBackToEmail = () => {
        setCurrentView('email');
    };

    const handleUseDifferentUser = () => {
        setCachedEmail(null);
        setCachedUserId(null);
        setCurrentView('email');
    };

    if (currentView === 'loading') {
        return (
            <Box className="flex-1 bg-background-0 justify-center items-center">
                <Spinner size="large" />
            </Box>
        );
    }

    if (currentView === 'previous' && cachedEmail && cachedUserId) {
        return (
            <Box className="flex-1 bg-background-0">
                <PreviousUserView
                    email={cachedEmail}
                    userId={cachedUserId}
                    onUseDifferentUser={handleUseDifferentUser}
                    onOTPSent={handleOTPSent}
                />
            </Box>
        );
    }

    if (currentView === 'otp' && pendingEmail) {
        return (
            <Box className="flex-1 bg-background-0">
                <OTPVerificationView
                    email={pendingEmail}
                    onVerificationSuccess={handleVerificationSuccess}
                    onBack={handleBackToEmail}
                />
            </Box>
        );
    }

    return (
        <Box className="flex-1 bg-background-0">
            <EmailInputView onOTPSent={handleOTPSent} initialEmail={pendingEmail} />
        </Box>
    );
};

export default AuthScreen;
