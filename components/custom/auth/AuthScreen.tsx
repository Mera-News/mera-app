import MeraLogo from '@/components/custom/MeraLogo';
import LanguageSelector from '@/components/custom/auth/LanguageSelector';
import OTPVerificationView from '@/components/custom/auth/OTPVerificationView';
import PreviousUserView from '@/components/custom/auth/PreviousUserView';
import PolicyPill from '@/components/custom/PolicyPill';
import ThemeSelector from '@/components/custom/ThemeSelector';
import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
import { useThemeColors } from '@/lib/theme/tokens';
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
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
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
    const colors = useThemeColors();

    const handlePrivacyPolicyPress = async () => {
        await openInAppBrowser(withAppLanguage(PRIVACY_URL));
    };

    const handleTermsOfServicePress = async () => {
        await openInAppBrowser(withAppLanguage(TERMS_URL));
    };

    const handleContentPolicyPress = async () => {
        await openInAppBrowser(withAppLanguage(CONTENT_POLICY_URL));
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
                            className={`w-14 h-14 rounded-full items-center justify-center ${email && validator.isEmail(email) && !loading ? 'bg-primary-500' : 'bg-background-200'
                                }`}
                        >
                            {loading ? (
                                <Spinner size="small" color="white" />
                            ) : (
                                <MaterialIcons
                                    name="arrow-forward"
                                    size={28}
                                    color={colors.onPrimary}
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
                            className="flex-row items-center py-3 px-4 bg-background-100 rounded-lg border border-outline-100"
                        >
                            <MaterialIcons name="play-circle-filled" size={20} color={colors.primary} style={{ marginRight: 8 }} />
                            <Text className="text-primary-400 text-sm font-medium flex-1">
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
                        <FontAwesome name="github" size={20} color={colors.iconMuted} />
                    </Pressable>
                    <Pressable onPress={handleWebsitePress} hitSlop={8}>
                        <MaterialIcons name="language" size={22} color={colors.iconMuted} />
                    </Pressable>
                </HStack>
                <Text size="xs" className="text-typography-400 mt-1">
                    {getAppVersionLabel()}
                </Text>
                <Text size="xs" className="text-typography-400 mt-1">
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

// Top-right theme toggle shown on every auth view. Tapping the button expands
// the compact Light/Dark/System pill row inline; the choice persists via the
// theme store (WatermelonDB is available pre-auth).
const ThemeToggleOverlay: React.FC = () => {
    const insets = useSafeAreaInsets();
    const colors = useThemeColors();
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);

    return (
        <Box
            className="absolute right-4 z-10 flex-row items-center"
            style={{ top: insets.top + 8 }}
        >
            {expanded && <ThemeSelector compact />}
            <Pressable
                onPress={() => setExpanded((v) => !v)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('theme.title')}
                className="rounded-full p-2.5 ml-2 bg-background-50 border border-outline-100"
            >
                <MaterialIcons
                    name={expanded ? 'close' : 'brightness-6'}
                    size={20}
                    color={colors.iconMuted}
                />
            </Pressable>
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
                <ThemeToggleOverlay />
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
                <ThemeToggleOverlay />
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
            <ThemeToggleOverlay />
            <EmailInputView onOTPSent={handleOTPSent} initialEmail={pendingEmail} />
        </Box>
    );
};

export default AuthScreen;
