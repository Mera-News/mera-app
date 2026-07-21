import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { MaterialIcons } from '@expo/vector-icons';
import { View } from 'react-native';

import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ModelDownloadBanner from '@/components/custom/ModelDownloadBanner';
import { useTranslation } from 'react-i18next';

// Foreground polling, AppState listening, and recoverCycle calls have moved
// to AppScheduler (lib/scheduler/AppScheduler.ts) and its registered tasks:
//   - feed-sync-task.ts   — syncs the feed on a 60-second cadence + foreground
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
    // trigger (`feed`) is the one selected on first mount (the landing tab), with
    // `for_you` (now the "Dashboard") second.
    return (
        <View style={{ flex: 1, backgroundColor: '#000' }}>
            <ErrorBoundary
                level="screen"
                FallbackComponent={FullScreenErrorFallback}
            >
                {/* Icons-only navbar: every `<Label hidden>` keeps the tab's
                    accessibility title (the string children) while suppressing the
                    visible caption. `hidden` on NativeTabsTriggerLabelProps is the
                    supported cross-platform mechanism (iOS + Android). */}
                <NativeTabs tintColor={ACCENT} minimizeBehavior="onScrollDown">
                    {/* Deck (route `feed`) — the buttons-first swipe deck, landing tab. */}
                    <NativeTabs.Trigger name="feed">
                        <Label hidden>{t('tabs.deck')}</Label>
                        <Icon
                            sf="house.fill"
                            src={<VectorIcon family={MaterialIcons} name="home" />}
                        />
                    </NativeTabs.Trigger>
                    {/* Dashboard (route `for_you`). */}
                    <NativeTabs.Trigger name="for_you">
                        <Label hidden>{t('tabs.dashboard')}</Label>
                        <Icon
                            sf="square.grid.2x2.fill"
                            src={<VectorIcon family={MaterialIcons} name="dashboard" />}
                        />
                    </NativeTabs.Trigger>
                    {/* Explore (route `around`). */}
                    <NativeTabs.Trigger name="around">
                        <Label hidden>{t('tabs.around')}</Label>
                        <Icon
                            sf="safari.fill"
                            src={<VectorIcon family={MaterialIcons} name="explore" />}
                        />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="profile">
                        <Label hidden>{t('tabs.profile')}</Label>
                        <Icon
                            sf="person.fill"
                            src={<VectorIcon family={MaterialIcons} name="person" />}
                        />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="settings">
                        <Label hidden>{t('tabs.settings')}</Label>
                        <Icon
                            sf="gearshape.fill"
                            src={<VectorIcon family={MaterialIcons} name="settings" />}
                        />
                    </NativeTabs.Trigger>
                </NativeTabs>
            </ErrorBoundary>
            {/* The shared notification bell overlay is gone (app-rethink wave) —
                For You and Explore each render an inline NotificationBellButton
                in their own header row; Profile and Settings have none. */}
            <ModelDownloadBanner />
        </View>
    );
}
