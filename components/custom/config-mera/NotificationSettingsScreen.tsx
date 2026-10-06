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
import { MaterialIcons } from '@expo/vector-icons';
import { getCalendars } from 'expo-localization';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView } from '@/components/ui/scroll-view';
import { Linking, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import NotificationHourWheel, { formatHourLabel } from '@/components/custom/NotificationHourWheel';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';

/** Quiet period after the last change before the hours are saved. */
const AUTO_SAVE_DELAY_MS = 800;

const ACCENT = '#E78A53';
const ACCENT_SOFT = '#F2BFA0';
const CARD = {
    borderRadius: 16,
    backgroundColor: 'rgba(40,39,42,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
} as const;
/** The picked-hour pill is 36pt; its remove control is a 44pt frame that
 *  bleeds 4pt above and below and 12pt each side of its 20pt glyph. */
const PILL_HEIGHT = 36;
const REMOVE_FRAME = 44;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface NotificationSettingsScreenProps {
    onBack?: () => void;
    isOnboarding?: boolean;
    onNext?: () => void;
    // Onboarding state sync
    initialHours?: number[];
    onHoursChange?: (hours: number[]) => void;
}

/** Where the wheel starts: 08:00 when it is free, else the first free hour
 *  after the latest pick, so "Add a time" is ready to use. */
export function initialCursorHour(picked: readonly number[]): number {
    if (!picked.includes(8)) return 8;
    const last = Math.max(...picked);
    for (let i = 1; i <= 24; i++) {
        const h = (last + i) % 24;
        if (!picked.includes(h)) return h;
    }
    return 8;
}

/** 24h vs AM/PM starts at the phone's own setting and is not stored. */
function deviceUses24h(): boolean {
    try {
        return getCalendars()[0]?.uses24hourClock !== false;
    } catch {
        return true;
    }
}

/**
 * Settings > Notifications, and the first onboarding step (same component,
 * `isOnboarding`). Two controls: the push switch, and when Mera may notify.
 * Picked hours show three ways: a decorative 24-hour strip, removable pills,
 * and the accent colour on the wheel. The wheel only moves a cursor; the add
 * button picks the outlined hour.
 */
const NotificationSettingsScreen: React.FC<NotificationSettingsScreenProps> = ({
    onBack,
    isOnboarding = false,
    initialHours = [],
    onHoursChange,
}) => {
    const { t, i18n } = useTranslation();
    const [isLoading, setIsLoading] = useState(!isOnboarding);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [isEnabling, setIsEnabling] = useState(false);
    const [isDisabling, setIsDisabling] = useState(false);
    const [notificationsEnabled, setNotificationsEnabled] = useState(false);
    // The phone refused notifications for Mera: only phone settings can undo it.
    const [osRefused, setOsRefused] = useState(false);
    const [selectedHours, setSelectedHours] = useState<number[]>(initialHours);
    const [cursorHour, setCursorHour] = useState(() => initialCursorHour(initialHours));
    const [use24h, setUse24h] = useState(deviceUses24h);
    const toast = useToast();
    const insets = useSafeAreaInsets();

    const format = useCallback(
        (h: number) => formatHourLabel(h, use24h, i18n?.language),
        [use24h, i18n?.language],
    );

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
                    setCursorHour(initialCursorHour(hours));
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

    const cursorPicked = selectedHours.includes(cursorHour);
    const addCursorHour = () => {
        if (cursorPicked) return;
        handleHoursChange([...selectedHours, cursorHour].sort((a, b) => a - b));
    };
    const removeHour = (hour: number) => handleHoursChange(selectedHours.filter((h) => h !== hour));

    const saveStatusLine = () => {
        if (saveState !== 'saving' && saveState !== 'saved') return null;
        return (
            <Text
                testID="notifications-save-status"
                size="sm"
                className="text-gray-400 text-center"
                accessibilityLiveRegion="polite"
            >
                {saveState === 'saving' ? t('common.saving') : t('notifications.savedInline')}
            </Text>
        );
    };

    const pushRow = () => (
        <VStack className="mx-4 mb-5" space="md">
            <HStack
                className="items-center justify-between px-4 py-3"
                style={{
                    borderRadius: 14,
                    backgroundColor: 'rgba(255,255,255,0.07)',
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.10)',
                    minHeight: 52,
                }}
            >
                <Text className="text-white text-base flex-1 mr-3">{t('you.notifications.push')}</Text>
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
            {/* Only when the PHONE refused: phone settings is the one way back. */}
            {!notificationsEnabled && osRefused ? (
                <VStack space="sm" testID="notifications-os-refused">
                    <Text size="sm" className="text-gray-400">
                        {t('notifications.permissionDenied')}
                    </Text>
                    <Pressable
                        testID="notifications-open-device-settings"
                        onPress={() => Linking.openSettings()}
                        accessibilityRole="button"
                        accessibilityLabel={t('notifications.openDeviceSettings')}
                        className="self-start flex-row items-center rounded-full border border-gray-600 px-4"
                        style={{ minHeight: 44 }}
                    >
                        <Text size="sm" className="text-white">{t('notifications.openDeviceSettings')}</Text>
                    </Pressable>
                </VStack>
            ) : null}
        </VStack>
    );

    const formatToggle = () => (
        <HStack
            className="items-center"
            style={{ borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.08)', padding: 3 }}
            accessibilityRole="radiogroup"
        >
            {[true, false].map((is24) => {
                const active = use24h === is24;
                const label = is24 ? t('notifications.format24h') : t('notifications.formatAmPm');
                return (
                    <Pressable
                        key={label}
                        testID={is24 ? 'notifications-format-24h' : 'notifications-format-ampm'}
                        onPress={() => setUse24h(is24)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: active, checked: active }}
                        accessibilityLabel={label}
                        // 44pt frame around a 28pt segment.
                        style={{ height: 44, marginVertical: -8, justifyContent: 'center' }}
                    >
                        <View
                            style={{
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                borderRadius: 999,
                                backgroundColor: active ? ACCENT : 'transparent',
                            }}
                        >
                            <Text
                                size="xs"
                                scaleTier="chrome"
                                style={{ color: active ? '#121113' : '#D4D4D4', fontWeight: active ? '600' : '400' }}
                            >
                                {label}
                            </Text>
                        </View>
                    </Pressable>
                );
            })}
        </HStack>
    );

    // Decorative: the pills below carry the same information to a screen reader.
    const hourStrip = () => {
        const ticks = [0, 6, 12, 18];
        const labels = [...ticks, ...selectedHours.filter((h) => ticks.every((tk) => Math.abs(tk - h) >= 2))];
        return (
            <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                className="mx-4 mb-3"
                style={{ ...CARD, paddingTop: 14, paddingHorizontal: 14, paddingBottom: 10 }}
            >
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 22, gap: 2 }}>
                    {Array.from({ length: 24 }, (_, h) => {
                        const picked = selectedHours.includes(h);
                        return (
                            <View
                                key={h}
                                style={{
                                    flex: 1,
                                    height: picked ? 22 : 8,
                                    borderRadius: picked ? 3 : 2,
                                    backgroundColor: picked ? ACCENT : 'rgba(255,255,255,0.14)',
                                }}
                            />
                        );
                    })}
                </View>
                <View style={{ height: 16, marginTop: 4 }}>
                    {labels.map((h) => (
                        <Text
                            key={h}
                            size="2xs"
                            scaleTier="locked"
                            style={{
                                position: 'absolute',
                                left: `${(h / 24) * 100}%`,
                                color: selectedHours.includes(h) ? ACCENT_SOFT : '#A3A3A3',
                                fontWeight: selectedHours.includes(h) ? '700' : '400',
                            }}
                        >
                            {use24h ? h.toString().padStart(2, '0') : format(h)}
                        </Text>
                    ))}
                </View>
            </View>
        );
    };

    const pills = () => (
        <View className="mx-4 mb-3" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {selectedHours.map((h) => (
                <View
                    key={h}
                    testID={`notifications-pill-${h}`}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        height: PILL_HEIGHT,
                        marginVertical: (REMOVE_FRAME - PILL_HEIGHT) / 2,
                        paddingLeft: 14,
                        borderRadius: 999,
                        backgroundColor: 'rgba(40,39,42,0.82)',
                        borderWidth: 1,
                        borderColor: 'rgba(255,255,255,0.14)',
                    }}
                >
                    <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '600' }}>{format(h)}</Text>
                    <Pressable
                        testID={`notifications-pill-remove-${h}`}
                        onPress={() => removeHour(h)}
                        accessibilityRole="button"
                        accessibilityLabel={t('you.notifications.remove', { time: format(h) })}
                        style={{
                            width: REMOVE_FRAME,
                            height: REMOVE_FRAME,
                            marginVertical: -(REMOVE_FRAME - PILL_HEIGHT) / 2,
                            marginLeft: 6 - (REMOVE_FRAME - 20) / 2,
                            marginRight: 8 - (REMOVE_FRAME - 20) / 2,
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <View
                            style={{
                                width: 20,
                                height: 20,
                                borderRadius: 10,
                                backgroundColor: 'rgba(255,255,255,0.16)',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <MaterialIcons name="close" size={14} color="#ffffff" />
                        </View>
                    </Pressable>
                </View>
            ))}
            <Pressable
                testID="notifications-add-time"
                onPress={addCursorHour}
                accessibilityRole="button"
                accessibilityLabel={
                    cursorPicked
                        ? t('you.notifications.alreadyPicked', { time: format(cursorHour) })
                        : t('you.notifications.addHour', { time: format(cursorHour) })
                }
                style={{ height: REMOVE_FRAME, justifyContent: 'center' }}
            >
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        height: PILL_HEIGHT,
                        paddingHorizontal: 14,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderStyle: 'dashed',
                        borderColor: 'rgba(231,138,83,0.8)',
                    }}
                >
                    {cursorPicked ? null : <MaterialIcons name="add" size={16} color={ACCENT_SOFT} />}
                    <Text style={{ color: ACCENT_SOFT, fontSize: 14, fontWeight: '600', marginLeft: cursorPicked ? 0 : 4 }}>
                        {cursorPicked
                            ? t('you.notifications.alreadyPicked', { time: format(cursorHour) })
                            : t('you.notifications.add')}
                    </Text>
                </View>
            </Pressable>
        </View>
    );

    const hoursSection = () => {
        const none = selectedHours.length === 0;
        return (
            <VStack>
                <Text className="mx-4 mb-1 text-white font-semibold" size="md" accessibilityRole="header">
                    {t('you.notifications.when')}
                </Text>
                {isOnboarding ? (
                    <VStack className="mx-4 mb-2" space="xs">
                        <Text size="sm" className="text-gray-400">{t('notifications.timeDescriptionOnboarding')}</Text>
                        <Text size="sm" className="text-typography-500">{t('notifications.timeNudge')}</Text>
                    </VStack>
                ) : null}
                <HStack className="mx-4 mb-2 items-center justify-between">
                    <Text size="xs" className="text-gray-400">
                        {none ? t('you.notifications.noneYet') : t('you.notifications.yourTimes')}
                    </Text>
                    {formatToggle()}
                </HStack>
                {none ? (
                    <Text
                        testID="notifications-zero-times"
                        size="sm"
                        className="mx-4 mb-3 text-amber-400"
                        accessibilityLiveRegion="polite"
                    >
                        {t('you.notifications.zeroTimes')}
                    </Text>
                ) : null}
                {hourStrip()}
                {none ? null : pills()}
                <View className="mx-4 mb-3" style={{ ...CARD, borderRadius: 18, paddingVertical: 6 }}>
                    <NotificationHourWheel
                        cursorHour={cursorHour}
                        onCursorChange={setCursorHour}
                        pickedHours={selectedHours}
                        format={format}
                        accessibilityLabel={t('you.notifications.wheel')}
                    />
                </View>
                {none ? (
                    // First pick: one obvious button for the outlined hour.
                    <Pressable
                        testID="notifications-add-first"
                        onPress={addCursorHour}
                        accessibilityRole="button"
                        accessibilityLabel={t('you.notifications.addHour', { time: format(cursorHour) })}
                        className="mx-4 mb-3 items-center justify-center rounded-full"
                        style={{ minHeight: 44, backgroundColor: ACCENT }}
                    >
                        <Text style={{ color: '#121113', fontWeight: '700', fontSize: 15 }}>
                            {t('you.notifications.addHour', { time: format(cursorHour) })}
                        </Text>
                    </Pressable>
                ) : null}
                <Text size="xs" className="mx-4 mb-2 text-gray-400">
                    {t('you.notifications.footnote')}
                </Text>
                <Box className="mx-4" style={{ minHeight: 24 }}>{saveStatusLine()}</Box>
            </VStack>
        );
    };

    const body = () => (
        <ScrollView
            testID="notifications-scroll"
            className="flex-1"
            contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 24 }}
            showsVerticalScrollIndicator={false}
        >
            {isOnboarding ? (
                <VStack className="mx-5 mb-6">
                    <Text className="text-3xl font-bold text-white text-center mb-3">
                        {t('notifications.title')}
                    </Text>
                    <Text className="text-base text-typography-400 text-center">
                        {t('notifications.enableDescription')}
                    </Text>
                </VStack>
            ) : null}
            {pushRow()}
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
