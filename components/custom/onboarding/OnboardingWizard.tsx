import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text as RNText, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { AccountService } from '@/lib/account-service';
import { authClient, clearAuthStorage } from '@/lib/auth-client';
import { observeFacts } from '@/lib/database/services/fact-service';
import { OnboardingStage } from '@/lib/generated/graphql-types';
import { reconcileAppLanguageWithPersona } from '@/lib/language-sync';
import { SPRING } from '@/lib/motion';
import { ensurePushTokenRegistered } from '@/lib/notification-service';
import { convertLocalHoursToUTC, convertUTCHoursToLocal } from '@/lib/notificationSlotUtils';
import {
    useFloatingChatHasUnresolvedTopicPlans,
    useFloatingChatStore,
    useFloatingChatUnresolvedCounts,
} from '@/lib/stores/floating-chat-store';
import { isOnline, useIsOnline } from '@/lib/stores/network-store';
import {
    useOnboardingIsInitializing,
    useOnboardingPreferences,
    useOnboardingStep,
    useOnboardingStore,
} from '@/lib/stores/onboarding-store';
import { useColors } from '@/lib/theme/tokens';

import NotificationSettingsScreen from '../config-mera/NotificationSettingsScreen';
import { NextGuardBox } from './NextGuardBox';
import { markOnboardingDone } from './onboarding-done';
import PersonaUpdateChatStep from './PersonaUpdateChatStep';

// Two steps (FinalJourney #8, #24): 0 = tell Mera (the persona chat), 1 =
// notifications. Chat comes first so the reader's first minute is spent on
// what makes the Feed, and notifications are asked only once there is news to
// be told about. It always opens at the chat: whether the wizard runs at all is
// the local `onboarding_done` gate (onboarding-done.ts), and the server stage
// is written for the record only.
const TOTAL_STEPS = 2;
const NEXT_STAGE_FOR_STEP: Record<number, OnboardingStage> = {
    0: OnboardingStage.PersonaChat,
    1: OnboardingStage.Finished,
};

/** Bound on the mount-time session lookup. */
const SESSION_LOOKUP_TIMEOUT_MS = 3_000;

type Guard = 'no-facts' | 'no-notifications' | null;

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
    const [isLoggingOut, setIsLoggingOut] = useState(false);
    const offline = !useIsOnline();
    const [guard, setGuard] = useState<Guard>(null);
    const [notificationsOn, setNotificationsOn] = useState(false);
    const [enableRequest, setEnableRequest] = useState(0);
    const [busy, setBusy] = useState(false);

    // The chat step's input is locked while a "Topics I'll track" or a fact
    // choice card is unresolved (ChatSessionView); Next must honour the same
    // lock or the block is bypassed by the most obvious tap on the screen.
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
            store.setSuppressed(false);
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

    const handleServerErrorLogout = async () => {
        try {
            setIsLoggingOut(true);
            setShowServerError(false);
            // clearAuthStorage() owns the guarded, bounded server sign-out.
            await clearAuthStorage();
            router.replace('/');
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('onboarding.logoutFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('onboarding.logoutFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsLoggingOut(false);
        }
    };

    /** Move on from the current step, past its guard. */
    const advance = useCallback(async () => {
        setGuard(null);
        // Offline FIRST: every step below talks to the server.
        if (!isOnline()) {
            setShowServerError(true);
            return;
        }
        setBusy(true);
        try {
            const userId = await getCurrentUserId();
            if (currentStep === 0) {
                await AccountService.advanceOnboardingStage(userId, NEXT_STAGE_FOR_STEP[0]);
                setStep(1);
                return;
            }
            if (userPreferences.notificationHours.length > 0) {
                await AccountService.updateNotificationPreferences(
                    userId,
                    convertLocalHoursToUTC(userPreferences.notificationHours),
                );
            }
            // The push token registers regardless of the visible switch: the
            // silent-push background cycle needs it.
            await ensurePushTokenRegistered(userId);
            void reconcileAppLanguageWithPersona({ userId });
            await AccountService.advanceOnboardingStage(userId, NEXT_STAGE_FOR_STEP[1]);
            await markOnboardingDone();
            resetOnboarding();
            onComplete();
        } catch {
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
                    placement: 'top',
                    render: () => (
                        <Toast action="warning" variant="solid">
                            <ToastDescription>
                                {unresolvedCounts.factChoices > 0
                                    ? t('factChoice.resolveBeforeContinuing')
                                    : t('topicPlan.resolveBeforeContinuing')}
                            </ToastDescription>
                        </Toast>
                    ),
                });
                return;
            }
            if (factCount === 0) {
                setGuard('no-facts');
                return;
            }
        } else if (!notificationsOn) {
            setGuard('no-notifications');
            return;
        }
        void advance();
    }, [busy, currentStep, hasUnresolvedTopicPlans, unresolvedCounts, factCount, notificationsOn, advance, toast, t]);

    if (isInitializing) {
        return (
            <Box className="flex-1 justify-center items-center">
                <AbstractGradientBackdrop />
                <Spinner size="large" />
            </Box>
        );
    }

    const nextButton = (
        <Button action="primary" onPress={handleNext} isDisabled={busy} style={styles.next} testID="onboarding-next">
            <ButtonText>{t('common.next')}</ButtonText>
        </Button>
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
                    <RNText style={[styles.step, { color: colors.ink3 }]}>
                        {t('onboarding.stepOf', { current: currentStep + 1, total: TOTAL_STEPS })}
                    </RNText>
                </View>

                {currentStep === 0 ? (
                    <>
                        <Animated.View style={[styles.counter, { backgroundColor: colors.surface, borderColor: colors.line }, popStyle]}>
                            <RNText style={[styles.counterText, { color: colors.ink }]} testID="onboarding-facts-count">
                                {t('onboarding.factsCount', { count: factCount })}
                            </RNText>
                        </Animated.View>
                        <View style={styles.flex}>
                            <PersonaUpdateChatStep
                                userId={userPreferences.userId}
                                composerTrailing={nextButton}
                                composerPlaceholder={t('onboarding.composerPlaceholder')}
                            />
                        </View>
                    </>
                ) : (
                    <>
                        <View style={styles.remind}>
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
                        <View style={styles.footer}>{nextButton}</View>
                    </>
                )}

                <View style={[styles.guard, { bottom: insets.bottom + 72 }]} pointerEvents="box-none">
                    <NextGuardBox
                        open={guard === 'no-facts'}
                        title={t('onboarding.noFactsTitle')}
                        body={t('onboarding.noFactsBody')}
                        primaryLabel={t('facts.addFact')}
                        onPrimary={() => setGuard(null)}
                        secondaryLabel={t('onboarding.continueAnyway')}
                        onSecondary={() => void advance()}
                        testID="onboarding-guard-facts"
                    />
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

            {/* A failed request on Next. Log out is destructive (clearAuthStorage),
                so it is offered only when the server answered and rejected us,
                never for a connectivity blip. */}
            <ConfirmDialog
                open={showServerError}
                title={t('onboarding.connectionIssue')}
                body={t('onboarding.connectionDescription')}
                confirmLabel={offline ? t('onboarding.close') : t('onboarding.logout')}
                destructive={!offline}
                busy={isLoggingOut}
                onConfirm={() => (offline ? setShowServerError(false) : void handleServerErrorLogout())}
                onCancel={offline ? undefined : () => setShowServerError(false)}
                cancelLabel={t('onboarding.close')}
                testID="onboarding-server-error"
            />
        </View>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, minHeight: 44 },
    who: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
    footer: { paddingHorizontal: 20, paddingBottom: 12 },
    next: { height: 44, paddingHorizontal: 20 },
    guard: { position: 'absolute', left: 16, right: 16 },
});

export default OnboardingWizard;
