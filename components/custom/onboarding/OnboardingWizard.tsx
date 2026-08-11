import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Progress, ProgressFilledTrack } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AccountService } from '../../../lib/account-service';
import { OnboardingStage } from '../../../lib/generated/graphql-types';
import { authClient, clearAuthStorage } from '../../../lib/auth-client';
import { convertLocalHoursToUTC, convertUTCHoursToLocal } from '../../../lib/notificationSlotUtils';
import { ensurePushTokenRegistered } from '../../../lib/notification-service';
import { reconcileAppLanguageWithPersona } from '../../../lib/language-sync';
import {
    useOnboardingIsInitializing,
    useOnboardingPreferences,
    useOnboardingStep,
    useOnboardingStore,
} from '../../../lib/stores/onboarding-store';
import {
    useFloatingChatHasUnresolvedTopicPlans,
    useFloatingChatStore,
} from '../../../lib/stores/floating-chat-store';
import { isOnline, useIsOnline } from '../../../lib/stores/network-store';
import { useTranslation } from 'react-i18next';
import OnboardingNavBar from '../chat/OnboardingNavBar';
import PersonaUpdateChatStep from './PersonaUpdateChatStep';
import NotificationSettingsScreen from '../config-mera/NotificationSettingsScreen';

// 2-step wizard: 0 = Notifications, 1 = PersonaChat. The server OnboardingStage
// picks which step to RESUME at on mount; it never decides whether the wizard
// runs at all — that gate is the local fact count (OnboardingScreen /
// app/logged-in/index.tsx).
//
// FINISHED maps to step 1 on purpose, and it is a reachable entry state, not a
// defensive fallback: a user whose stage is FINISHED but who has zero local
// facts (they tapped Next through the persona chat) is deliberately sent back
// in, and the step that captures facts is step 1. The wizard must never
// auto-advance to completion off the server stage — only the user pressing Next
// on step 1 calls onComplete().
const STAGE_TO_STEP: Record<OnboardingStage, number> = {
    [OnboardingStage.Notifications]: 0,
    [OnboardingStage.ProcessingMode]: 1,
    [OnboardingStage.PersonaChat]: 1,
    [OnboardingStage.Finished]: 1,
};

const TOTAL_STEPS = 2;

// Stage to advance to when the user clicks Next on a given step.
const NEXT_STAGE_FOR_STEP: Record<number, OnboardingStage> = {
    0: OnboardingStage.PersonaChat,
    1: OnboardingStage.Finished,
};

// OnboardingWizard now uses Zustand store for state persistence

/** Bound on the mount-time session lookup. See initializeUserId below. */
const SESSION_LOOKUP_TIMEOUT_MS = 3_000;

interface OnboardingWizardProps {
    /**
     * Effective owner, resolved locally by the caller (session id, else the
     * persisted `cached_user_id`). Seeds the wizard synchronously so the persona
     * step has an owner even when the session lookup below yields nothing.
     */
    userId?: string;
    onComplete: () => void;
}


const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ userId: initialUserId, onComplete }) => {
    const { t } = useTranslation();
    // Use Zustand store for persistent state
    const currentStep = useOnboardingStep();
    const userPreferences = useOnboardingPreferences();
    const isInitializing = useOnboardingIsInitializing();

    // Get actions from store
    const { setStep, updatePreferences, setIsInitializing, resetOnboarding } = useOnboardingStore();

    const toast = useToast();
    const insets = useSafeAreaInsets();

    // Server error modal state
    const [showServerErrorModal, setShowServerErrorModal] = useState(false);
    const [isLoggingOut, setIsLoggingOut] = useState(false);
    // Reactive so the destructive action reappears the moment connectivity does.
    const offline = !useIsOnline();

    // r14 — SECOND HALF of the topic-plan gate. ChatSessionView disables the
    // chat input while a "Topics I'll track" card is unresolved, but step 1
    // renders that chat UNDER this wizard's own nav bar: leave Next live and the
    // block is bypassed by the most obvious tap on the screen. The count is
    // published by ChatSessionView (which owns the resolution logic) and is 0
    // whenever no chat session is mounted, so this can only bite on step 1.
    const hasUnresolvedTopicPlans = useFloatingChatHasUnresolvedTopicPlans();

    // Initialize userId and pre-populate with existing user data on mount
    useEffect(() => {
        const initializeUserId = async () => {
            try {
                // Seed the owner from the locally-resolved prop FIRST, so the
                // persona step (which takes userPreferences.userId) has one even
                // if the lookup below returns nothing. Previously the id was set
                // only inside the `if (sessionData?.data …)` branch, so offline
                // it was never set at all.
                if (initialUserId) updatePreferences('userId', initialUserId);

                // Bounded. authClient uses better-auth's own transport, NOT
                // Apollo's HttpLink, so the slow/abort thresholds in
                // lib/apollo-fetch.ts do not apply to it — an unreachable server
                // that accepts the socket and never answers would otherwise hang
                // this promise forever and pin the "Loading…" spinner, because
                // the `finally` that clears isInitializing never runs.
                const sessionData = await Promise.race([
                    authClient.getSession(),
                    new Promise<null>((resolve) =>
                        setTimeout(() => resolve(null), SESSION_LOOKUP_TIMEOUT_MS),
                    ),
                ]);
                if (sessionData?.data && sessionData.data.user?.id) {
                    const userId = sessionData.data.user.id;
                    updatePreferences('userId', userId);

                    // Fetch existing user persona to pre-populate form
                    const userPersona = await AccountService.getUserPersona(userId);

                    let serverStep = STAGE_TO_STEP[OnboardingStage.Notifications];
                    if (userPersona) {
                        // Pre-populate notification hours (convert from UTC to local)
                        if (userPersona.preferredNotificationWindow && userPersona.preferredNotificationWindow.length > 0) {
                            const localHours = convertUTCHoursToLocal(userPersona.preferredNotificationWindow);
                            updatePreferences('notificationHours', localHours);
                        }

                        // Server stage picks the RESUME step only. FINISHED is a
                        // legitimate entry state now (stage FINISHED + 0 local
                        // facts re-enters the wizard) and maps to step 1, the
                        // persona chat — the step that actually captures facts.
                        // Deliberately no completion shortcut here.
                        const serverStage = userPersona.onboardingStage ?? OnboardingStage.Notifications;
                        serverStep = STAGE_TO_STEP[serverStage] ?? 0;
                    }

                    setStep(serverStep);
                }
            } catch {
                // Error initializing - silently handle
            } finally {
                setIsInitializing(false);
            }
        };

        initializeUserId();
    }, [initialUserId, updatePreferences, setIsInitializing, setStep]);

    // The persona step is now an inline chat (PersonaUpdateChatStep), so the
    // wizard no longer orchestrates the floating bubble/popover. This defensive
    // unmount-restore effect stays: if some earlier flow left the floating chat
    // suppressed or expanded, leaving onboarding restores the default state.
    useEffect(() => {
        return () => {
            const store = useFloatingChatStore.getState();
            store.collapse();
            store.setSuppressed(false);
        };
    }, []);

    // Helper function to get current user ID. Falls back to the locally-resolved
    // owner: a session lookup that fails for network reasons is not proof the
    // user is unauthenticated, and treating it as such is what used to raise the
    // "server error" modal below. Safe because handleNext only ever calls this
    // once it has established the network is believed up.
    const getCurrentUserId = async (): Promise<string> => {
        const sessionData = await authClient.getSession().catch(() => null);
        const resolved =
            sessionData?.data?.user?.id ?? userPreferences.userId ?? initialUserId;
        if (!resolved) {
            throw new Error('User not authenticated');
        }
        return resolved;
    };

    const handleServerErrorLogout = async () => {
        try {
            setIsLoggingOut(true);
            setShowServerErrorModal(false);

            await authClient.signOut();
            await clearAuthStorage();

            // Note: no dismissAll() here — onboarding is already at the top of the stack
            router.replace('/');

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('onboarding.signedOutTitle')}</ToastTitle>
                        <ToastDescription>{t('onboarding.signedOutDescription')}</ToastDescription>
                    </Toast>
                ),
            });
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

    // --- Nav handlers for OnboardingNavBar (steps 0 and 1) ---
    const handleBack = useCallback(() => setStep(currentStep - 1), [currentStep, setStep]);

    const handleNext = useCallback(async () => {
        // Topic-plan gate BEFORE anything else, including the offline check: a
        // pending card is a local-state problem and advancing the server stage
        // for it would be wrong even online. `skipDisabled` on the nav bar
        // already prevents the tap; this is the programmatic backstop, and it
        // surfaces WHY rather than looking like a dead button.
        if (hasUnresolvedTopicPlans) {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="warning" variant="solid">
                        <ToastDescription>
                            {t('topicPlan.resolveBeforeContinuing')}
                        </ToastDescription>
                    </Toast>
                ),
            });
            return;
        }

        // Offline check FIRST, before getCurrentUserId and before any mutation.
        //
        // Putting this in the catch below would still fire
        // updateNotificationPreferences → ensurePushTokenRegistered →
        // advanceOnboardingStage against a server we already know we cannot
        // reach. This function has no busy state and OnboardingNavBar's onSkip
        // is not disabled while it awaits, so against a hanging server the user
        // gets no feedback and can re-tap, stacking duplicate mutations.
        //
        // It also makes getCurrentUserId's local fallback safe rather than
        // merely probably-safe: the fallback can now only supply an id on a path
        // where the network is believed up.
        if (!isOnline()) {
            setShowServerErrorModal(true);
            return;
        }

        try {
            const userId = await getCurrentUserId();
            switch (currentStep) {
                case 0:
                    if (userPreferences.notificationHours.length > 0) {
                        await AccountService.updateNotificationPreferences(
                            userId,
                            convertLocalHoursToUTC(userPreferences.notificationHours),
                        );
                    }
                    // Register the Expo push token regardless of the visible-
                    // notification switch — the silent-push background cycle
                    // needs the token to wake the device. Enabling the switch
                    // already handled the full permission request and token
                    // registration; if the user left the switch off we still
                    // register provisionally here so silent wakes deliver.
                    await ensurePushTokenRegistered(userId);
                    // Now that the user is authenticated with a persona, push the
                    // language they picked earlier (LanguageSelector, pre-auth)
                    // into language_codes. Fire-and-forget so it can't block nav.
                    void reconcileAppLanguageWithPersona({ userId });
                    await AccountService.advanceOnboardingStage(userId, NEXT_STAGE_FOR_STEP[0]);
                    setStep(1);
                    break;
                case 1: {
                    await AccountService.advanceOnboardingStage(userId, NEXT_STAGE_FOR_STEP[1]);
                    resetOnboarding();
                    onComplete();
                    break;
                }
            }
        } catch {
            setShowServerErrorModal(true);
        }
    }, [
        currentStep,
        userPreferences,
        setStep,
        resetOnboarding,
        onComplete,
        hasUnresolvedTopicPlans,
        toast,
        t,
    ]);

    const renderStep = () => {
        switch (currentStep) {
            case 0:
                return (
                    <NotificationSettingsScreen
                        isOnboarding={true}
                        initialHours={userPreferences.notificationHours}
                        onHoursChange={(hours) => updatePreferences('notificationHours', hours)}
                    />
                );
            case 1:
                return (
                    <PersonaUpdateChatStep userId={userPreferences.userId} />
                );
            default:
                return null;
        }
    };

    // Show loading spinner while initializing userId
    if (isInitializing) {
        return (
            // No opaque fill: the AbstractGradientBackdrop below is the page background.
            <Box className="flex-1 justify-center items-center">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Spinner size="large" />
                <Text className="text-white mt-4">{t('common.loading')}</Text>
            </Box>
        );
    }

    return (
        // Unpadded wrapper. The backdrop hangs off THIS box, not the padded one
        // below, so it spans the FULL screen including the safe areas — an
        // absolute fill resolves against its parent's CONTENT box, so mounting it
        // inside the padded box left a black strip in the inset.
        <Box className="flex-1">
            {/* Page background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

            {/* No opaque fill: the backdrop above is the page background. */}
            <Box testID="onboarding-screen" className="flex-1" style={{ paddingBottom: insets.bottom }}>

            {/* Progress Indicator */}
            <Box className="pb-5 px-5" style={{ paddingTop: insets.top + 16 }}>
                <Progress value={((currentStep + 1) / TOTAL_STEPS) * 100} size="sm">
                    <ProgressFilledTrack />
                </Progress>
            </Box>

            {/* Step 0 has no prior step to return to; step 1 can go back to it. */}
            <OnboardingNavBar
                onBack={currentStep > 0 ? handleBack : undefined}
                onSkip={handleNext}
                skipLabel={t('common.next')}
                skipDisabled={hasUnresolvedTopicPlans}
                stepLabel={t('onboarding.stepOf', { current: currentStep + 1, total: TOTAL_STEPS })}
            />

            {renderStep()}

            {/* Server Error Modal */}
            <Modal
                isOpen={showServerErrorModal}
                onClose={() => setShowServerErrorModal(false)}
                size="sm"
            >
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="border-gray-700 pb-4">
                        <Text className="text-xl font-semibold text-white">{t('onboarding.connectionIssue')}</Text>
                    </ModalHeader>
                    <ModalBody className="py-6">
                        <Text className="text-gray-300 text-base leading-relaxed">
                            {t('onboarding.connectionDescription')}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <VStack className="w-full" space="md">
                            {/* Log out is DESTRUCTIVE — handleServerErrorLogout
                                calls clearAuthStorage(). Offer it only when the
                                server actually answered and rejected us, never
                                when the cause is connectivity: this modal is
                                raised by a failed request, so an offline user
                                pressing Next was being handed "wipe your
                                credentials" as the primary remedy for a network
                                blip. Offline they get Close only, and the global
                                offline band explains why. */}
                            {!offline && (
                                <Button
                                    action="negative"
                                    onPress={handleServerErrorLogout}
                                    disabled={isLoggingOut}
                                    className="w-full"
                                    testID="onboarding-server-error-logout"
                                >
                                    <ButtonText>
                                        {isLoggingOut ? t('onboarding.loggingOut') : t('onboarding.logout')}
                                    </ButtonText>
                                </Button>
                            )}
                            <Button
                                variant="outline"
                                action="secondary"
                                onPress={() => setShowServerErrorModal(false)}
                                className="w-full"
                            >
                                <ButtonText>{t('onboarding.close')}</ButtonText>
                            </Button>
                        </VStack>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </Box>
        </Box>
    );
};

export default OnboardingWizard;
