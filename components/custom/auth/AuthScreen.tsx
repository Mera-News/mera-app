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
import WelcomeStage from '@/components/custom/auth/WelcomeStage';
import LaunchLogo from '@/components/custom/auth/LaunchLogo';
import SystemCheckStage from '@/components/custom/system-check/SystemCheckStage';
import { welcomeVideoUrl } from '@/lib/config/branding';
import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { EASE, MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';

import { BeginStage } from './stages/BeginStage';
import { ConsentStage } from './stages/ConsentStage';
import { DifferentAccountSheet } from './stages/DifferentAccountSheet';
import { ReauthNoEmailStage } from './stages/ReauthNoEmailStage';
import { LOGO_TOP, styles } from './stages/styles';
import { useAuthScreen, type AuthScreenProps, type Stage } from './useAuthScreen';

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
 * with the language list, checks, how to begin, before you start). A device
 * whose account needs signing in again lands on the gate, reauth-no-email
 * (contact support, or reset this phone back to the track). Neither ever
 * switches accounts on its own: moving to the phone's account always asks first.
 */
const AuthScreen: React.FC<AuthScreenProps> = ({ onLoginSuccess }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    const reduceMotion = useReducedMotion();

    const {
        stage,
        forward,
        go,
        cachedUserId,
        supportId,
        availability,
        signInPath,
        pendingSwitch,
        tourOpen,
        setTourOpen,
        finishDeviceSignIn,
        askSwitch,
        handleSwitchContinue,
        handleSwitchKeep,
        leaveGate,
    } = useAuthScreen({ onLoginSuccess });

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
                    canUsePhone={availability !== 'unavailable'}
                    onWithoutEmail={() => go('consent')}
                    onLearn={() => setTourOpen(true)}
                />
            );
            break;
        case 'consent':
            body = (
                <ConsentStage
                    signInPath={signInPath}
                    expectedUserId={cachedUserId}
                    onSignedIn={finishDeviceSignIn}
                    onDifferentAccount={(r) => {
                        askSwitch(r);
                        go('begin');
                    }}
                    onBack={() => go('begin')}
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

            <VideoPlayerModal
                visible={tourOpen}
                uri={welcomeVideoUrl()}
                onClose={() => setTourOpen(false)}
            />

            <BottomSheet
                open={pendingSwitch !== null}
                onClose={() => void handleSwitchKeep()}
                testID="auth-different-account"
            >
                <DifferentAccountSheet
                    onKeep={handleSwitchKeep}
                    onContinue={handleSwitchContinue}
                />
            </BottomSheet>
        </View>
    );
};

export default AuthScreen;
