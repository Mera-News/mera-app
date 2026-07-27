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
import { useFloatingChatStore } from '../../../lib/stores/floating-chat-store';
import { useTranslation } from 'react-i18next';
import OnboardingNavBar from '../chat/OnboardingNavBar';
import PersonaUpdateChatStep from './PersonaUpdateChatStep';
import SetPinStep from './SetPinStep';
import NotificationSettingsScreen from '../config-mera/NotificationSettingsScreen';
import { isPinSet } from '@/lib/security/pin-service';

// 3-step wizard: 0 = SetPin (local-only, mandatory), 1 = Notifications,
// 2 = PersonaChat. The PIN step is NOT part of the server OnboardingStage enum
// — it's tracked locally (a PIN record exists ⇒ skip step 0). The server stage
// maps to the SERVER-backed steps (1 and 2); on mount we seed `currentStep`
// from it so refresh/cold-start resumes correctly.
const STAGE_TO_STEP: Record<OnboardingStage, number> = {
    [OnboardingStage.Notifications]: 1,
    [OnboardingStage.ProcessingMode]: 2,
    [OnboardingStage.PersonaChat]: 2,
    [OnboardingStage.Finished]: 2,
};

const TOTAL_STEPS = 3;

// Stage to advance to when the user clicks Next on a given step. Step 0 (PIN)
// has no server stage — it advances locally via SetPinStep's onDone.
const NEXT_STAGE_FOR_STEP: Record<number, OnboardingStage> = {
    1: OnboardingStage.PersonaChat,
    2: OnboardingStage.Finished,
};

// OnboardingWizard now uses Zustand store for state persistence

interface OnboardingWizardProps {
    onComplete: () => void;
}


const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onComplete }) => {
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

    // Initialize userId and pre-populate with existing user data on mount
    useEffect(() => {
        const initializeUserId = async () => {
            try {
                const sessionData = await authClient.getSession();
                if (sessionData?.data && sessionData.data.user?.id) {
                    const userId = sessionData.data.user.id;
                    updatePreferences('userId', userId);

                    // If no local PIN exists yet, the mandatory PIN step (0) comes
                    // first regardless of server stage. Otherwise resume at the
                    // server-authoritative step.
                    const pinAlreadySet = await isPinSet();

                    // Fetch existing user persona to pre-populate form
                    const userPersona = await AccountService.getUserPersona(userId);

                    let serverStep = STAGE_TO_STEP[OnboardingStage.Notifications];
                    if (userPersona) {
                        // Pre-populate notification hours (convert from UTC to local)
                        if (userPersona.preferredNotificationWindow && userPersona.preferredNotificationWindow.length > 0) {
                            const localHours = convertUTCHoursToLocal(userPersona.preferredNotificationWindow);
                            updatePreferences('notificationHours', localHours);
                        }

                        // Server stage is authoritative for which server-backed
                        // step to show on resume. If FINISHED, the wizard
                        // shouldn't be mounted anyway (logged-in/index.tsx
                        // redirects away) — defensively map to the last step.
                        const serverStage = userPersona.onboardingStage ?? OnboardingStage.Notifications;
                        serverStep = STAGE_TO_STEP[serverStage];
                    }

                    setStep(pinAlreadySet ? serverStep : 0);
                }
            } catch {
                // Error initializing - silently handle
            } finally {
                setIsInitializing(false);
            }
        };

        initializeUserId();
    }, [updatePreferences, setIsInitializing, setStep]);

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

    // Helper function to get current user ID
    const getCurrentUserId = async (): Promise<string> => {
        const sessionData = await authClient.getSession();
        if (!sessionData?.data?.user?.id) {
            throw new Error('User not authenticated');
        }
        return sessionData.data.user.id;
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
        try {
            const userId = await getCurrentUserId();
            switch (currentStep) {
                case 1:
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
                    await AccountService.advanceOnboardingStage(userId, NEXT_STAGE_FOR_STEP[1]);
                    setStep(2);
                    break;
                case 2: {
                    await AccountService.advanceOnboardingStage(userId, NEXT_STAGE_FOR_STEP[2]);
                    resetOnboarding();
                    onComplete();
                    break;
                }
            }
        } catch {
            setShowServerErrorModal(true);
        }
    }, [currentStep, userPreferences, setStep, resetOnboarding, onComplete]);

    const renderStep = () => {
        switch (currentStep) {
            case 0:
                // Mandatory local PIN — advances the wizard once persisted.
                return <SetPinStep onDone={() => setStep(1)} />;
            case 1:
                return (
                    <NotificationSettingsScreen
                        isOnboarding={true}
                        initialHours={userPreferences.notificationHours}
                        onHoursChange={(hours) => updatePreferences('notificationHours', hours)}
                    />
                );
            case 2:
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
            <Box className="flex-1 bg-black justify-center items-center">
                <Spinner size="large" />
                <Text className="text-white mt-4">{t('common.loading')}</Text>
            </Box>
        );
    }

    return (
        <Box className="flex-1 bg-black" style={{ paddingBottom: insets.bottom }}>
            {/* Progress Indicator */}
            <Box className="pb-5 px-5" style={{ paddingTop: insets.top + 16 }}>
                <Progress value={((currentStep + 1) / TOTAL_STEPS) * 100} size="sm">
                    <ProgressFilledTrack />
                </Progress>
            </Box>

            {/* Step 0 (PIN) is mandatory and self-driving: no Back (can't return
                to a completed PIN step) and no Next/Skip (PinKeypad advances on
                confirm). Steps 1–2 use the standard nav bar. */}
            <OnboardingNavBar
                onBack={currentStep > 1 ? handleBack : undefined}
                onSkip={currentStep === 0 ? undefined : handleNext}
                skipLabel={t('common.next')}
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
                            <Button
                                action="negative"
                                onPress={handleServerErrorLogout}
                                disabled={isLoggingOut}
                                className="w-full"
                            >
                                <ButtonText>
                                    {isLoggingOut ? t('onboarding.loggingOut') : t('onboarding.logout')}
                                </ButtonText>
                            </Button>
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
    );
};

export default OnboardingWizard;
