import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ModelDownloadBanner from '@/components/custom/ModelDownloadBanner';
import TabsTooltipStrip from '@/components/custom/tabs/TabsTooltipStrip';
import { toastManager } from '@/lib/toast-manager';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';

// Foreground polling, AppState listening, and recoverCycle calls have moved
// to AppScheduler (lib/scheduler/AppScheduler.ts) and its registered tasks:
//   - feed-sync-task.ts   — syncs the feed on a 5-minute cadence + foreground
//   - inference-recover-task.ts — calls recoverCycle on foreground

// House dark-mode tokens (components/ui/gluestack-ui-provider/config.ts dark
// palette): primary-400 = rgb(231, 138, 83) (accent), typography-500 = rgb(163,
// 163, 163) (muted inactive), border matches the app's black/gray-800 chrome
// used elsewhere (DrillDownHeader, Stack contentStyle).
const ACCENT = 'rgb(231, 138, 83)';
const INACTIVE = 'rgb(163, 163, 163)';
const BAR_BACKGROUND = '#000000';
const BAR_BORDER = '#1f2937'; // gray-800

type TabIconName = 'browse' | 'for_you' | 'around' | 'profile' | 'settings';

const TAB_ICON: Record<TabIconName, keyof typeof MaterialIcons.glyphMap> = {
    browse: 'style',
    for_you: 'home',
    around: 'explore',
    profile: 'person',
    settings: 'settings',
};

// i18n keys for tabBarAccessibilityLabel + the long-press name toast.
// `as const satisfies` keeps the values as literal string types (rather than
// widened to `string`) so they type-check against react-i18next's typed `t()`
// keys (lib/i18n/types.ts) — see components/custom/floating-chat/FactCard.tsx
// for the same pattern.
const TAB_LABEL_KEY = {
    browse: 'tabs.browse',
    for_you: 'tabs.forYou',
    around: 'tabs.around',
    profile: 'tabs.profile',
    settings: 'tabs.settings',
} as const satisfies Record<TabIconName, string>;

function tabIcon(name: TabIconName) {
    function TabBarIcon({ color, size }: { color: string; size: number }) {
        return <MaterialIcons name={TAB_ICON[name]} size={size} color={color} />;
    }
    return TabBarIcon;
}

export default function AppLayout() {
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();

    // Long-press a tab to hear/see its name — a lightweight substitute for the
    // (hidden) text label, surfaced via the app's global toast manager so it
    // works from inside the tab-bar's own gesture handling without extra
    // popover plumbing.
    const longPressListener = (name: TabIconName) => () => ({
        tabLongPress: () => {
            toastManager.showInfo(t(TAB_LABEL_KEY[name]));
        },
    });

    return (
        <View style={{ flex: 1 }}>
            <ErrorBoundary
                level="screen"
                FallbackComponent={FullScreenErrorFallback}
            >
                <Tabs
                    initialRouteName="for_you"
                    screenOptions={{
                        headerShown: false,
                        tabBarShowLabel: false,
                        tabBarActiveTintColor: ACCENT,
                        tabBarInactiveTintColor: INACTIVE,
                        tabBarStyle: {
                            backgroundColor: BAR_BACKGROUND,
                            borderTopColor: BAR_BORDER,
                            borderTopWidth: StyleSheet.hairlineWidth,
                            height: TAB_BAR_HEIGHT + insets.bottom,
                            paddingTop: 8,
                            paddingBottom: insets.bottom,
                        },
                    }}
                >
                    {/* Browse — Wave 6+. Hidden via href:null; route exists so it can
                        become the initial tab without a file move later. */}
                    <Tabs.Screen
                        name="browse"
                        options={{
                            href: null,
                            tabBarIcon: tabIcon('browse'),
                            tabBarAccessibilityLabel: t(TAB_LABEL_KEY.browse),
                        }}
                        listeners={longPressListener('browse')}
                    />
                    <Tabs.Screen
                        name="for_you"
                        options={{
                            tabBarIcon: tabIcon('for_you'),
                            tabBarAccessibilityLabel: t(TAB_LABEL_KEY.for_you),
                        }}
                        listeners={longPressListener('for_you')}
                    />
                    {/* Around — later wave. Hidden via href:null. */}
                    <Tabs.Screen
                        name="around"
                        options={{
                            href: null,
                            tabBarIcon: tabIcon('around'),
                            tabBarAccessibilityLabel: t(TAB_LABEL_KEY.around),
                        }}
                        listeners={longPressListener('around')}
                    />
                    <Tabs.Screen
                        name="profile"
                        options={{
                            tabBarIcon: tabIcon('profile'),
                            tabBarAccessibilityLabel: t(TAB_LABEL_KEY.profile),
                        }}
                        listeners={longPressListener('profile')}
                    />
                    <Tabs.Screen
                        name="settings"
                        options={{
                            tabBarIcon: tabIcon('settings'),
                            tabBarAccessibilityLabel: t(TAB_LABEL_KEY.settings),
                        }}
                        listeners={longPressListener('settings')}
                    />
                </Tabs>
            </ErrorBoundary>
            <TabsTooltipStrip />
            <ModelDownloadBanner />
        </View>
    );
}
