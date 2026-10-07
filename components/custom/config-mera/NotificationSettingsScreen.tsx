import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView } from '@/components/ui/scroll-view';
import { Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import NotificationTimes from './NotificationTimes';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { useColors } from '@/lib/theme/tokens';

/** Quiet period after the last change before the hours are saved. */
const AUTO_SAVE_DELAY_MS = 800;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface NotificationSettingsScreenProps {
    onBack?: () => void;
    isOnboarding?: boolean;
    onNext?: () => void;
    // Onboarding state sync
    initialHours?: number[];
    onHoursChange?: (hours: number[]) => void;
    /** Called whenever the on/off state settles (first launch's Next guard). */
    onEnabledChange?: (on: boolean) => void;
    /** A nonce: each new value runs this screen's own turn-on flow
     *  (permission, refusal, toasts), e.g. from the Next guard's Turn them on. */
    enableRequest?: number;
}

/**
 * Settings > Notifications, and the first onboarding step (same component,
 * `isOnboarding`). Two controls: the push switch, and when Mera may notify
 * (up to three times). Picked hours show three ways: dots on a decorative
 * 24-hour strip, removable pills, and the accent colour on the wheel. Tapping
 * a wheel row saves it; "Add a time" reopens the wheel.
 */
const NotificationSettingsScreen: React.FC<NotificationSettingsScreenProps> = ({
    onBack,
    isOnboarding = false,
    initialHours = [],
    onHoursChange,
    onEnabledChange,
    enableRequest,
}) => {
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(!isOnboarding);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [isEnabling, setIsEnabling] = useState(false);
    const [isDisabling, setIsDisabling] = useState(false);
    const [notificationsEnabled, setNotificationsEnabled] = useState(false);
    // The phone refused notifications for Mera: only phone settings can undo it.
    const [osRefused, setOsRefused] = useState(false);
    const [selectedHours, setSelectedHours] = useState<number[]>(initialHours);
    // The first status read has landed (before it, "off" is only a default).
    const [statusKnown, setStatusKnown] = useState(false);
    const colors = useColors();
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

    const readOsRefused = async (enabled: boolean) => {
        if (enabled) return;
        try {
            setOsRefused(await hasUserDeniedPermissions());
        } catch {
            // Unknown: show nothing rather than a wrong claim.
        }
    };

    const checkPushStatus = async () => {
        try {
            const userId = await getCurrentUserId();
            const userPersona = await AccountService.getUserPersona(userId);
            setNotificationsEnabled(!!userPersona?.notificationsEnabled);
            void readOsRefused(!!userPersona?.notificationsEnabled);
        } catch {
            // Silently handle
        } finally {
            setStatusKnown(true);
        }
    };

    const loadAllSettings = async () => {
        try {
            const userId = await getCurrentUserId();
            const userPersona = await AccountService.getUserPersona(userId);

            if (userPersona) {
                setNotificationsEnabled(!!userPersona.notificationsEnabled);
                void readOsRefused(!!userPersona.notificationsEnabled);

                if (userPersona.preferredNotificationWindow?.length > 0) {
                    const hours = convertUTCHoursToLocal(userPersona.preferredNotificationWindow).sort((a, b) => a - b);
                    setSelectedHours(hours);
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
            setStatusKnown(true);
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
                    setOsRefused(true);
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

            setOsRefused(false);
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
                        <ToastTitle>{t('notifications.setupFailedTitle')}</ToastTitle>
                        <ToastDescription>
                            {t('notifications.setupFailedDescription')}
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

    // Report every settled on/off state (not while a toggle is in flight).
    const onEnabledChangeRef = useRef(onEnabledChange);
    onEnabledChangeRef.current = onEnabledChange;
    useEffect(() => {
        if (statusKnown && !isEnabling && !isDisabling) onEnabledChangeRef.current?.(notificationsEnabled);
    }, [statusKnown, isEnabling, isDisabling, notificationsEnabled]);

    // A new nonce value asks for the turn-on flow; the first value is not a request.
    const lastEnableRequest = useRef(enableRequest);
    useEffect(() => {
        if (enableRequest === lastEnableRequest.current) return;
        lastEnableRequest.current = enableRequest;
        if (!notificationsEnabled && !isEnabling) void handleEnableNotifications();
        // handleEnableNotifications is re-created per render; the nonce alone triggers this.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enableRequest]);

    // ── Auto-save (preferences mode) ────────────────────────────────────
    //
    // The hours save on their own, AUTO_SAVE_DELAY_MS after the last change.
    // There used to be a "Save Preferences" button far below the toggle, and
    // leaving without pressing it silently dropped the change. A change still
    // pending when the screen closes is saved on the way out.
    const pendingHoursRef = useRef<number[] | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    const saveHours = useCallback(async (hours: number[]) => {
        pendingHoursRef.current = null;
        if (mountedRef.current) setSaveState('saving');
        try {
            const userId = await getCurrentUserId();
            await AccountService.updateNotificationPreferences(userId, convertLocalHoursToUTC(hours));
            if (mountedRef.current) setSaveState('saved');
        } catch {
            if (!mountedRef.current) return;
            setSaveState('error');
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('notifications.saveFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('notifications.saveFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        }
        // getCurrentUserId is a plain helper re-created per render; the save
        // must not be re-created (and the timer orphaned) on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            const pending = pendingHoursRef.current;
            if (pending && pending.length > 0) void saveHours(pending);
        };
    }, [saveHours]);

    const handleHoursChange = (hours: number[]) => {
        setSelectedHours(hours);
        onHoursChange?.(hours);
        if (isOnboarding || !notificationsEnabled) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        if (hours.length === 0) {
            // Nothing to save: an enabled notification needs at least one hour.
            // The zero-times line below says so.
            pendingHoursRef.current = null;
            setSaveState('idle');
            return;
        }
        pendingHoursRef.current = hours;
        setSaveState('idle');
        saveTimerRef.current = setTimeout(() => {
            void saveHours(hours);
        }, AUTO_SAVE_DELAY_MS);
    };

    const saveStatusLine = () => {
        if (saveState !== 'saving' && saveState !== 'saved') return null;
        return (
            <Text
                testID="notifications-save-status"
                size="sm"
                className="text-center"
                style={{ color: colors.ink3 }}
                accessibilityLiveRegion="polite"
            >
                {saveState === 'saving' ? t('common.saving') : t('notifications.savedInline')}
            </Text>
        );
    };

    const turnOnButton = () => (
        <VStack className="mx-4 mb-5" space="md">
            <Pressable
                testID="notifications-turn-on"
                onPress={() => {
                    if (!isEnabling) void handleEnableNotifications();
                }}
                accessibilityRole="button"
                accessibilityLabel={t('onboarding.turnOn')}
                accessibilityState={{ busy: isEnabling }}
                style={{ height: 48, borderRadius: 999, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}
            >
                {isEnabling ? (
                    <Spinner size="small" color={colors.onAccent} />
                ) : (
                    <Text style={{ color: colors.onAccent, fontSize: 16, fontWeight: '600' }}>{t('onboarding.turnOn')}</Text>
                )}
            </Pressable>
            {osRefused ? (
                <Text size="sm" style={{ color: colors.ink3 }}>
                    {t('notifications.permissionDenied')}
                </Text>
            ) : null}
        </VStack>
    );

    const pushRow = () => (
        <VStack className="mx-4 mb-5" space="md">
            <HStack
                className="items-center justify-between px-4 py-3"
                style={{
                    borderRadius: 14,
                    backgroundColor: colors.surface,
                    borderWidth: 1,
                    borderColor: colors.line,
                    minHeight: 52,
                }}
            >
                <Text className="text-base flex-1 mr-3" style={{ color: colors.ink }}>{t('you.notifications.push')}</Text>
                {(isEnabling || isDisabling) ? (
                    <Spinner size="small" />
                ) : (
                    <Switch
                        testID="notifications-push-switch"
                        accessibilityLabel={t('you.notifications.push')}
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
            {!notificationsEnabled && !osRefused ? (
                <Text size="sm" style={{ color: colors.ink3 }} testID="notifications-off-line">
                    {t('you.notifications.offLine')}
                </Text>
            ) : null}
            {/* Only when the PHONE refused: phone settings is the one way back. */}
            {!notificationsEnabled && osRefused ? (
                <VStack space="sm" testID="notifications-os-refused">
                    <Text size="sm" style={{ color: colors.ink3 }}>
                        {t('notifications.permissionDenied')}
                    </Text>
                    <Pressable
                        testID="notifications-open-device-settings"
                        onPress={() => Linking.openSettings()}
                        accessibilityRole="button"
                        accessibilityLabel={t('notifications.openDeviceSettings')}
                        className="self-start flex-row items-center rounded-full px-4"
                        style={{ minHeight: 44, borderWidth: 1, borderColor: colors.trackBorder }}
                    >
                        <Text size="sm" style={{ color: colors.ink }}>{t('notifications.openDeviceSettings')}</Text>
                    </Pressable>
                </VStack>
            ) : null}
        </VStack>
    );

    const hoursSection = () => (
        <VStack>
            <Text className="mx-4 mb-1 font-semibold" size="md" style={{ color: colors.ink }} accessibilityRole="header">
                {isOnboarding ? t('onboarding.notificationsOn') : t('you.notifications.when')}
            </Text>
            <NotificationTimes hours={selectedHours} onChange={handleHoursChange} />
            <Box className="mx-4" style={{ minHeight: 24 }}>{saveStatusLine()}</Box>
        </VStack>
    );

    const body = () => (
        <ScrollView
            testID="notifications-scroll"
            className="flex-1"
            contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 24 }}
            showsVerticalScrollIndicator={false}
        >
            {/* First launch: the wizard draws the title and the why. Off is one
                primary button; on drops straight into the times. */}
            {isOnboarding ? (notificationsEnabled ? null : turnOnButton()) : pushRow()}
            {notificationsEnabled ? hoursSection() : null}
        </ScrollView>
    );

    // Onboarding: no provider, no header, no backdrop. The wizard renders the
    // nav buttons (OnboardingNavBar).
    if (isOnboarding) {
        if (isLoading) {
            return (
                <VStack className="flex-1 justify-center items-center">
                    <Spinner size="large" />
                </VStack>
            );
        }
        return <Box className="flex-1">{body()}</Box>;
    }

    return (
        <GluestackUIProvider mode="dark">
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Box style={{ paddingTop: insets.top }}>
                    <DrillDownHeader title={t('notifications.title')} onBack={onBack} />
                </Box>

                {isLoading ? (
                    <VStack className="flex-1 justify-center items-center">
                        <Spinner size="large" />
                    </VStack>
                ) : (
                    body()
                )}
            </Box>
        </GluestackUIProvider>
    );
};

export default NotificationSettingsScreen;
