import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import LanguageSelector from '@/components/custom/auth/LanguageSelector';
import TutorialLaunchButton from '@/components/custom/tutorials/TutorialLaunchButton';
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
import { deviceSignInAvailability, signInWithDevice, type DeviceSignInFailureReason } from '@/lib/device-auth';
import { hapticLight } from '@/lib/haptics';
import { useSupportAction } from '@/lib/intercom';
import logger from '@/lib/logger';
import { clearIdentityFault, recordAuthenticatedUser } from '@/lib/security/identity-gate';
import { useUserStore } from '@/lib/stores/user-store';
import { getAppVersionLabel } from '@/lib/version';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { FontAwesome, MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import validator from 'validator';

interface PreAuthFooterProps {
    /** The welcome view hides the footer tour pill — its tutorial entry moved
     *  up into the button stack as "Learn about Mera" (S8). The email view
     *  keeps the pill. */
    showTutorialLaunch?: boolean;
    /** S8 amendment: the welcome view's "Sign in with email" lives HERE, as a
     *  text link directly above the policy row — demoted from the action
     *  stack, never hidden (it is the recovery path for existing users). */
    onUseEmail?: () => void;
}

/**
 * The pre-flight cluster shared by the welcome and email views: language
 * selector, tutorial entry, policy pills, project links and version. Extracted
 * so the two entry views cannot drift — the layout commentary that used to sit
 * inline in EmailInputView still applies and lives on the call sites.
 */
const PreAuthFooter: React.FC<PreAuthFooterProps> = ({ showTutorialLaunch = true, onUseEmail }) => {
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

    return (
        <>
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

                {/* The tour. Sits WITH the language cluster rather than above the
                    policy pills because it belongs to the same pre-flight group:
                    things you may want before signing in. It opens a full-screen
                    Modal (not a route — this screen is outside the logged-in
                    stack) and closes back to exactly this view. Owns its own
                    visibility state, so this stays a one-line insertion.
                    Hidden on the welcome view — see PreAuthFooterProps. */}
                {showTutorialLaunch && <TutorialLaunchButton />}

                {/* The "How to add a language" video chip lived here and is
                    gone on purpose. It taught the iOS Required-Downloads sheet
                    to someone who has not opened that sheet and, on this
                    screen, is trying to type an email — the same reason the
                    standing download hint came out of LanguageSelector. The
                    video is still one tap away where it belongs, in Settings →
                    Language (`language.watchGuide`), for someone who went
                    looking for it. */}
            </VStack>

            {/* The relocated email path (welcome view only) — directly above
                the policy row, keeping its text-link styling. */}
            {onUseEmail && (
                <Box className="items-center mb-3">
                    <Pressable
                        testID="auth-use-email"
                        onPress={onUseEmail}
                        accessible
                        accessibilityRole="button"
                        accessibilityLabel={t('auth.signInWithEmail')}
                        className="py-1"
                    >
                        <Text size="sm" className="text-primary-400">
                            {t('auth.signInWithEmail')}
                        </Text>
                    </Pressable>
                </Box>
            )}

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
        </>
    );
};

interface EmailInputViewProps {
    onOTPSent: (email: string) => void;
    initialEmail?: string;
}

const EmailInputView: React.FC<EmailInputViewProps> = ({ onOTPSent, initialEmail }) => {
    const [email, setEmail] = useState(initialEmail ?? '');
    const [loading, setLoading] = useState(false);
    const toast = useToast();
    const { t } = useTranslation();

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

            <PreAuthFooter />
        </Box>
    );
};

interface WelcomeViewProps {
    /** Switch to the email view — the secondary path, and the fallback every
     *  failure state offers. */
    onUseEmail: () => void;
    /** Device sign-in completed and the identity bookkeeping is done. */
    onSuccess: (userId: string) => void;
}

/**
 * The device sign-in entry for new users: one "Get started" CTA running the
 * attestation flow (lib/device-auth.ts), with email sign-in as the secondary
 * path. Same three-band layout as EmailInputView — logo air above, action at
 * the input line, pre-flight cluster on the footer — so switching between the
 * two views moves nothing the eye is anchored to.
 */
const WelcomeView: React.FC<WelcomeViewProps> = ({ onUseEmail, onSuccess }) => {
    const { t } = useTranslation();
    const [working, setWorking] = useState(false);
    const [failure, setFailure] = useState<DeviceSignInFailureReason | null>(null);
    // "Contact support" may silently open Mail instead of the Messenger
    // (useSupportAction's contract) — the label says "Message support", which
    // reads true either way.
    const { busy: supportBusy, openSupport } = useSupportAction();

    const handleGetStarted = async () => {
        if (working) return;
        setWorking(true);
        setFailure(null);
        // Every attempt re-enters the WHOLE flow: signInWithDevice fetches a
        // fresh nonce each time, so a retry can never resubmit a consumed one.
        const result = await signInWithDevice();
        if (result.status === 'success') {
            // Mirror OTPVerificationView's post-verify bookkeeping, minus the
            // email cache (an anonymous account has no real address).
            // Recorded BEFORE anything navigates — the identity gates read it
            // while better-auth's session atom is still settling.
            recordAuthenticatedUser(result.userId);
            useUserStore.getState().setNeedsReauth(false);
            // Device sign-in re-proves which account this device holds, same
            // as an OTP verify — the other site that clears the fault.
            clearIdentityFault().catch(() => {});
            onSuccess(result.userId);
            // Leave `working` true: the caller replaces this screen.
            return;
        }
        setWorking(false);
        if (result.status === 'unsupported') {
            // Support vanished mid-flow (should not happen — the mount check
            // routed here because it existed). Email is the honest fallback.
            onUseEmail();
            return;
        }
        setFailure(result.reason);
    };

    const failureText =
        failure === 'attestation-denied'
            ? t('auth.deviceSignInDenied')
            : failure === 'attestation-unavailable'
                ? t('auth.deviceSignInUnavailable')
                : t('auth.deviceSignInFailed');

    return (
        // ── ACCESSIBILITY SCOPING (F2) ──────────────────────────────────────
        // The band wrappers are layout only, and they are explicitly
        // `accessible={false}`: left implicit, the full-screen containers were
        // surfaced to VoiceOver/XCUITest as phantom "Get started" elements
        // claiming the whole screen (label aggregation from the one labelled
        // descendant). Accessibility lives ONLY on the pressables, each with
        // its own role and label.
        <Box testID="auth-welcome-root" accessible={false} className="flex-1 px-5">
            {/* Upper band — the logo owns it and is centred in it. */}
            <Box
                testID="auth-welcome-logo-band"
                accessible={false}
                className="items-center justify-center"
                style={{ flex: 5 }}
            >
                <MeraLogo size={150} animated />
            </Box>

            {/* The primary action, on the same line the email input occupies
                in the sibling view. */}
            <VStack testID="auth-welcome-actions" accessible={false} space="md">
                {/* Above Get started, deliberately: learning what Mera is comes
                    before committing to it. Outline, same geometry as the CTA —
                    a sibling action, not the primary. Opens the tutorials MENU
                    (top-level /tutorials, deliberately outside the session
                    gate) so the reader picks any chapter, not just the first. */}
                <Pressable
                    testID="auth-learn-mera"
                    onPress={() => {
                        void hapticLight();
                        router.push('/tutorials');
                    }}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={t('auth.learnAboutMera')}
                    className="h-14 rounded-full items-center justify-center border border-primary-500 bg-transparent"
                >
                    <Text className="text-primary-500 text-base font-semibold">
                        {t('auth.learnAboutMera')}
                    </Text>
                </Pressable>
                <Pressable
                    testID="auth-get-started"
                    onPress={handleGetStarted}
                    disabled={working}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={working ? t('auth.deviceSignInWorking') : t('auth.getStarted')}
                    accessibilityState={working ? { busy: true, disabled: true } : undefined}
                    className={`h-14 rounded-full items-center justify-center ${working ? 'bg-gray-700' : 'bg-primary-500'}`}
                >
                    {working ? (
                        <HStack space="sm" className="items-center">
                            <Spinner size="small" color="white" />
                            <Text className="text-white text-base font-semibold">
                                {t('auth.deviceSignInWorking')}
                            </Text>
                        </HStack>
                    ) : (
                        <Text className="text-black text-base font-semibold">
                            {t('auth.getStarted')}
                        </Text>
                    )}
                </Pressable>

                {failure !== null && (
                    <VStack space="sm" className="items-center">
                        <Text size="sm" className="text-error-500 text-center" testID="auth-device-failure">
                            {failureText}
                        </Text>
                        <Pressable
                            testID="auth-device-retry"
                            onPress={handleGetStarted}
                            accessible
                            accessibilityRole="button"
                            accessibilityLabel={t('auth.tryAgain')}
                            className="border border-primary-400 rounded-lg px-4 py-2"
                        >
                            <Text size="sm" className="text-primary-400">
                                {t('auth.tryAgain')}
                            </Text>
                        </Pressable>
                        <Pressable
                            testID="auth-use-email-failure"
                            onPress={onUseEmail}
                            accessible
                            accessibilityRole="button"
                            accessibilityLabel={t('auth.signInWithEmail')}
                            className="py-1"
                        >
                            <Text size="sm" className="text-primary-400">
                                {t('auth.signInWithEmail')}
                            </Text>
                        </Pressable>
                        <Pressable
                            testID="auth-device-support"
                            onPress={() => { void openSupport(); }}
                            className="py-1"
                            accessible
                            accessibilityRole="button"
                            accessibilityLabel={t('account.contactSupport')}
                            accessibilityState={supportBusy ? { busy: true } : undefined}
                        >
                            {supportBusy ? (
                                <Spinner size="small" color="#6B7280" />
                            ) : (
                                <Text size="sm" className="text-gray-400">
                                    {t('account.contactSupport')}
                                </Text>
                            )}
                        </Pressable>
                    </VStack>
                )}
            </VStack>

            {/* Lower band — the gap between the action and the cluster. */}
            <Box style={{ flex: 1 }} />

            <PreAuthFooter showTutorialLaunch={false} onUseEmail={onUseEmail} />
        </Box>
    );
};

interface AuthScreenProps {
    onLoginSuccess?: (userId: string) => void;
}

type ViewMode = 'loading' | 'previous' | 'welcome' | 'email' | 'otp';

const AuthScreen: React.FC<AuthScreenProps> = ({ onLoginSuccess }) => {
    const [currentView, setCurrentView] = useState<ViewMode>('loading');
    const [pendingEmail, setPendingEmail] = useState<string>('');
    const [cachedEmail, setCachedEmail] = useState<string | null>(null);
    const [cachedUserId, setCachedUserId] = useState<string | null>(null);

    // On mount, check whether a previous user is remembered on this device.
    // We only need both the email and the user id present — they're written
    // at OTP-verify and post-auth-routing respectively, and both are cleared
    // on logout / "Login with other user".
    //
    // Fresh devices land on the WELCOME view (device sign-in) when attestation
    // — or the staging dev bypass — is available, and fall straight through to
    // the email view otherwise, so an unsupported device never sees a dead
    // CTA. Email stays mounted forever as the path for existing users.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [email, userId, availability] = await Promise.all([
                    getSetting('cached_user_email'),
                    getSetting('cached_user_id'),
                    deviceSignInAvailability(),
                ]);
                if (cancelled) return;
                if (email && userId) {
                    setCachedEmail(email);
                    setCachedUserId(userId);
                    setCurrentView('previous');
                } else if (availability !== 'unavailable') {
                    setCurrentView('welcome');
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

    const handleUseEmail = () => {
        setCurrentView('email');
    };

    // Device sign-in completed. Reauth mode gets the same callback the OTP
    // path uses; the normal path navigates itself — better-auth's session atom
    // is not guaranteed to settle promptly after a custom $fetch route, so
    // waiting on login.tsx's session Redirect could strand a signed-in user on
    // this screen. Either way the identity gates key on the recorded
    // pendingAuthUserId, not on the atom.
    const handleDeviceSignInSuccess = (userId: string) => {
        if (onLoginSuccess) {
            onLoginSuccess(userId);
            return;
        }
        router.replace('/logged-in');
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

    if (currentView === 'welcome') {
        return (
            // No opaque fill: the AbstractGradientBackdrop below is the page background.
            // accessible={false}: plain full-screen container views otherwise
            // answer an AGGREGATED accessibility label (the first labelled
            // descendant, "Get started") and surface as full-screen phantom
            // elements to XCUITest — see the F2 spec in the welcome test.
            <Box testID="auth-welcome-screen" accessible={false} className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <WelcomeView onUseEmail={handleUseEmail} onSuccess={handleDeviceSignInSuccess} />
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
