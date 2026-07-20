import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { MaterialIcons } from '@expo/vector-icons';
import { View } from 'react-native';

import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ModelDownloadBanner from '@/components/custom/ModelDownloadBanner';
import NotificationBellOverlay from '@/components/custom/notifications/NotificationBellOverlay';
import { useTranslation } from 'react-i18next';

// Foreground polling, AppState listening, and recoverCycle calls have moved
// to AppScheduler (lib/scheduler/AppScheduler.ts) and its registered tasks:
//   - feed-sync-task.ts   — syncs the feed on a 5-minute cadence + foreground
//   - inference-recover-task.ts — calls recoverCycle on foreground

// House dark-mode accent (components/ui/gluestack-ui-provider/config.ts dark
// palette): primary-400 = rgb(231, 138, 83). Applied as the NativeTabs
// `tintColor` so the selected tab picks up the app accent; everything else
// (blur/liquid-glass on iOS 26, Material on Android) is left to the native
// appearance — no custom tabBarStyle.
const ACCENT = 'rgb(231, 138, 83)';

const { Icon, Label, VectorIcon } = NativeTabs.Trigger;

export default function AppLayout() {
    const { t } = useTranslation();

    // Trigger order defines both the tab order AND the initial route — the first
    // trigger (`browse`) is the one selected on first mount, replacing the old
    // JS-Tabs `initialRouteName="browse"`.
    return (
        <View style={{ flex: 1, backgroundColor: '#000' }}>
            <ErrorBoundary
                level="screen"
                FallbackComponent={FullScreenErrorFallback}
            >
                <NativeTabs tintColor={ACCENT}>
                    {/* Browse (swipe deck) — the app's initial route. */}
                    <NativeTabs.Trigger name="browse">
                        <Label>{t('tabs.browse')}</Label>
                        <Icon
                            sf="square.stack"
                            src={<VectorIcon family={MaterialIcons} name="style" />}
                        />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="for_you">
                        <Label>{t('tabs.forYou')}</Label>
                        <Icon
                            sf="house.fill"
                            src={<VectorIcon family={MaterialIcons} name="home" />}
                        />
                    </NativeTabs.Trigger>
                    {/* Explore (route `around`). */}
                    <NativeTabs.Trigger name="around">
                        <Label>{t('tabs.around')}</Label>
                        <Icon
                            sf="safari.fill"
                            src={<VectorIcon family={MaterialIcons} name="explore" />}
                        />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="profile">
                        <Label>{t('tabs.profile')}</Label>
                        <Icon
                            sf="person.fill"
                            src={<VectorIcon family={MaterialIcons} name="person" />}
                        />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="settings">
                        <Label>{t('tabs.settings')}</Label>
                        <Icon
                            sf="gearshape.fill"
                            src={<VectorIcon family={MaterialIcons} name="settings" />}
                        />
                    </NativeTabs.Trigger>
                </NativeTabs>
            </ErrorBoundary>
            {/* Shared notification bell — absolutely positioned top-right, above
                all 5 tab screens (same position on every tab). */}
            <NotificationBellOverlay />
            <ModelDownloadBanner />
        </View>
    );
}
