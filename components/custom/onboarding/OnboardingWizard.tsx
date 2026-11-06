import React, { useCallback, useEffect, useState } from 'react';
import { Keyboard, StyleSheet, Text as RNText, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import ReadinessBadge from '@/components/custom/floating-chat/ReadinessBadge';
import MeraToast from '@/components/custom/toast/MeraToast';
import { useToast } from '@/components/ui/toast';
import { AccountService } from '@/lib/account-service';
import { authClient } from '@/lib/auth-client';
import { observeFacts } from '@/lib/database/services/fact-service';
import { OnboardingStage } from '@/lib/generated/graphql-types';
import { reconcileAppLanguageWithPersona } from '@/lib/language-sync';
import { useChatRunsInCloud } from '@/lib/llm/chat-cloud';
import { useChatReadiness } from '@/lib/llm/prewarm';
import { SPRING } from '@/lib/motion';
import { ensurePushTokenRegistered } from '@/lib/notification-service';
import { convertLocalHoursToUTC, convertUTCHoursToLocal } from '@/lib/algorithms/notificationSlotUtils';
import {
    useFloatingChatHasUnresolvedTopicPlans,
    useFloatingChatStore,
    useFloatingChatUnresolvedCounts,
} from '@/lib/stores/floating-chat-store';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { isOnline, useIsOnline } from '@/lib/stores/network-store';
import { isSessionRefusedError } from '@/lib/utils/retry';
import {
    useOnboardingIsInitializing,
    useOnboardingPreferences,
    useOnboardingStep,
    useOnboardingStore,
} from '@/lib/stores/onboarding-store';
import { useUserStore } from '@/lib/stores/user-store';
import { useColors } from '@/lib/theme/tokens';

import NotificationSettingsScreen from '../config-mera/NotificationSettingsScreen';
import { NextGuardBox } from './NextGuardBox';
import { markOnboardingDone } from './onboarding-done';
import OnboardingCityStep from './OnboardingCityStep';
import OnboardingSourcesStep from './OnboardingSourcesStep';
import PersonaUpdateChatStep from './PersonaUpdateChatStep';
import { useServerErrorLogout } from './useServerErrorLogout';

// Three steps (FinalJourney #8, #24): 0 = tell Mera (the persona chat), 1 =
// sources (search only, skippable, no server stage), 2 = notifications. Chat
// comes first so the reader's first minute is spent on what makes the Feed,
// and notifications are asked only once there is news to be told about. It
// always opens at the chat: whether the wizard runs at all is the local
// `onboarding_done` gate (onboarding-done.ts), and the server stage is written
// for the record only.
const TOTAL_STEPS = 3;
const NEXT_STAGE_FOR_STEP: Record<number, OnboardingStage> = {
    0: OnboardingStage.PersonaChat,
    2: OnboardingStage.Finished,
};

/** Bound on the mount-time session lookup. */
const SESSION_LOOKUP_TIMEOUT_MS = 3_000;

type Guard = 'no-notifications' | null;

interface OnboardingWizardProps {
    /**
     * Effective owner, resolved locally by the caller (session id, else the
     * persisted `cached_user_id`). Seeds the wizard synchronously so the chat
     * step has an owner even when the session lookup yields nothing.
     */
    userId?: string;
    onComplete: () => void;
}

const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ userId: initialUserId, onComplete }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const toast = useToast();
    const reduceMotion = useReducedMotion();

    const currentStep = useOnboardingStep();
    const userPreferences = useOnboardingPreferences();
    const isInitializing = useOnboardingIsInitializing();
    const { setStep, updatePreferences, setIsInitializing, resetOnboarding } = useOnboardingStore();

    const [showServerError, setShowServerError] = useState(false);
    const [sessionRefused, setSessionRefused] = useState(false);
    const { isLoggingOut, handleServerErrorLogout } = useServerErrorLogout(setShowServerError);
    const offline = !useIsOnline();
    const [guard, setGuard] = useState<Guard>(null);
    // Next with zero facts asks for a city, unless the reader already declined that
    // question in the chat. Memory only, so a reopened wizard asks again.
    const [cityOpen, setCityOpen] = useState(false);
    const [declinedHome, setDeclinedHome] = useState(false);
    const declineHome = useCallback(() => setDeclinedHome(true), []);
    const [notificationsOn, setNotificationsOn] = useState(false);
    const [enableRequest, setEnableRequest] = useState(0);
    const [busy, setBusy] = useState(false);
    const [hasPicks, setHasPicks] = useState(false);

    // The chat step's input is locked while a "Topics I'll track" or a fact
    // choice card is unresolved (ChatSessionView); Next must honour the same
    // lock or the block is bypassed by the most obvious tap on the screen.
    // The chat's readiness badge, by the same rules as its header.
    const readiness = useChatReadiness((s) => s.status);
    const chatInCloud = useChatRunsInCloud();
    const blockedLive = useCloudChatStore((s) => s.isBlocked);
    const blockedPersona = useUserStore((s) => !!s.userPersona?.blockedByLlm);
    const badge =
        currentStep === 0 && !cityOpen && chatInCloud && !blockedLive && !blockedPersona && readiness !== 'idle'
            ? {
                  warming: { label: t('chat.statusWarming'), tone: 'neutral' as const, icon: 'autorenew' as const },
                  ready: { label: t('chat.statusReady'), tone: 'positive' as const, icon: 'check' as const },
                  error: { label: t('chat.statusError'), tone: 'negative' as const, icon: 'error-outline' as const },
              }[readiness]
            : null;

    const hasUnresolvedTopicPlans = useFloatingChatHasUnresolvedTopicPlans();
    const unresolvedCounts = useFloatingChatUnresolvedCounts();

    // The facts counter (Journey #8): the counter is the progress.
    const [factCount, setFactCount] = useState(0);
    const pop = useSharedValue(1);
    useEffect(() => {
        const sub = observeFacts().subscribe((rows) => setFactCount(rows.length));
        return () => sub.unsubscribe();
    }, []);
    useEffect(() => {
        if (factCount === 0 || reduceMotion) return;
        pop.value = withSequence(withSpring(1.12, SPRING.like), withSpring(1, SPRING.like));
    }, [factCount, reduceMotion, pop]);
    const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

    useEffect(() => {
        const init = async () => {
            try {
                if (initialUserId) updatePreferences('userId', initialUserId);
                // Bounded: better-auth's transport has no timeout of its own.
                const sessionData = await Promise.race([
                    authClient.getSession(),
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), SESSION_LOOKUP_TIMEOUT_MS)),
                ]);
                const userId = sessionData?.data?.user?.id;
                if (userId) {
                    updatePreferences('userId', userId);
                    const persona = await AccountService.getUserPersona(userId);
                    if (persona?.preferredNotificationWindow?.length) {
                        updatePreferences('notificationHours', convertUTCHoursToLocal(persona.preferredNotificationWindow));
                    }
                }
            } catch {
                // The wizard works without the prefill.
            } finally {
                setStep(0);
                setIsInitializing(false);
            }
        };
        void init();
    }, [initialUserId, updatePreferences, setIsInitializing, setStep]);

    // Leaving onboarding restores the floating chat's default state.
    useEffect(() => {
        return () => {
            const store = useFloatingChatStore.getState();
            store.collapse();
        };
    }, []);

    // A failed lookup is not proof of being signed out; fall back to the
    // locally resolved owner (only called once the network is believed up).
    const getCurrentUserId = async (): Promise<string> => {
        const sessionData = await authClient.getSession().catch(() => null);
        const resolved = sessionData?.data?.user?.id ?? userPreferences.userId ?? initialUserId;
        if (!resolved) throw new Error('User not authenticated');
        return resolved;
    };

    /** Move on from the current step, past its guard. */
    const advance = useCallback(async () => {
        setGuard(null);
        if (currentStep === 0) {
            // For the record only, so it never holds the reader back: the server
            // stage decides nothing, and the last step writes a later one.
            void getCurrentUserId()
                .then((userId) => AccountService.advanceOnboardingStage(userId, NEXT_STAGE_FOR_STEP[0]))
                .catch(() => undefined);
            setStep(1);
            return;
        }
        // Sources writes nothing to the server, so Skip works offline.
        if (currentStep === 1) {
            setStep(2);
            return;
        }
        // Offline FIRST: the last step talks to the server.
        if (!isOnline()) {
            setSessionRefused(false);
            setShowServerError(true);
            return;
        }
        setBusy(true);
        try {
            const userId = await getCurrentUserId();
            if (userPreferences.notificationHours.length > 0) {
                await AccountService.updateNotificationPreferences(
                    userId,
                    convertLocalHoursToUTC(userPreferences.notificationHours),
                );
            }
            // The push token registers regardless of the visible switch: the
            // silent-push background cycle needs it. Never awaited: it is total,
            // push-token-check-task re-registers later, and a slow Expo answer
            // must not hold the reader back.
            void ensurePushTokenRegistered(userId);
            void reconcileAppLanguageWithPersona({ userId });
            await AccountService.advanceOnboardingStage(userId, NEXT_STAGE_FOR_STEP[2]);
            await markOnboardingDone();
            resetOnboarding();
            onComplete();
        } catch (error) {
            setSessionRefused(isSessionRefusedError(error));
            setShowServerError(true);
        } finally {
            setBusy(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentStep, userPreferences, setStep, resetOnboarding, onComplete]);

    const handleNext = useCallback(() => {
        if (busy) return;
        if (currentStep === 0) {
            if (hasUnresolvedTopicPlans) {
                toast.show({
                    render: () => (
                        <MeraToast
                            tone="warning"
                            title={
                                unresolvedCounts.factChoices > 0
                                    ? t('factChoice.resolveBeforeContinuing')
                                    : t('topicPlan.resolveBeforeContinuing')
                            }
                        />
                    ),
                });
                return;
            }
            if (factCount === 0 && !declinedHome) {
                setCityOpen(true);
                return;
            }
        } else if (currentStep === 2 && !notificationsOn) {
            Keyboard.dismiss();
            setGuard('no-notifications');
            return;
        }
        void advance();
    }, [busy, currentStep, hasUnresolvedTopicPlans, unresolvedCounts, factCount, declinedHome, notificationsOn, advance, toast, t]);

    if (isInitializing) {
        return (
            <Box className="flex-1 justify-center items-center">
                <AbstractGradientBackdrop />
                <Spinner size="large" />
            </Box>
        );
    }

    const skipping = currentStep === 1 && !hasPicks;
    const stepText = t('onboarding.stepOf', { current: currentStep + 1, total: TOTAL_STEPS });
    const nextButton = (
        <View style={currentStep === 1 ? styles.nextFrame : undefined}>
            <Button
                action="primary"
                variant={skipping ? 'outline' : 'solid'}
                onPress={handleNext}
                isDisabled={busy}
                style={currentStep === 1 ? styles.nextFixed : styles.next}
                testID="onboarding-next"
            >
                <ButtonText>{skipping ? t('onboarding.sourcesSkip') : t('common.next')}</ButtonText>
            </Button>
        </View>
    );

    return (
        <View style={styles.root}>
            <AbstractGradientBackdrop />
            <View testID="onboarding-screen" style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom }]}>
                <View style={styles.header}>
                    <View style={styles.who}>
                        <MeraLogo size={28} animated />
                        <RNText style={[styles.name, { color: colors.ink }]}>Mera</RNText>
                    </View>
                    <View style={[styles.who, styles.shrink]}>
                        {/* A View, because iOS caches a Text's label until its string changes, and the status changes with the string fixed. */}
                        <View
                            style={styles.shrink}
                            accessible
                            accessibilityRole="text"
                            accessibilityLabel={badge ? `${stepText}, ${badge.label}` : stepText}
                            testID="onboarding-step-label"
                        >
                            <RNText style={[styles.step, { color: colors.ink3 }]}>{stepText}</RNText>
                        </View>
                        {badge ? <ReadinessBadge {...badge} spinning={readiness === 'warming'} /> : null}
                        {cityOpen ? null : nextButton}
                    </View>
                </View>

                {cityOpen ? (
                    <OnboardingCityStep
                        onClose={() => setCityOpen(false)}
                        onDone={() => {
                            setCityOpen(false);
                            void advance();
                        }}
                    />
                ) : null}
                {currentStep === 0 ? (
                    // Stays mounted under the city step, so a Back keeps the chat as it was.
                    <View style={[styles.flex, cityOpen && styles.hidden]}>
                        <Animated.View style={[styles.counter, { backgroundColor: colors.surface, borderColor: colors.line }, popStyle]}>
                            <RNText style={[styles.counterText, { color: colors.ink }]} testID="onboarding-facts-count">
                                {t('onboarding.factsCount', { count: factCount })}
                            </RNText>
                        </Animated.View>
                        <View style={styles.flex}>
                            <PersonaUpdateChatStep userId={userPreferences.userId} onDeclineHome={declineHome} />
                        </View>
                    </View>
                ) : currentStep === 1 ? (
                    <OnboardingSourcesStep onHasPicksChange={setHasPicks} />
                ) : (
                    <>
                        <View style={styles.remind} testID="onboarding-remind">
                            <RNText accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                                {t('onboarding.remindTitle')}
                            </RNText>
                            <RNText style={[styles.body, { color: colors.ink2 }]}>{t('onboarding.remindBody')}</RNText>
                        </View>
                        <View style={styles.flex}>
                            <NotificationSettingsScreen
                                isOnboarding
                                initialHours={userPreferences.notificationHours}
                                onHoursChange={(hours) => updatePreferences('notificationHours', hours)}
                                onEnabledChange={setNotificationsOn}
                                enableRequest={enableRequest}
                            />
                        </View>
                    </>
                )}

                <View style={[styles.guard, { bottom: insets.bottom + 72 }]} pointerEvents="box-none">
                    <NextGuardBox
                        open={guard === 'no-notifications'}
                        title={t('onboarding.noNotifTitle')}
                        body={t('onboarding.noNotifBody')}
                        primaryLabel={t('onboarding.turnThemOn')}
                        onPrimary={() => {
                            setGuard(null);
                            setEnableRequest((n) => n + 1);
                        }}
                        secondaryLabel={t('onboarding.notNow')}
                        onSecondary={() => void advance()}
                        testID="onboarding-guard-notifications"
                    />
                </View>
            </View>

            {/* A failed request on Next. Log out is destructive (signOutAndWipe),
                so it is offered only on a real 401 or 403; anything else retries,
                or just closes while offline. */}
            <ConfirmDialog
                open={showServerError}
                title={t('onboarding.connectionIssue')}
                body={t('onboarding.connectionDescription')}
                confirmLabel={sessionRefused ? t('onboarding.logout') : offline ? t('onboarding.close') : t('common.retry')}
                destructive={sessionRefused}
                busy={isLoggingOut}
                onConfirm={() => {
                    if (sessionRefused) {
                        void handleServerErrorLogout();
                        return;
                    }
                    setShowServerError(false);
                    if (!offline) void advance();
                }}
                onCancel={offline && !sessionRefused ? undefined : () => setShowServerError(false)}
                cancelLabel={t('onboarding.close')}
                testID="onboarding-server-error"
            />
        </View>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    hidden: { display: 'none' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, minHeight: 44 },
    who: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    shrink: { flexShrink: 1 },
    name: { fontSize: 16, fontWeight: '700' },
    step: { fontSize: 13 },
    counter: {
        alignSelf: 'center',
        marginTop: 8,
        marginBottom: 4,
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
    },
    counterText: { fontSize: 13, fontWeight: '600' },
    remind: { paddingHorizontal: 20, paddingTop: 16, gap: 10, marginBottom: 12 },
    title: { fontSize: 26, fontWeight: '700' },
    body: { fontSize: 15, lineHeight: 22 },
    next: { height: 36, paddingHorizontal: 16 },
    // Wide enough for the longest Skip, so the header holds still when it turns to Next.
    nextFrame: { width: 104 },
    nextFixed: { height: 36, paddingHorizontal: 8 },
    guard: { position: 'absolute', left: 16, right: 16 },
});

export default OnboardingWizard;
