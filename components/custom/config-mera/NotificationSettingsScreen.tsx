import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import React from 'react';
import { ScrollView } from '@/components/ui/scroll-view';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import NotificationTimes from './NotificationTimes';
import { useNotificationSettings } from './useNotificationSettings';
import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';
import { useColors } from '@/lib/theme/tokens';
import { useListEndClearance, useTabContentBottomInset } from '@/lib/navigation/tab-bar';


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
 * (any number of hours, `NotificationTimes`: the multi-select wheel with the
 * Selected count and the 24h | AM/PM toggle beside it).
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
    const colors = useColors();
    const toast = useToast();
    const insets = useSafeAreaInsets();
    const bottomInset = useTabContentBottomInset();
    const endClearance = useListEndClearance();
    const {
        isLoading,
        saveState,
        isEnabling,
        isDisabling,
        notificationsEnabled,
        osRefused,
        selectedHours,
        handleEnableNotifications,
        openDeviceSettings,
        handleDisableNotifications,
        handleHoursChange,
    } = useNotificationSettings({
        isOnboarding,
        initialHours,
        onHoursChange,
        onEnabledChange,
        enableRequest,
        toast,
    });

    const saveStatusLine = () => {
        // Nothing picked: the server takes no empty list, so say what to do.
        if (selectedHours.length === 0) {
            return (
                <Text
                    testID="notifications-zero-times"
                    size="sm"
                    className="text-center"
                    style={{ color: colors.warning }}
                    accessibilityLiveRegion="polite"
                >
                    {t('you.notifications.zeroTimes')}
                </Text>
            );
        }
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
                        onPress={openDeviceSettings}
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

    // On: the wheel is a vertical list, so the page does not scroll around it.
    // It takes the height left between the heading and the save line and
    // shrinks first, so the wizard's Next and the tab bar stay clear.
    const enabledBody = () => (
        <View
            style={{
                flex: 1,
                minHeight: 0,
                paddingTop: SUBPAGE_TOP_GAP,
                paddingBottom: isOnboarding ? 8 : bottomInset,
            }}
        >
            {isOnboarding ? null : pushRow()}
            <Text className="mx-4 mb-2 font-semibold" size="md" style={{ color: colors.ink }} accessibilityRole="header">
                {isOnboarding ? t('onboarding.notificationsOn') : t('you.notifications.when')}
            </Text>
            <NotificationTimes hours={selectedHours} onChange={handleHoursChange} />
            <Box className="mx-4 mt-2" style={{ minHeight: 24 }}>{saveStatusLine()}</Box>
        </View>
    );

    const body = () => notificationsEnabled ? enabledBody() : (
        <ScrollView
            testID="notifications-scroll"
            className="flex-1"
            contentContainerStyle={{ paddingTop: SUBPAGE_TOP_GAP, paddingBottom: endClearance }}
            showsVerticalScrollIndicator={false}
        >
            {/* First launch: the wizard draws the title and the why. Off is one
                primary button. */}
            {isOnboarding ? turnOnButton() : pushRow()}
        </ScrollView>
    );

    // Onboarding: no provider, no header, no backdrop. The wizard draws its
    // own title and buttons.
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
        <GluestackUIProvider>
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
