import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import LanguageSelector from '@/components/custom/auth/LanguageSelector';
import LegalFooter from '@/components/custom/auth/LegalFooter';
import TutorialLaunchButton from '@/components/custom/tutorials/TutorialLaunchButton';
import OTPVerificationView from '@/components/custom/auth/OTPVerificationView';
import PreviousUserView from '@/components/custom/auth/PreviousUserView';
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
import { PRIVACY_URL, TERMS_URL } from '@/lib/config/branding';
import {
    deviceSignInAvailability,
    signInWithDevice,
    type DeviceSignInFailureReason,
    type DeviceSignInResult,
} from '@/lib/device-auth';

/** The success variant — what the consent step hands its caller so the
 *  welcome-back verdict can steer routing. */
type DeviceSignInSuccess = Extract<DeviceSignInResult, { status: 'success' }>;
import { hapticLight } from '@/lib/haptics';
import { useSupportAction } from '@/lib/intercom';
import logger from '@/lib/logger';
import { clearIdentityFault, recordAuthenticatedUser } from '@/lib/security/identity-gate';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useUserStore } from '@/lib/stores/user-store';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import validator from 'validator';
import {
    acceptLegal,
    fetchLegalVersions,
    markLegalAcceptedThisProcess,
    silentlyAcceptLegal,
} from './legal-consent';

interface PreAuthFooterProps {
    /** The email view keeps the tour pill; views that surface the tutorials
     *  elsewhere (none currently — the welcome view has its own footer) may
     *  hide it. */
    showTutorialLaunch?: boolean;
}

/**
 * The pre-flight cluster for the EMAIL view: language selector, tutorial
 * entry, and the legal footer. The welcome view no longer shares this —
 * language is chosen on its own first-launch stage and the welcome view
 * renders LegalFooter directly — so this cluster now serves the users who
 * were routed straight to email (device sign-in unavailable) and never saw
 * the language stage.
 */
const PreAuthFooter: React.FC<PreAuthFooterProps> = ({ showTutorialLaunch = true }) => {
    return (
        <>
            {/* Language cluster. The word ticker, the selector and the tour
                pill are ONE group and must read as one: 8pt between them, 24pt
                to the legal footer below. Grouping is by proximity alone — no
                card, no border — because this screen's only chrome is the
                gradient backdrop, and a container here would compete with it.
                Anchored at the bottom rather than floating in the middle: it
                is a pre-flight setting, not the reason anyone opened this
                screen. */}
            <VStack space="sm" className="mb-6">
                <LanguageSelector />

                {/* The tour. Sits WITH the language cluster rather than above
                    the legal footer because it belongs to the same pre-flight
                    group: things you may want before signing in. It opens a
                    full-screen Modal (not a route — this screen is outside the
                    logged-in stack) and closes back to exactly this view. */}
                {showTutorialLaunch && <TutorialLaunchButton />}
            </VStack>

            <LegalFooter />
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
        // language cluster sitting on the legal footer. The two <Box>es with
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

interface LanguageStageViewProps {
    /** The chosen (or confirmed default) language is persisted; move on. */
    onContinue: () => void;
}

/**
 * The true first-launch stage: nothing but the logo and the language choice.
 * The device locale arrives preselected (app-language-store hydrates it in
 * memory), so most people confirm with one tap on Continue; anyone else picks
 * from the selector first. Continue persists the choice to the `app_language`
 * settings ROW — whose absence is the "never explicitly picked" signal the
 * mount effect keys on — so this stage shows exactly once per install.
 */
const LanguageStageView: React.FC<LanguageStageViewProps> = ({ onContinue }) => {
    const { t } = useTranslation();
    const [saving, setSaving] = useState(false);

    const handleContinue = async () => {
        if (saving) return;
        setSaving(true);
        void hapticLight();
        try {
            // Idempotent when a picker choice already wrote the row; for the
            // one-tap confirm this is the write that makes the default stick.
            await useAppLanguageStore
                .getState()
                .setAppLanguage(useAppLanguageStore.getState().appLanguage);
        } catch {
            // The store logs its own failures. A missed persist only means
            // this stage shows once more next launch — never strand the user.
        }
        onContinue();
    };

    return (
        // Same three-band skeleton as the sibling views (see EmailInputView's
        // layout note), same F2 accessibility scoping: wrappers are
        // accessible={false}, only the pressables carry labels.
        <Box testID="auth-language-root" accessible={false} className="flex-1 px-5">
            {/* Upper band — the logo owns it and is centred in it. */}
            <Box accessible={false} className="items-center justify-center" style={{ flex: 5 }}>
                <MeraLogo size={150} animated />
            </Box>

            <VStack testID="auth-language-cluster" accessible={false} space="md">
                <VStack accessible={false} space="xs">
                    {/* Same greeting key the consent step uses — one string,
                        one translation, and the two stages read as one flow. */}
                    <Text size="2xl" className="text-white font-semibold text-center">
                        {t('consent.welcomeTitle')}
                    </Text>
                    <Text size="lg" className="text-gray-300 text-center">
                        {t('auth.chooseLanguageTitle')}
                    </Text>
                    <Text size="xs" className="text-gray-500 text-center">
                        {t('auth.chooseLanguageHint')}
                    </Text>
                </VStack>

                <LanguageSelector />

                <Pressable
                    testID="auth-language-continue"
                    onPress={handleContinue}
                    disabled={saving}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={t('auth.continue')}
                    accessibilityState={saving ? { busy: true, disabled: true } : undefined}
                    className={`h-14 rounded-full items-center justify-center ${saving ? 'bg-gray-700' : 'bg-primary-500'}`}
                >
                    {saving ? (
                        <Spinner size="small" color="white" />
                    ) : (
                        <Text className="text-black text-base font-semibold">
                            {t('auth.continue')}
                        </Text>
                    )}
                </Pressable>
            </VStack>

            {/* Lower band — keeps the cluster off the home indicator. */}
            <Box style={{ flex: 1 }} />
        </Box>
    );
};

interface WelcomeViewProps {
    /** Switch to the email view — the existing-user path. */
    onUseEmail: () => void;
    /** Advance to the consent step; sign-in itself runs there. */
    onGetStarted: () => void;
}

/**
 * The guided welcome for new users: three actions, each introduced by one
 * short hint line so a first-time reader knows which button is theirs
 * without reading anything else. Sign-in machinery lives on the consent
 * step now — "Get started" only advances the stage.
 */
const WelcomeView: React.FC<WelcomeViewProps> = ({ onUseEmail, onGetStarted }) => {
    const { t } = useTranslation();

    return (
        // ── ACCESSIBILITY SCOPING (F2) ──────────────────────────────────────
        // The band wrappers are layout only, and they are explicitly
        // `accessible={false}`: left implicit, the full-screen containers were
        // surfaced to VoiceOver/XCUITest as phantom "Get started" elements
        // claiming the whole screen (label aggregation from the one labelled
        // descendant). Accessibility lives ONLY on the pressables, each with
        // its own role and label.
        //
        // The hint lines grew this stack past the email view's input line, so
        // the old CTA-to-input register between the two views is deliberately
        // gone (S13); the 5:1 band ratio itself still holds the cluster in
        // the lower half on any screen height.
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

            <VStack testID="auth-welcome-actions" accessible={false} space="lg">
                {/* First-timers first: learning what Mera is comes before
                    committing to it. Outline, same geometry as the CTA — a
                    sibling action, not the primary. Opens the tutorials MENU
                    (top-level /tutorials, deliberately outside the session
                    gate) so the reader picks any chapter, not just the first. */}
                <VStack accessible={false} space="sm">
                    <Text size="sm" className="text-gray-400 text-center">
                        {t('auth.firstTimeHint')}
                    </Text>
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
                </VStack>

                <VStack accessible={false} space="sm">
                    <Text size="sm" className="text-gray-400 text-center">
                        {t('auth.readyHint')}
                    </Text>
                    <Pressable
                        testID="auth-get-started"
                        onPress={() => {
                            void hapticLight();
                            onGetStarted();
                        }}
                        accessible
                        accessibilityRole="button"
                        accessibilityLabel={t('auth.getStarted')}
                        className="h-14 rounded-full items-center justify-center bg-primary-500"
                    >
                        <Text className="text-black text-base font-semibold">
                            {t('auth.getStarted')}
                        </Text>
                    </Pressable>
                </VStack>

                {/* The existing-user path, framed for the people it is really
                    for since the auth wave: paid users signed in with the email
                    they verified at checkout. Outline like Learn about Mera —
                    the filled CTA between them stays the only primary. */}
                <VStack accessible={false} space="sm">
                    <Text size="xs" className="text-gray-500 text-center">
                        {t('auth.paidUserHint')}
                    </Text>
                    <Pressable
                        testID="auth-use-email"
                        onPress={onUseEmail}
                        accessible
                        accessibilityRole="button"
                        accessibilityLabel={t('auth.signIn')}
                        className="h-14 rounded-full items-center justify-center border border-primary-500 bg-transparent"
                    >
                        <Text className="text-primary-500 text-base font-semibold">
                            {t('auth.signIn')}
                        </Text>
                    </Pressable>
                </VStack>
            </VStack>

            {/* Lower band — the gap between the actions and the footer. */}
            <Box style={{ flex: 1 }} />

            <LegalFooter />
        </Box>
    );
};

interface ConsentStepViewProps {
    /** Switch to the email view — the fallback every failure state offers. */
    onUseEmail: () => void;
    /** Device sign-in completed and the identity bookkeeping is done. The full
     *  success result travels so the caller can route on `welcomeBack`. */
    onSuccess: (result: DeviceSignInSuccess) => void;
}

/**
 * Step 2 after "Get started": the one-decision consent page (WhatsApp's
 * welcome-consent shape — a sentence, the two links, one button). "Agree and
 * continue" runs the whole device sign-in; acceptance is POSTed right after
 * the session exists, because /accept-legal is an authenticated route. If the
 * versions fetch or the POST fails we proceed anyway — ConsentGate is the
 * fail-open safety net and will simply ask again.
 *
 * Email sign-ins NEVER pass through here: they accepted at their original
 * sign-up and are stamped silently (silentlyAcceptLegal).
 */
const ConsentStepView: React.FC<ConsentStepViewProps> = ({ onUseEmail, onSuccess }) => {
    const { t } = useTranslation();
    const [working, setWorking] = useState(false);
    const [failure, setFailure] = useState<DeviceSignInFailureReason | null>(null);
    // "Contact support" may silently open Mail instead of the Messenger
    // (useSupportAction's contract) — the label says "Message support", which
    // reads true either way.
    const { busy: supportBusy, openSupport } = useSupportAction();

    const handleAgree = async () => {
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
            // Stamp the acceptance the user just gave. Fetched HERE, not
            // prefetched at mount: appConfig requires a SESSION ("pre-paywall"
            // in its schema doc means before entitlement, not before auth —
            // the pre-auth fetch 401s, e2e-proven on staging), and a silently
            // failed prefetch dropped the stamp AND the latch, so ConsentGate
            // re-prompted right after the user had just agreed. Latch only on
            // a landed stamp: a failed one should let ConsentGate re-ask.
            const versions = await fetchLegalVersions();
            if (versions) {
                const stamped = await acceptLegal(versions);
                if (stamped.ok) markLegalAcceptedThisProcess(result.userId);
            }
            onSuccess(result);
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
        // Same three-band skeleton and F2 scoping as the sibling views.
        <Box testID="auth-consent-root" accessible={false} className="flex-1 px-5">
            {/* Upper band — smaller logo: this page is about the sentence,
                not the mark. */}
            <Box accessible={false} className="items-center justify-center" style={{ flex: 5 }}>
                <MeraLogo size={120} animated />
            </Box>

            <VStack testID="auth-consent-cluster" accessible={false} space="md">
                <VStack accessible={false} space="sm">
                    <Text size="2xl" className="text-white font-semibold text-center">
                        {t('consent.welcomeTitle')}
                    </Text>
                    <Text size="md" className="text-gray-300 text-center">
                        {t('consent.welcomeBody')}
                    </Text>
                </VStack>

                {/* Two outline buttons, half and half — the same primary
                    outline the welcome view's secondary actions wear, so the
                    legal links read as real destinations rather than fine
                    print. `py-3` instead of a fixed height: several locales
                    run long here and must wrap without clipping. Real padding,
                    no hitSlop — overlapping slops resolve by z-order and a tap
                    in the gap would silently open the LATER button. */}
                <HStack accessible={false} space="md" className="items-stretch">
                    <Pressable
                        testID="auth-consent-terms"
                        accessible
                        accessibilityRole="link"
                        accessibilityLabel={t('consent.termsLink')}
                        onPress={() => openInAppBrowser(withAppLanguage(TERMS_URL))}
                        className="flex-1 rounded-full border border-primary-500 bg-transparent items-center justify-center py-3 px-3"
                    >
                        <Text size="sm" className="text-primary-500 font-semibold text-center">
                            {t('consent.termsLink')}
                        </Text>
                    </Pressable>
                    <Pressable
                        testID="auth-consent-privacy"
                        accessible
                        accessibilityRole="link"
                        accessibilityLabel={t('consent.privacyLink')}
                        onPress={() => openInAppBrowser(withAppLanguage(PRIVACY_URL))}
                        className="flex-1 rounded-full border border-primary-500 bg-transparent items-center justify-center py-3 px-3"
                    >
                        <Text size="sm" className="text-primary-500 font-semibold text-center">
                            {t('consent.privacyLink')}
                        </Text>
                    </Pressable>
                </HStack>

                <Pressable
                    testID="auth-consent-agree"
                    onPress={handleAgree}
                    disabled={working}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={working ? t('auth.deviceSignInWorking') : t('consent.accept')}
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
                            {t('consent.accept')}
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
                            onPress={handleAgree}
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
                            accessibilityLabel={t('auth.alreadyHaveAccount')}
                            className="self-center rounded-full border border-primary-500 bg-transparent px-5 py-3"
                        >
                            <Text size="sm" className="text-primary-500 font-semibold text-center">
                                {t('auth.alreadyHaveAccount')}
                            </Text>
                        </Pressable>
                        {/* Compact outline pill sized to its label (support
                            is an outline button everywhere except the
                            settings menu row). py-3 keeps the 44pt target. */}
                        <Pressable
                            testID="auth-device-support"
                            onPress={() => { void openSupport(); }}
                            className="self-center rounded-full border border-primary-500 bg-transparent px-5 py-3"
                            accessible
                            accessibilityRole="button"
                            accessibilityLabel={t('account.contactSupport')}
                            accessibilityState={supportBusy ? { busy: true } : undefined}
                        >
                            {supportBusy ? (
                                <Spinner size="small" color="#6B7280" />
                            ) : (
                                <HStack space="xs" className="items-center">
                                    {/* Material support_agent, matching the
                                        dark-ramp primary literal the language
                                        selector uses for icon tinting. */}
                                    <MaterialIcons name="support-agent" size={18} color="rgb(237, 167, 126)" />
                                    <Text size="sm" className="text-primary-500 font-semibold">
                                        {t('account.contactSupport')}
                                    </Text>
                                </HStack>
                            )}
                        </Pressable>
                    </VStack>
                )}
            </VStack>

            {/* Lower band — the gap between the action and the footer. */}
            <Box style={{ flex: 1 }} />

            <LegalFooter />
        </Box>
    );
};

interface AuthScreenProps {
    onLoginSuccess?: (userId: string) => void;
}

type ViewMode = 'loading' | 'previous' | 'language' | 'welcome' | 'consent' | 'email' | 'otp';

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
    // Fresh devices land on the LANGUAGE stage the very first time (no
    // `app_language` settings row yet — the row is only ever written by an
    // explicit choice, so its absence means "never picked"), then on the
    // WELCOME view every time after, when attestation — or the staging dev
    // bypass — is available. Unsupported devices fall straight through to the
    // email view so they never see a dead CTA. Email stays mounted forever as
    // the path for existing users.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [email, userId, appLanguageRow, availability] = await Promise.all([
                    getSetting('cached_user_email'),
                    getSetting('cached_user_id'),
                    getSetting('app_language'),
                    deviceSignInAvailability(),
                ]);
                if (cancelled) return;
                if (email && userId) {
                    setCachedEmail(email);
                    setCachedUserId(userId);
                    setCurrentView('previous');
                } else if (availability !== 'unavailable') {
                    setCurrentView(appLanguageRow ? 'welcome' : 'language');
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
        // Email users accepted the terms at their original sign-up, so the
        // consent page never prompts them — stamp the current versions
        // silently instead (fire-and-forget; fail-open by contract).
        void silentlyAcceptLegal(userId);
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

    const handleLanguageChosen = () => {
        setCurrentView('welcome');
    };

    const handleGetStarted = () => {
        setCurrentView('consent');
    };

    // Device sign-in completed. Reauth mode gets the same callback the OTP
    // path uses; the normal path navigates itself — better-auth's session atom
    // is not guaranteed to settle promptly after a custom $fetch route, so
    // waiting on login.tsx's session Redirect could strand a signed-in user on
    // this screen. Either way the identity gates key on the recorded
    // pendingAuthUserId, not on the atom.
    //
    // S10: a fresh-looking install whose trial is consumed routes to the
    // dedicated welcome-back screen INSTEAD of /logged-in — the only trigger
    // that screen has, which is what keeps it out of mid-session flows.
    // (Reauth mode cannot produce welcomeBack: stored credentials existed.)
    const handleDeviceSignInSuccess = (result: DeviceSignInSuccess) => {
        if (onLoginSuccess) {
            onLoginSuccess(result.userId);
            return;
        }
        if (result.welcomeBack) {
            // Cast: not in the generated typed-route map until the next expo
            // typegen run — same precedent as pin-lock in app/index.tsx.
            router.replace('/welcome-back' as never);
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

    if (currentView === 'language') {
        return (
            // No opaque fill: the AbstractGradientBackdrop below is the page background.
            <Box testID="auth-language-screen" accessible={false} className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <LanguageStageView onContinue={handleLanguageChosen} />
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

                <WelcomeView onUseEmail={handleUseEmail} onGetStarted={handleGetStarted} />
            </Box>
        );
    }

    if (currentView === 'consent') {
        return (
            // No opaque fill: the AbstractGradientBackdrop below is the page background.
            <Box testID="auth-consent-screen" accessible={false} className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <ConsentStepView onUseEmail={handleUseEmail} onSuccess={handleDeviceSignInSuccess} />
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
