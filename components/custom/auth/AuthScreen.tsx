import { MaterialIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Keyboard, Linking, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Animated, {
    FadeIn,
    FadeOut,
    SlideInLeft,
    SlideInRight,
    SlideOutLeft,
    SlideOutRight,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import validator from 'validator';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ConsentContent from '@/components/custom/auth/ConsentContent';
import { consentNoticeKey, noEmailFaqUrl } from '@/components/custom/auth/device-sign-in-copy';
import OTPVerificationView from '@/components/custom/auth/OTPVerificationView';
import WelcomeStage from '@/components/custom/auth/WelcomeStage';
import MeraLogo from '@/components/custom/MeraLogo';
import SystemCheckStage from '@/components/custom/system-check/SystemCheckStage';
import TutorialModalHost from '@/components/custom/tutorials/TutorialModalHost';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { clearAuthStorage, sendOTP } from '@/lib/auth-client';
import { SUPPORT_EMAIL } from '@/lib/config/branding';
import { getSetting } from '@/lib/database/services/setting-service';
import {
    deviceSignInAvailability,
    deviceSignInPath,
    signInWithDevice,
    type DeviceSignInAvailability,
    type DeviceSignInFailureReason,
    type DeviceSignInPath,
    type DeviceSignInResult,
} from '@/lib/device-auth';
import { showFeedback } from '@/lib/feedback';
import { hapticLight } from '@/lib/haptics';
import { useSupportAction } from '@/lib/intercom';
import logger from '@/lib/logger';
import { EASE, MOTION } from '@/lib/motion';
import {
    clearIdentityFault,
    holdAccountSwitch,
    recordAuthenticatedUser,
    releaseAccountSwitch,
} from '@/lib/security/identity-gate';
import { useUserStore } from '@/lib/stores/user-store';
import { buildSupportMailtoUrl } from '@/lib/support-id';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import { maskEmail } from '@/lib/utils/mask-email';
import { openInAppBrowser } from '@/lib/web-browser-utils';

import { acceptLegal, fetchLegalVersions, markLegalAcceptedThisProcess, silentlyAcceptLegal } from './legal-consent';

/** The success variant: what a device sign-in hands its caller. */
type DeviceSignInSuccess = Extract<DeviceSignInResult, { status: 'success' }>;

/**
 * The bookkeeping a device sign-in owes the account it signed in, before
 * anything navigates. Mirrors OTPVerificationView's post-verify steps, minus
 * the email cache (an anonymous account has no real address). Every step
 * describes the INCOMING account, which is why it runs only once the user
 * meant this account: when the phone opens a different account than the one
 * on this device, it runs only after the user confirms the switch.
 */
async function completeDeviceSignIn(result: DeviceSignInSuccess): Promise<void> {
    recordAuthenticatedUser(result.userId);
    useUserStore.getState().setNeedsReauth(false);
    clearIdentityFault().catch(() => {});
    // Consent is a fact about what the user just did (they tapped Agree, or
    // already had an account): latch FIRST, then the network work. A failed
    // write is ConsentGate's to retry silently, never grounds to re-ask.
    markLegalAcceptedThisProcess(result.userId);
    const versions = await fetchLegalVersions();
    if (versions) await acceptLegal(versions);
}

type PhoneSignIn =
    | { kind: 'signed-in'; result: DeviceSignInSuccess }
    | { kind: 'different'; result: DeviceSignInSuccess }
    | { kind: 'unsupported' }
    | { kind: 'failed'; reason: DeviceSignInFailureReason };

/**
 * ONE sign-in-with-this-phone path, used by Before you start and by the
 * no-email gate's Try again: sign in, compare with the account on this device
 * BEFORE any bookkeeping, and only then complete. A mismatch writes nothing;
 * the caller takes holdAccountSwitch synchronously and asks (the session
 * cookie is already set, and the watcher, the onboarding gate and login.tsx's
 * shortcut would otherwise wipe this device's account unasked).
 */
async function signInWithPhone(expectedUserId: string | null): Promise<PhoneSignIn> {
    // Every attempt re-enters the whole flow, so it always fetches a fresh nonce.
    const result = await signInWithDevice();
    if (result.status === 'success') {
        if (expectedUserId && result.userId !== expectedUserId) return { kind: 'different', result };
        await completeDeviceSignIn(result);
        return { kind: 'signed-in', result };
    }
    if (result.status === 'unsupported') return { kind: 'unsupported' };
    return { kind: 'failed', reason: result.reason };
}

type Stage =
    | 'loading'
    | 'intro'
    | 'welcome'
    | 'checks'
    | 'begin'
    | 'consent'
    | 'email'
    | 'otp'
    | 'reauth-email'
    | 'reauth-otp'
    | 'reauth-no-email';

/** Track position, for the slide direction (forward slides left). */
const TRACK: Partial<Record<Stage, number>> = {
    intro: 0,
    welcome: 0,
    checks: 1,
    begin: 2,
    consent: 3,
    email: 4,
    otp: 5,
    'reauth-email': 0,
    'reauth-no-email': 0,
    'reauth-otp': 1,
};

/** The one logo: where and how big it sits on each stage (FinalJourney "One logo"). */
const LOGO_FULL = 150;
const LOGO_TOP = 56;
const LOGO: Partial<Record<Stage, 'center' | 'top'>> = {
    intro: 'center',
    welcome: 'top',
    checks: 'top',
    begin: 'top',
    consent: 'top',
};

/** The welcome line holds alone, then the list rises (Journey #3, #4). */
const INTRO_MS = 1200;

interface AuthScreenProps {
    onLoginSuccess?: (userId: string) => void;
    /**
     * Whether device sign-in ("Sign in without email") may be offered. login.tsx
     * passes false on Forgot PIN (`reauth=pin`): device sign-in proves only that
     * someone holds the phone, which is exactly who the PIN guards against.
     */
    allowDeviceSignIn?: boolean;
}

/**
 * The first-launch track and the sign-in gate (FinalJourney, FinalStart #8 to
 * #11): ONE backdrop and ONE logo hoisted above the stage switch, so no step is
 * a hard cut. A device with no remembered account walks the track (welcome
 * with the language list, checks, how to begin, before you start, email and
 * code). A device whose account needs signing in again lands on the gate:
 * reauth-email (a code to the account's own masked address) or reauth-no-email
 * (the phone check again). Neither ever switches accounts on its own: moving to
 * the phone's account always asks first.
 */
const AuthScreen: React.FC<AuthScreenProps> = ({ onLoginSuccess, allowDeviceSignIn = true }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    const reduceMotion = useReducedMotion();

    const [stage, setStage] = useState<Stage>('loading');
    const [forward, setForward] = useState(true);
    const [pendingEmail, setPendingEmail] = useState('');
    const [cachedEmail, setCachedEmail] = useState<string | null>(null);
    const [cachedUserId, setCachedUserId] = useState<string | null>(null);
    const [supportId, setSupportId] = useState<string | null>(null);
    const [availability, setAvailability] = useState<DeviceSignInAvailability>('unavailable');
    const [signInPath, setSignInPath] = useState<DeviceSignInPath>('unavailable');
    // Where Before you start was entered from: the track's begin, or the gate.
    const [consentFrom, setConsentFrom] = useState<Stage>('begin');
    // The track's Before you start: 'device' signs in on Agree; 'email' only
    // records the agreement and moves on to the address (Q3).
    const [consentFor, setConsentFor] = useState<'device' | 'email'>('device');
    const [pendingSwitch, setPendingSwitch] = useState<DeviceSignInSuccess | null>(null);
    const [tourOpen, setTourOpen] = useState(false);

    const go = useCallback(
        (next: Stage) => {
            setForward((TRACK[next] ?? 0) >= (TRACK[stage] ?? 0));
            setStage(next);
        },
        [stage],
    );

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [email, userId, sid, avail, path] = await Promise.all([
                    getSetting('cached_user_email'),
                    getSetting('cached_user_id'),
                    getSetting('cached_support_id'),
                    deviceSignInAvailability(),
                    deviceSignInPath(),
                ]);
                if (cancelled) return;
                setAvailability(avail);
                setSignInPath(path);
                setCachedUserId(userId ?? null);
                setSupportId(sid ?? null);
                if (email && userId) {
                    setCachedEmail(email);
                    setStage('reauth-email');
                } else if (userId) {
                    setStage('reauth-no-email');
                } else {
                    setStage('intro');
                }
            } catch {
                if (!cancelled) setStage('intro');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (stage !== 'intro') return;
        const id = setTimeout(() => setStage('welcome'), INTRO_MS);
        return () => clearTimeout(id);
    }, [stage]);

    // The gate leaves the app on Android Back (FinalStart #9): there is nothing
    // behind it to go back to.
    useEffect(() => {
        if (!stage.startsWith('reauth')) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (stage === 'reauth-otp') {
                go(cachedEmail ? 'reauth-email' : 'reauth-no-email');
                return true;
            }
            BackHandler.exitApp();
            return true;
        });
        return () => sub.remove();
    }, [stage, go, cachedEmail]);

    // ── The hoisted logo ──────────────────────────────────────────────────
    const logoAt = LOGO[stage];
    const logoScale = useSharedValue(1);
    const logoY = useSharedValue(height * 0.3);
    const logoOpacity = useSharedValue(0);
    useEffect(() => {
        const timing = { duration: reduceMotion ? 0 : 500, easing: EASE.arrive };
        logoOpacity.value = withTiming(logoAt ? 1 : 0, { duration: reduceMotion ? 0 : 250 });
        if (!logoAt) return;
        logoScale.value = withTiming(logoAt === 'center' ? 1 : LOGO_TOP / LOGO_FULL, timing);
        logoY.value = withTiming(logoAt === 'center' ? height * 0.3 : insets.top + 16 - (LOGO_FULL - LOGO_TOP) / 2, timing);
    }, [logoAt, height, insets.top, reduceMotion, logoScale, logoY, logoOpacity]);
    const logoStyle = useAnimatedStyle(() => ({
        opacity: logoOpacity.value,
        transform: [{ translateY: logoY.value }, { scale: logoScale.value }],
    }));
    const bodyTop = insets.top + (logoAt === 'top' ? 16 + LOGO_TOP + 16 : 16);

    // ── Handlers ──────────────────────────────────────────────────────────
    const canSignInWithoutEmail = allowDeviceSignIn && availability !== 'unavailable';

    const finishDeviceSignIn = (result: DeviceSignInSuccess) => {
        if (onLoginSuccess) {
            onLoginSuccess(result.userId);
            return;
        }
        // better-auth's atom may settle late after a custom $fetch route, so
        // navigate rather than wait on login.tsx's session Redirect.
        router.replace('/logged-in');
    };

    const askSwitch = (result: DeviceSignInSuccess) => {
        // Synchronously, before the atom can settle on the phone's account.
        holdAccountSwitch(result.userId);
        setPendingSwitch(result);
    };

    const handleVerificationSuccess = (userId: string) => {
        // The address step came after Before you start, so the agreement is
        // the user's own; stamp it now that a session exists to stamp it with.
        void silentlyAcceptLegal(userId);
        setPendingEmail('');
        onLoginSuccess?.(userId);
    };

    const handleSwitchContinue = async () => {
        if (!pendingSwitch) return;
        releaseAccountSwitch();
        await completeDeviceSignIn(pendingSwitch);
        finishDeviceSignIn(pendingSwitch);
    };

    // Declined: the phone's account signed in but nothing was recorded for
    // it. Sign it out through the one sign-out path and stay where we were.
    const handleSwitchKeep = async () => {
        await clearAuthStorage();
        setPendingSwitch(null);
    };

    // ── Stages ────────────────────────────────────────────────────────────
    let body: React.ReactNode = null;
    switch (stage) {
        case 'intro':
            // The line itself is drawn beside the logo in the root (below).
            body = null;
            break;
        case 'welcome':
            body = (
                <WelcomeStage
                    messageTop={insets.top + 8 - bodyTop}
                    onBegin={() => go('checks')}
                    onLearn={() => setTourOpen(true)}
                />
            );
            break;
        case 'checks':
            body = <SystemCheckStage withLogo={false} onContinue={() => go('begin')} testID="auth-checks" />;
            break;
        case 'begin':
            body = (
                <BeginStage
                    canUsePhone={availability !== 'unavailable'}
                    onWithoutEmail={() => {
                        setConsentFor('device');
                        setConsentFrom('begin');
                        go('consent');
                    }}
                    onWithEmail={() => {
                        setConsentFor('email');
                        setConsentFrom('begin');
                        go('consent');
                    }}
                />
            );
            break;
        case 'consent':
            body = (
                <ConsentStage
                    mode={consentFor}
                    signInPath={signInPath}
                    expectedUserId={cachedUserId}
                    onAgreedForEmail={() => go('email')}
                    onSignedIn={finishDeviceSignIn}
                    onDifferentAccount={(r) => {
                        askSwitch(r);
                        go(consentFrom);
                    }}
                    onUseEmail={() => {
                        setConsentFor('email');
                        go(cachedEmail ? 'reauth-email' : 'email');
                    }}
                    onBack={() => go(consentFrom)}
                />
            );
            break;
        case 'email':
            body = (
                <EmailStage
                    initialEmail={pendingEmail}
                    onBack={() => go('begin')}
                    onSent={(email) => {
                        setPendingEmail(email);
                        go('otp');
                    }}
                />
            );
            break;
        case 'otp':
            body = (
                <OTPVerificationView
                    email={pendingEmail}
                    onVerificationSuccess={handleVerificationSuccess}
                    onBack={() => go('email')}
                    onUseDifferentEmail={() => go('email')}
                />
            );
            break;
        case 'reauth-email':
            body = cachedEmail ? (
                <ReauthEmailStage
                    email={cachedEmail}
                    onSent={() => {
                        setPendingEmail(cachedEmail);
                        go('reauth-otp');
                    }}
                    onWithoutEmail={
                        canSignInWithoutEmail
                            ? () => {
                                  setConsentFor('device');
                                  setConsentFrom('reauth-email');
                                  go('consent');
                              }
                            : undefined
                    }
                />
            ) : null;
            break;
        case 'reauth-otp':
            body = (
                <OTPVerificationView
                    email={pendingEmail}
                    title={t('gate.enterCode')}
                    onVerificationSuccess={(userId) => onLoginSuccess?.(userId)}
                    onBack={() => go('reauth-email')}
                    footer={
                        canSignInWithoutEmail ? (
                            <Button
                                variant="outline"
                                action="secondary"
                                onPress={() => {
                                    setConsentFor('device');
                                    setConsentFrom('reauth-email');
                                    go('consent');
                                }}
                                testID="reauth-otp-without-email"
                            >
                                <ButtonText>{t('auth.signInWithoutEmail')}</ButtonText>
                            </Button>
                        ) : null
                    }
                />
            );
            break;
        case 'reauth-no-email':
            body = (
                <ReauthNoEmailStage
                    supportId={supportId}
                    onTryAgain={async () => {
                        const outcome = await signInWithPhone(cachedUserId);
                        if (outcome.kind === 'signed-in') finishDeviceSignIn(outcome.result);
                        else if (outcome.kind === 'different') askSwitch(outcome.result);
                        else return false;
                        return true;
                    }}
                />
            );
            break;
        default:
            body = null;
    }

    const entering = reduceMotion
        ? FadeIn.duration(200)
        : stage === 'welcome'
          ? FadeIn.duration(500)
          : (forward ? SlideInRight : SlideInLeft).duration(MOTION.stage.duration).easing(EASE.across);
    const exiting = reduceMotion
        ? FadeOut.duration(200)
        : stage === 'welcome'
          ? FadeOut.duration(200)
          : (forward ? SlideOutLeft : SlideOutRight).duration(MOTION.stage.duration).easing(EASE.across);

    return (
        <View style={[styles.root, { backgroundColor: colors.base }]} testID="auth-screen">
            <AbstractGradientBackdrop />
            <Animated.View pointerEvents="none" style={[styles.logo, logoStyle]}>
                <MeraLogo size={LOGO_FULL} animated />
            </Animated.View>

            {/* The welcome line under the held logo (Journey #3). In the root,
                beside the logo, so both measure from the same unpadded box. */}
            {stage === 'intro' ? (
                <Animated.View
                    exiting={FadeOut.duration(200)}
                    style={[styles.introLine, { top: height * 0.3 + LOGO_FULL + 24 }]}
                >
                    <Text accessibilityRole="header" style={[styles.introText, { color: colors.ink }]}>
                        {t('auth.track.welcome')}
                    </Text>
                </Animated.View>
            ) : null}

            <Animated.View
                key={stage}
                entering={stage === 'intro' ? undefined : entering}
                exiting={exiting}
                style={[styles.stage, { paddingTop: bodyTop, paddingBottom: insets.bottom }]}
            >
                {body}
            </Animated.View>

            <TutorialModalHost
                visible={tourOpen}
                onClose={() => setTourOpen(false)}
                finishLabel={t('auth.track.beginMera')}
                onFinish={() => {
                    setTourOpen(false);
                    go('checks');
                }}
            />

            <BottomSheet
                open={pendingSwitch !== null}
                onClose={() => void handleSwitchKeep()}
                testID="auth-different-account"
            >
                <DifferentAccountSheet
                    email={cachedEmail}
                    onKeep={handleSwitchKeep}
                    onContinue={handleSwitchContinue}
                />
            </BottomSheet>
        </View>
    );
};

// ── 4 · How do you want to begin? ────────────────────────────────────────────

function BeginStage({
    canUsePhone,
    onWithoutEmail,
    onWithEmail,
}: {
    canUsePhone: boolean;
    onWithoutEmail: () => void;
    onWithEmail: () => void;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    return (
        <View style={styles.pad} testID="auth-begin">
            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                {t('auth.track.beginTitle')}
            </Text>
            <View style={styles.flex} />
            {canUsePhone ? (
                <View style={styles.gap8}>
                    <Button action="primary" onPress={onWithoutEmail} testID="auth-begin-without-email">
                        <ButtonText>{t('auth.track.beginWithoutEmail')}</ButtonText>
                    </Button>
                    <Text style={[styles.caption, { color: colors.ink3 }]}>{t('auth.track.beginCaption')}</Text>
                </View>
            ) : null}
            <Button
                variant={canUsePhone ? 'outline' : 'solid'}
                action={canUsePhone ? 'secondary' : 'primary'}
                onPress={onWithEmail}
                className="mt-4"
                testID="auth-begin-with-email"
            >
                <ButtonText>{t('auth.track.continueWithEmail')}</ButtonText>
            </Button>
        </View>
    );
}

// ── 5 · Before you start ─────────────────────────────────────────────────────

function ConsentStage({
    mode,
    signInPath,
    expectedUserId,
    onAgreedForEmail,
    onSignedIn,
    onDifferentAccount,
    onUseEmail,
    onBack,
}: {
    mode: 'device' | 'email';
    signInPath: DeviceSignInPath;
    expectedUserId: string | null;
    onAgreedForEmail: () => void;
    onSignedIn: (result: DeviceSignInSuccess) => void;
    onDifferentAccount: (result: DeviceSignInSuccess) => void;
    onUseEmail: () => void;
    onBack: () => void;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const [working, setWorking] = useState(false);
    const [failure, setFailure] = useState<DeviceSignInFailureReason | null>(null);

    const agree = async () => {
        if (working) return;
        if (mode === 'email') {
            onAgreedForEmail();
            return;
        }
        setWorking(true);
        setFailure(null);
        const outcome = await signInWithPhone(expectedUserId);
        if (outcome.kind === 'signed-in') {
            onSignedIn(outcome.result); // leave `working`: this screen is replaced
            return;
        }
        setWorking(false);
        if (outcome.kind === 'different') onDifferentAccount(outcome.result);
        else if (outcome.kind === 'unsupported') onUseEmail();
        else setFailure(outcome.reason);
    };

    const noticeKey = mode === 'device' ? consentNoticeKey(signInPath) : null;
    const failureText =
        failure === 'attestation-denied'
            ? t('auth.deviceSignInDenied')
            : failure === 'attestation-unavailable'
              ? t('auth.deviceSignInUnavailable')
              : t('auth.deviceSignInFailed');

    return (
        <View style={styles.pad} testID="auth-consent">
            <BackArrow onPress={onBack} />
            <View style={styles.flex} />
            <ConsentContent
                testIDPrefix="auth-consent"
                title={t('auth.track.beforeYouStart')}
                body={t('consent.welcomeBody')}
                notice={
                    noticeKey ? (
                        <Text testID="auth-consent-device-notice" style={[styles.text, { color: colors.ink2 }]}>
                            {t(noticeKey)}
                        </Text>
                    ) : undefined
                }
                onWhatMeraKeeps={mode === 'device' ? () => openInAppBrowser(noEmailFaqUrl()) : undefined}
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
                        {/* A new user whose device cannot attest gets an account
                            minted through email here: never account-ownership
                            framing (the key name is historical). */}
                        <Button variant="outline" action="secondary" onPress={onUseEmail} testID="auth-use-email-failure">
                            <ButtonText>{t('auth.alreadyHaveAccount')}</ButtonText>
                        </Button>
                    </View>
                ) : null}
            </ConsentContent>
        </View>
    );
}

// ── Continue with email ──────────────────────────────────────────────────────

function EmailStage({
    initialEmail,
    onBack,
    onSent,
}: {
    initialEmail: string;
    onBack: () => void;
    onSent: (email: string) => void;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const keyboard = useThemeMode();
    const [email, setEmail] = useState(initialEmail);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState('');
    const valid = validator.isEmail(email.trim());

    const send = async () => {
        if (!valid || sending) return;
        setSending(true);
        setError('');
        const address = email.trim();
        try {
            const result = await sendOTP(address);
            if (result.success) onSent(address);
            else setError(result.error || t('common.tryAgain'));
        } catch (err) {
            logger.captureException(err, { tags: { screen: 'AuthScreen', method: 'sendOTP' } });
            setError(t('auth.networkError'));
        } finally {
            setSending(false);
        }
    };

    return (
        <View style={styles.pad} testID="auth-email">
            <BackArrow onPress={onBack} />
            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                {t('auth.track.continueWithEmail')}
            </Text>
            <Text style={[styles.text, { color: colors.ink2, marginTop: 8 }]}>{t('auth.track.emailBody')}</Text>
            <TextInput
                testID="auth-email-input"
                value={email}
                onChangeText={(v) => {
                    setEmail(v);
                    if (error) setError('');
                }}
                placeholder={t('auth.emailPlaceholder')}
                placeholderTextColor={colors.ink3}
                keyboardType="email-address"
                keyboardAppearance={keyboard}
                textContentType="emailAddress"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="send"
                onSubmitEditing={() => void send()}
                style={[styles.field, { color: colors.ink, borderColor: colors.line, backgroundColor: colors.surface }]}
            />
            {error ? <Text style={[styles.text, { color: colors.negative, marginTop: 10 }]}>{error}</Text> : null}
            <Button action="primary" onPress={() => void send()} isDisabled={!valid || sending} className="mt-4" testID="auth-send-otp">
                {sending ? <ButtonSpinner /> : null}
                <ButtonText>{t('auth.track.sendCode')}</ButtonText>
            </Button>
        </View>
    );
}

// ── The gate: an account with an email ──────────────────────────────────────

function ReauthEmailStage({
    email,
    onSent,
    onWithoutEmail,
}: {
    email: string;
    onSent: () => void;
    onWithoutEmail?: () => void;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const [sending, setSending] = useState(false);
    const [error, setError] = useState('');

    const send = async () => {
        if (sending) return;
        setSending(true);
        setError('');
        try {
            const result = await sendOTP(email);
            if (result.success) onSent();
            else setError(result.error || t('common.tryAgain'));
        } catch (err) {
            logger.captureException(err, { tags: { screen: 'AuthScreen', method: 'reauthSendOTP' } });
            setError(t('auth.networkError'));
        } finally {
            setSending(false);
        }
    };

    return (
        <View style={[styles.pad, styles.center]} testID="auth-reauth-email">
            <GateIcon name="lock-outline" />
            <Text accessibilityRole="header" style={[styles.title, styles.centerText, { color: colors.ink }]}>
                {t('gate.reauthTitle')}
            </Text>
            <Text style={[styles.text, styles.centerText, { color: colors.ink2 }]}>{t('gate.reauthBody')}</Text>
            <View style={[styles.pill, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                <MaterialIcons name="account-circle" size={18} color={colors.ink3} />
                <Text style={[styles.pillText, { color: colors.ink }]}>{maskEmail(email)}</Text>
            </View>
            {error ? <Text style={[styles.text, styles.centerText, { color: colors.negative }]}>{error}</Text> : null}
            <View style={styles.flex} />
            <View style={styles.actions}>
                <Button action="primary" onPress={() => void send()} isDisabled={sending} testID="reauth-send-code">
                    {sending ? <ButtonSpinner /> : null}
                    <ButtonText>{t('auth.track.sendCode')}</ButtonText>
                </Button>
                {onWithoutEmail ? (
                    <Button variant="outline" action="secondary" onPress={onWithoutEmail} testID="reauth-without-email">
                        <ButtonText>{t('auth.signInWithoutEmail')}</ButtonText>
                    </Button>
                ) : null}
            </View>
        </View>
    );
}

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

// ── Sign in without email? ──────────────────────────────────────────────────

function DifferentAccountSheet({
    email,
    onKeep,
    onContinue,
}: {
    email: string | null;
    onKeep: () => Promise<void>;
    onContinue: () => Promise<void>;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const [busy, setBusy] = useState(false);
    const run = async (action: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        try {
            await action();
        } finally {
            setBusy(false);
        }
    };
    return (
        <View style={styles.sheet}>
            <Text accessibilityRole="header" style={[styles.sheetTitle, { color: colors.ink }]}>
                {t('auth.differentAccount.title')}
            </Text>
            <Text style={[styles.text, { color: colors.ink2 }]}>
                {email
                    ? t('auth.differentAccount.body', { email: maskEmail(email) })
                    : t('auth.differentAccount.bodyGeneric')}
            </Text>
            <View style={styles.sheetActions}>
                <Button variant="outline" action="secondary" onPress={() => void run(onKeep)} isDisabled={busy} className="flex-1" testID="auth-different-account-back">
                    <ButtonText>{t('auth.differentAccount.useEmail')}</ButtonText>
                </Button>
                <Button action="negative" onPress={() => void run(onContinue)} isDisabled={busy} className="flex-1" testID="auth-different-account-continue">
                    {busy ? <ButtonSpinner /> : null}
                    <ButtonText>{t('auth.differentAccount.continue')}</ButtonText>
                </Button>
            </View>
        </View>
    );
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function BackArrow({ onPress }: { onPress: () => void }) {
    const { t } = useTranslation();
    const colors = useColors();
    return (
        <Pressable
            onPress={() => {
                Keyboard.dismiss();
                onPress();
            }}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
            style={styles.back}
            testID="auth-back"
        >
            <MaterialIcons name="arrow-back" size={24} color={colors.ink} />
        </Pressable>
    );
}

function GateIcon({ name }: { name: React.ComponentProps<typeof MaterialIcons>['name'] }) {
    const colors = useColors();
    return (
        <View style={[styles.gateIcon, { backgroundColor: colors.surface, borderColor: colors.line }]}>
            <MaterialIcons name={name} size={28} color={colors.ink2} />
        </View>
    );
}

function IconAction({
    icon,
    label,
    onPress,
    testID,
}: {
    icon: React.ComponentProps<typeof MaterialIcons>['name'];
    label: string;
    onPress: () => void;
    testID: string;
}) {
    const colors = useColors();
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={[styles.iconAction, { borderColor: colors.line }]}
            testID={testID}
        >
            <MaterialIcons name={icon} size={22} color={colors.ink2} />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    logo: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center' },
    stage: { flex: 1 },
    introLine: { position: 'absolute', left: 24, right: 24 },
    introText: { fontSize: 28, fontWeight: '700', textAlign: 'center' },
    pad: { flex: 1, paddingHorizontal: 20, paddingBottom: 16 },
    center: { alignItems: 'center' },
    centerText: { textAlign: 'center' },
    flex: { flex: 1 },
    gap8: { gap: 8 },
    title: { fontSize: 26, fontWeight: '700' },
    text: { fontSize: 15, lineHeight: 21 },
    caption: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
    field: { height: 52, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontSize: 16, marginTop: 20 },
    back: { width: 44, height: 44, justifyContent: 'center', marginBottom: 8 },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 14,
        minHeight: 40,
        marginTop: 16,
    },
    pillText: { fontSize: 14 },
    pillAction: { fontSize: 14, fontWeight: '600' },
    copy: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
    actions: { alignSelf: 'stretch', gap: 12 },
    iconRow: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 4 },
    iconAction: {
        width: 48,
        height: 48,
        borderRadius: 24,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
        justifyContent: 'center',
    },
    gateIcon: {
        width: 64,
        height: 64,
        borderRadius: 32,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 24,
        marginBottom: 16,
    },
    sheet: { paddingHorizontal: 20, paddingTop: 4, gap: 12 },
    sheetTitle: { fontSize: 20, fontWeight: '700' },
    sheetActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
});

export default AuthScreen;
