import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { AccountService } from '@/lib/account-service';
import { hasUserDeniedPermissions, setVisibleNotificationsEnabled } from '@/lib/notification-service';
import { convertLocalHoursToUTC, convertUTCHoursToLocal } from '@/lib/notificationSlotUtils';
import { resolveCurrentUserId } from '@/lib/security/current-user';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Quiet period after the last change before the hours are saved. */
const AUTO_SAVE_DELAY_MS = 800;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface UseNotificationSettingsOptions {
    isOnboarding: boolean;
    initialHours: number[];
    onHoursChange?: (hours: number[]) => void;
    onEnabledChange?: (on: boolean) => void;
    enableRequest?: number;
    toast: ReturnType<typeof useToast>;
}

export function useNotificationSettings({
    isOnboarding,
    initialHours,
    onHoursChange,
    onEnabledChange,
    enableRequest,
    toast,
}: UseNotificationSettingsOptions) {
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
            const userId = await resolveCurrentUserId();
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
            const userId = await resolveCurrentUserId();
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
            const userId = await resolveCurrentUserId();
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
            const userId = await resolveCurrentUserId();
            const ok = await setVisibleNotificationsEnabled(userId, false);
            if (!ok) throw new Error('disable failed');
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
            const userId = await resolveCurrentUserId();
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
        // toast and t stay out of the deps on purpose: the save must not be
        // re-created (and its timer orphaned) on every render.
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

    return {
        isLoading,
        saveState,
        isEnabling,
        isDisabling,
        notificationsEnabled,
        osRefused,
        selectedHours,
        handleEnableNotifications,
        handleDisableNotifications,
        handleHoursChange,
    };
}
