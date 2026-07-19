import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { AccountService } from '@/lib/account-service';
import { authClient } from '@/lib/auth-client';
import { hasUserDeniedPermissions, setVisibleNotificationsEnabled } from '@/lib/notification-service';
import { convertLocalHoursToUTC, convertUTCHoursToLocal } from '@/lib/notificationSlotUtils';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Linking, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import NotificationHourWheel from '@/components/custom/NotificationHourWheel';

interface NotificationSettingsScreenProps {
    onBack?: () => void;
    isOnboarding?: boolean;
    onNext?: () => void;
    // Onboarding state sync
    initialHours?: number[];
    onHoursChange?: (hours: number[]) => void;
}

const NotificationSettingsScreen: React.FC<NotificationSettingsScreenProps> = ({
    onBack,
    isOnboarding = false,
    onNext,
    initialHours = [],
    onHoursChange,
}) => {
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(!isOnboarding);
    const [isSaving, setIsSaving] = useState(false);
    const [isEnabling, setIsEnabling] = useState(false);
    const [isDisabling, setIsDisabling] = useState(false);
    const [notificationsEnabled, setNotificationsEnabled] = useState(false);
    const [selectedHours, setSelectedHours] = useState<number[]>(initialHours);
    const [use24h, setUse24h] = useState(false);
    const toast = useToast();
    const insets = useSafeAreaInsets();

    // Load all notification settings on mount (preferences mode only)
    useEffect(() => {
        if (isOnboarding) {
            checkPushStatus();
            return;
        }
        loadAllSettings();
        // Run-once-on-mount branch keyed by isOnboarding; the loader/status
        // helpers are stable and excluded to keep this a mount-time effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOnboarding]);

    const getCurrentUserId = async (): Promise<string> => {
        const sessionData = await authClient.getSession();
        if (!sessionData?.data?.user?.id) {
            throw new Error('User not authenticated');
        }
        return sessionData.data.user.id;
    };

    const checkPushStatus = async () => {
        try {
            const userId = await getCurrentUserId();
            const userPersona = await AccountService.getUserPersona(userId);
            setNotificationsEnabled(!!userPersona?.notificationsEnabled);
        } catch {
            // Silently handle
        }
    };

    const loadAllSettings = async () => {
        try {
            const userId = await getCurrentUserId();
            const userPersona = await AccountService.getUserPersona(userId);

            if (userPersona) {
                setNotificationsEnabled(!!userPersona.notificationsEnabled);

                if (userPersona.preferredNotificationWindow?.length > 0) {
                    setSelectedHours(
                        convertUTCHoursToLocal(userPersona.preferredNotificationWindow).sort((a, b) => a - b)
                    );
                }
            }
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('notifications.loadFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('notifications.loadFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsLoading(false);
        }
    };

    // Toggle user-visible notifications. The Expo push token lifecycle is
    // separate — handled at app boot by ensurePushTokenRegistered and kept
    // registered regardless of this flag so silent result-ready pushes still
    // deliver.
    const handleEnableNotifications = async () => {
        setIsEnabling(true);
        try {
            const userId = await getCurrentUserId();
            const wasPreviouslyDenied = await hasUserDeniedPermissions();
            const success = await setVisibleNotificationsEnabled(userId, true);

            if (!success) {
                const isDeniedNow = await hasUserDeniedPermissions();
                if (isDeniedNow || wasPreviouslyDenied) {
                    toast.show({
                        placement: 'top',
                        render: () => (
                            <Toast action="error" variant="solid">
                                <ToastTitle>{t('notifications.permissionRequiredTitle')}</ToastTitle>
                                <ToastDescription>
                                    {t('notifications.permissionRequiredDescription')}
                                </ToastDescription>
                            </Toast>
                        ),
                    });
                } else {
                    toast.show({
                        placement: 'top',
                        render: () => (
                            <Toast action="error" variant="solid">
                                <ToastTitle>{t('notifications.setupFailedTitle')}</ToastTitle>
                                <ToastDescription>
                                    {t('notifications.setupFailedDescription')}
                                </ToastDescription>
                            </Toast>
                        ),
                    });
                }
                return;
            }

            setNotificationsEnabled(true);

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('notifications.enabledTitle')}</ToastTitle>
                        <ToastDescription>
                            {t('notifications.enabledDescription')}
                        </ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>Setup Failed</ToastTitle>
                        <ToastDescription>
                            Failed to enable notifications. Please try again.
                        </ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsEnabling(false);
        }
    };

    const handleDisableNotifications = async () => {
        setIsDisabling(true);
        try {
            const userId = await getCurrentUserId();
            await setVisibleNotificationsEnabled(userId, false);
            setNotificationsEnabled(false);

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('notifications.disabledTitle')}</ToastTitle>
                        <ToastDescription>
                            {t('notifications.disabledDescription')}
                        </ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('notifications.updateFailedTitle')}</ToastTitle>
                        <ToastDescription>
                            {t('notifications.updateFailedDescription')}
                        </ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsDisabling(false);
        }
    };

    // Hours change handler - sync with parent in onboarding mode
    const handleHoursChange = (hours: number[]) => {
        setSelectedHours(hours);
        onHoursChange?.(hours);
    };

    // Save preferences (preferences mode only - saves hours)
    const handleSave = async () => {
        if (notificationsEnabled && selectedHours.length === 0) {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('notifications.selectionRequiredTitle')}</ToastTitle>
                        <ToastDescription>{t('notifications.selectionRequiredDescription')}</ToastDescription>
                    </Toast>
                ),
            });
            return;
        }

        setIsSaving(true);
        try {
            const userId = await getCurrentUserId();

            if (notificationsEnabled) {
                const utcHours = convertLocalHoursToUTC(selectedHours);
                await AccountService.updateNotificationPreferences(userId, utcHours);
            }

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('notifications.savedTitle')}</ToastTitle>
                        <ToastDescription>{t('notifications.savedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('notifications.saveFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('notifications.saveFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsSaving(false);
        }
    };

    // Header: onboarding hero (onboarding mode only) + push toggle row +
    // device-settings CTA (preferences mode, disabled state).
    const renderHeader = () => (
        <Box className="px-5 mb-6">
            {isOnboarding && (
                <VStack className="mb-8">
                    <Text className="text-3xl font-bold text-white text-center mb-3">
                        {t('notifications.title')}
                    </Text>
                    <Text className="text-base text-typography-400 text-center leading-6">
                        {t('notifications.enableDescription')}
                    </Text>
                </VStack>
            )}

            {/* Push Toggle Row */}
            <HStack space="md" className="items-center justify-between">
                <HStack space="md" className="items-center flex-1">
                    <MaterialIcons
                        name={notificationsEnabled ? "notifications-active" : "notifications-off"}
                        size={24}
                        color={notificationsEnabled ? "#10b981" : "#9ca3af"}
                    />
                    <VStack>
                        <Text className="text-white text-lg font-semibold">
                            {t('notifications.pushNotifications')}
                        </Text>
                        {!isOnboarding && (
                            <Text className="text-typography-500 text-sm mt-0.5">
                                {notificationsEnabled ? t('notifications.receivingUpdates') : t('notifications.disabled')}
                            </Text>
                        )}
                    </VStack>
                </HStack>

                {(isEnabling || isDisabling) ? (
                    <Spinner size="small" />
                ) : (
                    <Switch
                        value={notificationsEnabled}
                        onToggle={() => {
                            if (notificationsEnabled) {
                                handleDisableNotifications();
                            } else {
                                handleEnableNotifications();
                            }
                        }}
                        size="md"
                    />
                )}
            </HStack>

            {/* Device Settings Note - preferences mode only, when disabled */}
            {!notificationsEnabled && !isOnboarding && (
                <Box className="mt-4">
                    <Box className="p-4 bg-background-50 rounded-lg border border-background-100 mb-3">
                        <Text className="text-typography-400 text-sm leading-5">
                            <MaterialIcons name="info-outline" size={16} color="#9ca3af" /> {t('notifications.permissionDenied')}
                        </Text>
                    </Box>
                    <Button
                        action="secondary"
                        variant="outline"
                        size="md"
                        onPress={() => Linking.openSettings()}
                    >
                        <MaterialIcons name="settings" size={18} color="#9ca3af" style={{ marginRight: 8 }} />
                        <ButtonText>{t('notifications.openDeviceSettings')}</ButtonText>
                    </Button>
                </Box>
            )}
        </Box>
    );

    // Time section header: title + description only. AM/PM toggle and counter
    // are rendered next to the wheel (renderWheelWithSidebar).
    const renderTimeSectionHeader = () => (
        <Box className="px-5 mb-2">
            <Text className="text-white text-lg font-semibold mb-2">
                {t('notifications.timeTitle')}
            </Text>
            <Text size="md" className="text-gray-400 leading-6">
                {t('notifications.timeDescription')}
            </Text>
        </Box>
    );

    // Wheel + right-side column with AM/PM toggle and selected counter,
    // vertically centered to the middle of the wheel.
    const renderWheelWithSidebar = (wheelHeight?: number) => (
        <HStack className="flex-1 items-center px-5">
            <VStack className="flex-1 items-center">
                <Text size="sm" className="text-typography-500">
                    Selected
                </Text>
                <Text size="md" className="text-white font-semibold">
                    {selectedHours.length}
                </Text>
            </VStack>
            <Box style={{ width: 64, alignSelf: 'stretch' }}>
                <NotificationHourWheel
                    selectedHours={selectedHours}
                    onHoursChange={handleHoursChange}
                    maxHours={24}
                    showCounter={false}
                    use24h={use24h}
                    height={wheelHeight}
                />
            </Box>
            <HStack className="flex-1 items-center justify-center"><HStack className="bg-gray-900 rounded-full p-0.5">
                <Pressable
                    onPress={() => setUse24h(true)}
                    className={`px-3 py-1.5 rounded-full ${use24h ? 'bg-gray-700' : 'bg-transparent'}`}
                >
                    <Text size="xs" className={`font-medium ${use24h ? 'text-white' : 'text-gray-500'}`}>
                        {t('notifications.format24h')}
                    </Text>
                </Pressable>
                <Pressable
                    onPress={() => setUse24h(false)}
                    className={`px-3 py-1.5 rounded-full ${!use24h ? 'bg-gray-700' : 'bg-transparent'}`}
                >
                    <Text size="xs" className={`font-medium ${!use24h ? 'text-white' : 'text-gray-500'}`}>
                        {t('notifications.formatAmPm')}
                    </Text>
                </Pressable>
            </HStack>
            </HStack>
        </HStack>
    );

    // Loading state
    if (isLoading) {
        if (isOnboarding) {
            return (
                <VStack className="flex-1 justify-center items-center">
                    <Spinner size="large" />
                </VStack>
            );
        }
        return (
            <GluestackUIProvider mode="dark">
                <Box className="flex-1 bg-black">
                    {onBack && (
                        <Box style={{ position: 'absolute', top: insets.top + 16, left: 16, zIndex: 20 }}>
                            <Pressable
                                onPress={onBack}
                                className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                            >
                                <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                            </Pressable>
                        </Box>
                    )}
                    <VStack className="px-5 pb-5" style={{ paddingTop: insets.top + 16 }}>
                        <Text className="text-xl font-semibold text-white text-center">{t('notifications.title')}</Text>
                    </VStack>
                    <VStack className="flex-1 justify-center items-center">
                        <Spinner size="large" />
                    </VStack>
                </Box>
            </GluestackUIProvider>
        );
    }

    // Onboarding mode - no GluestackUIProvider wrapper, no header
    // Nav buttons (Back/Next) are rendered by the wizard's OnboardingNavBar
    if (isOnboarding) {
        return (
            <Box className="flex-1">
                {renderHeader()}
                {notificationsEnabled && (
                    <>
                        <Box className="mx-5 mb-4 border-b border-gray-800" />
                        {renderTimeSectionHeader()}
                        {renderWheelWithSidebar()}
                    </>
                )}
            </Box>
        );
    }

    // Preferences mode - full screen layout with GluestackUIProvider.
    // When notifications are enabled, the wheel takes flex:1 between the
    // toggle row and the save button (no outer ScrollView). When disabled,
    // the outer ScrollView is kept so the "Open Device Settings" CTA scrolls.
    return (
        <GluestackUIProvider mode="dark">
            <Box className="flex-1 bg-black">
                {/* Floating Back Button */}
                {onBack && (
                    <Box style={{ position: 'absolute', top: insets.top + 16, left: 16, zIndex: 20 }}>
                        <Pressable
                            onPress={onBack}
                            className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                        >
                            <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                        </Pressable>
                    </Box>
                )}

                {/* Header */}
                <VStack className="px-5 pb-5" style={{ paddingTop: insets.top + 16 }}>
                    <Text className="text-xl font-semibold text-white text-center">{t('notifications.title')}</Text>
                </VStack>

                {notificationsEnabled ? (
                    <Box className="flex-1 pt-1">
                        {renderHeader()}
                        <Box className="mx-5 mb-4 border-b border-gray-800" />
                        {renderTimeSectionHeader()}
                        {renderWheelWithSidebar()}
                    </Box>
                ) : (
                    <ScrollView className="flex-1 pt-1">
                        {renderHeader()}
                    </ScrollView>
                )}

                {/* Save Button */}
                <VStack className="px-5" style={{ paddingBottom: insets.bottom + 32 }}>
                    <Button
                        action="primary"
                        variant="solid"
                        size="lg"
                        onPress={handleSave}
                        disabled={isSaving}
                        className="w-full"
                    >
                        <ButtonText>{isSaving ? t('common.saving') : t('notifications.savePreferences')}</ButtonText>
                    </Button>
                </VStack>
            </Box>
        </GluestackUIProvider>
    );
};

export default NotificationSettingsScreen;
