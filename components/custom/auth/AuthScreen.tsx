import React, { useEffect, useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
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
    withDelay,
    withSequence,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import OTPVerificationView from '@/components/custom/auth/OTPVerificationView';
import WelcomeStage from '@/components/custom/auth/WelcomeStage';
import LaunchLogo from '@/components/custom/auth/LaunchLogo';
import SystemCheckStage from '@/components/custom/system-check/SystemCheckStage';
import TutorialModalHost from '@/components/custom/tutorials/TutorialModalHost';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button, ButtonText } from '@/components/ui/button';
import { EASE, MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';

import { BeginStage } from './stages/BeginStage';
import { ConsentStage } from './stages/ConsentStage';
import { DifferentAccountSheet } from './stages/DifferentAccountSheet';
import { EmailEndedStage } from './stages/EmailEndedStage';
import { EmailStage } from './stages/EmailStage';
import { ReauthEmailStage } from './stages/ReauthEmailStage';
import { ReauthMismatchStage } from './stages/ReauthMismatchStage';
import { ReauthNoEmailStage } from './stages/ReauthNoEmailStage';
import { LOGO_TOP, styles } from './stages/styles';
import { unsupportedExit, useAuthScreen, type AuthScreenProps, type Stage } from './useAuthScreen';

/** The one logo: where and how big it sits on each stage (FinalJourney "One logo"). */
const LOGO_FULL = 150;
/** `slot`: the stage measures where the logo belongs in its own centred stack
 *  (the begin step) and reports it; the logo travels there. */
const LOGO: Partial<Record<Stage, 'center' | 'top' | 'slot'>> = {
    intro: 'center',
    welcome: 'top',
    checks: 'top',
    begin: 'slot',
    consent: 'top',
};

/**
 * The first-launch track and the sign-in gate (FinalJourney, FinalStart #8 to
 * #11): ONE backdrop and ONE logo hoisted above the stage switch, so no step is
 * a hard cut. A device with no remembered account walks the track (welcome
 * with the language list, checks, how to begin, before you start, email and
 * code). A device whose account needs signing in again lands on the gate:
 * reauth-email (a code to the account's own masked address) or reauth-no-email
 * (contact support, or reset this phone back to the track). Neither ever
 * switches accounts on its own: moving to the phone's account always asks first.
 */
const AuthScreen: React.FC<AuthScreenProps> = ({ onLoginSuccess, allowDeviceSignIn = true }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    const reduceMotion = useReducedMotion();

    const {
        stage,
        forward,
        go,
        setConsentFor,
        setConsentFrom,
        setPendingEmail,
        pendingEmail,
        cachedEmail,
        cachedUserId,
        supportId,
        availability,
        signInPath,
        consentFor,
        consentFrom,
        pendingSwitch,
        tourOpen,
        setTourOpen,
        canSignInWithoutEmail,
        emailEnded,
        finishDeviceSignIn,
        askSwitch,
        handleVerificationSuccess,
        handleSwitchContinue,
        handleSwitchKeep,
        leaveGate,
    } = useAuthScreen({ onLoginSuccess, allowDeviceSignIn });

    // ── The hoisted logo ──────────────────────────────────────────────────
    const logoAt = LOGO[stage];
    const logoScale = useSharedValue(1);
    const logoY = useSharedValue(height * 0.3);
    const logoOpacity = useSharedValue(0);
    // The begin step's logo slot, in window coordinates; `inline` when its
    // stack scrolls (Larger Text) and draws the logo itself instead.
    const [slot, setSlot] = useState<{ y: number; inline: boolean } | null>(null);
    useEffect(() => {
        if (logoAt !== 'slot') setSlot(null);
    }, [logoAt]);
    useEffect(() => {
        const hidden = !logoAt || (logoAt === 'slot' && slot?.inline === true);
        if (!logoAt || (logoAt === 'slot' && !slot)) {
            // Gone, or a slot not measured yet (hold where it is until it reports).
            logoOpacity.value = withTiming(hidden ? 0 : 1, { duration: reduceMotion ? 0 : 250 });
            return;
        }
        const topY = (y: number) => y - (LOGO_FULL - LOGO_TOP) / 2;
        const y = logoAt === 'center' ? height * 0.3 : logoAt === 'slot' && slot ? topY(slot.y) : topY(insets.top + 16);
        const scale = logoAt === 'center' ? 1 : LOGO_TOP / LOGO_FULL;
        if (reduceMotion) {
            // A plain crossfade: out where it is, in where it goes.
            const half = MOTION.launchLogo.duration / 2;
            logoOpacity.value = withSequence(withTiming(0, { duration: half }), withTiming(hidden ? 0 : 1, { duration: half }));
            logoY.value = withDelay(half, withTiming(y, { duration: 0 }));
            logoScale.value = withDelay(half, withTiming(scale, { duration: 0 }));
            return;
        }
        // ONE glide, position and scale together, at the track's own pace and
        // in-out curve so the whole move reads (the boxes-to-cone crossfade
        // in LaunchLogo runs inside it). A front-loaded curve looked like a jump.
        const glide = { duration: MOTION.stage.duration, easing: EASE.across };
        logoOpacity.value = withTiming(hidden ? 0 : 1, { duration: 250 });
        logoScale.value = withTiming(scale, glide);
        logoY.value = withTiming(y, glide);
    }, [logoAt, slot, height, insets.top, reduceMotion, logoScale, logoY, logoOpacity]);
    const logoStyle = useAnimatedStyle(() => ({
        opacity: logoOpacity.value,
        transform: [{ translateY: logoY.value }, { scale: logoScale.value }],
    }));
    // Consent draws its own top bar: the back button on the logo's row.
    const bodyTop = insets.top + (logoAt === 'top' && stage !== 'consent' ? 16 + LOGO_TOP + 16 : 16);

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
                    onLogoSlot={setSlot}
                    emailEnded={emailEnded}
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
                    onUnsupportedToEmail={unsupportedExit(cachedEmail) ? () => go('reauth-email') : undefined}
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
                    onUsePhone={
                        canSignInWithoutEmail
                            ? () => {
                                  setConsentFor('device');
                                  setConsentFrom('begin');
                                  go('consent');
                              }
                            : undefined
                    }
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
        case 'email-ended':
            body = (
                <EmailEndedStage
                    onUsePhone={
                        canSignInWithoutEmail
                            ? () => {
                                  setConsentFor('device');
                                  setConsentFrom('email-ended');
                                  go('consent');
                              }
                            : undefined
                    }
                />
            );
            break;
        case 'reauth-otp':
            body = (
                <OTPVerificationView
                    email={pendingEmail}
                    title={t('gate.enterCode')}
                    expectedUserId={cachedUserId}
                    onAccountMismatch={() => go('reauth-mismatch')}
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
        case 'reauth-mismatch':
            body = <ReauthMismatchStage onOtherEmail={() => go('reauth-other-email')} />;
            break;
        case 'reauth-other-email':
            body = (
                <EmailStage
                    initialEmail=""
                    onBack={() => go('reauth-mismatch')}
                    onSent={(email) => {
                        setPendingEmail(email);
                        go('reauth-otp');
                    }}
                />
            );
            break;
        case 'reauth-no-email':
            body = (
                <ReauthNoEmailStage supportId={supportId} onReset={leaveGate} />
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
                {/* Working while Mera starts, settling to the plain moving logo
                    when the language is asked (and every step after). */}
                <LaunchLogo size={LOGO_FULL} working={stage === 'loading' || stage === 'intro'} />
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

export default AuthScreen;
