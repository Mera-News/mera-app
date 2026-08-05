import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import LanguageSelector from '@/components/custom/auth/LanguageSelector';
import OTPVerificationView from '@/components/custom/auth/OTPVerificationView';
import PreviousUserView from '@/components/custom/auth/PreviousUserView';
import PolicyPill from '@/components/custom/PolicyPill';
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
import { CONTENT_POLICY_URL, FAQ_URL, GITHUB_URL, PRIVACY_URL, TERMS_URL, WEBSITE_URL } from '@/lib/config/branding';
import logger from '@/lib/logger';
import { getAppVersionLabel } from '@/lib/version';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { FontAwesome, MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import validator from 'validator';

interface EmailInputViewProps {
    onOTPSent: (email: string) => void;
    initialEmail?: string;
}

const EmailInputView: React.FC<EmailInputViewProps> = ({ onOTPSent, initialEmail }) => {
    const [email, setEmail] = useState(initialEmail ?? '');
    const [loading, setLoading] = useState(false);
    const toast = useToast();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();

    const handlePrivacyPolicyPress = async () => {
        await openInAppBrowser(withAppLanguage(PRIVACY_URL));
    };

    const handleTermsOfServicePress = async () => {
        await openInAppBrowser(withAppLanguage(TERMS_URL));
    };

    const handleContentPolicyPress = async () => {
        await openInAppBrowser(withAppLanguage(CONTENT_POLICY_URL));
    };

    const handleFAQPress = async () => {
        await openInAppBrowser(withAppLanguage(FAQ_URL));
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
        // Three bands, top to bottom: the logo's air, the email row, and the
        // language cluster sitting on the policy footer. The two <Box>es with
        // a raw `flex` split ALL the slack the cluster and footer leave over,
        // 5:1 — that ratio, not a hardcoded offset, is what puts the mark in
        // the upper half and the input near the vertical centre, and it holds
        // on any screen height. Measured on a 874pt screen: logo 114–264,
        // input 383–422 (screen centre 437). On an SE-height 667pt screen the
        // same ratio gives logo ~52–202 and input ~254–310 — the logo keeps
        // its full 150pt (RN flexShrink defaults to 0) and nothing clips.
        // Raw style flex, not `flex-[5]`: no arbitrary flex class exists
        // anywhere else in this app, so it is unproven under NativeWind here.
        <Box className="flex-1 px-5">
            {/* Upper band — the logo owns it and is centred in it. */}
            <Box className="items-center justify-center" style={{ flex: 5 }}>
                <MeraLogo size={150} animated />
            </Box>

            {/* The primary action. Intrinsic height: the bands above and below
                are what position it. */}
            <HStack className="items-center" space="md">
                <Box className="flex-1">
                    <Input size="lg">
                        <InputField
                            testID="auth-email-input"
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
                    testID="auth-send-otp"
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

            {/* Lower band — the gap between the input and the cluster. */}
            <Box style={{ flex: 1 }} />

            {/* Language cluster. The word ticker, the selector, the download
                hint and the guide link are ONE group and must read as one:
                8pt between them, 24pt to the policy row below and the whole
                lower band above. The 24pt matters — the guide link borrows the
                policy pills' shape, so at an equal gap it would read as a
                fifth pill instead of the last line of this group. Grouping is
                by proximity alone — no card, no border — because this screen's
                only chrome is the gradient backdrop, and a container here
                would compete with it.
                Anchored at the bottom rather than floating in the middle: it
                is a pre-flight setting, not the reason anyone opened this
                screen. */}
            <VStack space="sm" className="mb-6">
                <LanguageSelector />

                {/* The "How to add a language" video chip lived here and is
                    gone on purpose. It taught the iOS Required-Downloads sheet
                    to someone who has not opened that sheet and, on this
                    screen, is trying to type an email — the same reason the
                    standing download hint came out of LanguageSelector. The
                    video is still one tap away where it belongs, in Settings →
                    Language (`language.watchGuide`), for someone who went
                    looking for it. */}
            </VStack>

            {/* Policy buttons at bottom */}
            <Box className="items-center" style={{ paddingBottom: insets.bottom + 16 }}>
                <HStack space="xs" className="items-center justify-center flex-wrap">
                    <PolicyPill label={t('auth.privacyPolicy')} onPress={handlePrivacyPolicyPress} />
                    <PolicyPill label={t('auth.termsOfService')} onPress={handleTermsOfServicePress} />
                    <PolicyPill label={t('auth.contentPolicy')} onPress={handleContentPolicyPress} />
                    <PolicyPill label={t('auth.faq')} onPress={handleFAQPress} />
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
        </Box>
    );
};

interface AuthScreenProps {
    onLoginSuccess?: (userId: string) => void;
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

    const handleVerificationSuccess = (userId: string) => {
        setPendingEmail('');
        onLoginSuccess?.(userId);
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
            // No opaque fill: the AbstractGradientBackdrop below is the page background.
            <Box className="flex-1 justify-center items-center">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Spinner size="large" />
            </Box>
        );
    }

    if (currentView === 'previous' && cachedEmail && cachedUserId) {
        return (
            // No opaque fill: the AbstractGradientBackdrop below is the page background.
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

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
            // No opaque fill: the AbstractGradientBackdrop below is the page background.
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <OTPVerificationView
                    email={pendingEmail}
                    onVerificationSuccess={handleVerificationSuccess}
                    onBack={handleBackToEmail}
                />
            </Box>
        );
    }

    return (
        // No opaque fill: the AbstractGradientBackdrop below is the page background.
        <Box className="flex-1">
            {/* Page background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

            <EmailInputView onOTPSent={handleOTPSent} initialEmail={pendingEmail} />
        </Box>
    );
};

export default AuthScreen;
