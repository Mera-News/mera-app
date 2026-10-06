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

/**
 * D2: VoiceOver read the SF Symbol names ("list.bullet.rectangle.fill",
 * "grid 2x2", "safari") even though every trigger carries a hidden `<Label>`:
 * a hidden title is not used as the tab item's accessibility label. The native
 * tab item takes one directly (react-native-screens `tabBarItemAccessibilityLabel`,
 * merged last by expo-router), so this stays JS-only.
 */
function tabA11y(label: string) {
    return { tabBarItemAccessibilityLabel: label };
}

export default function AppLayout() {
    const { t } = useTranslation();

    // Trigger order defines both the tab order AND the initial route: the first
    // trigger (`feed`) is selected on first mount, and Android Back on another
    // tab returns to it (backBehavior 'initialRoute').
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
                    {/* navx: four tabs, Feed, World, Library, You, each a folder
                        with its own Stack. `disableScrollToTop` because each
                        page handles a re-tap in JS (use-tab-press-scroll-refresh:
                        scroll up, then refresh); popToRoot stays ON, so a re-tap
                        with a screen pushed in the tab's stack (One interest,
                        a View-all) pops back to the pages. */}
                    <NativeTabs.Trigger
                        name="feed"
                        disableScrollToTop
                        unstable_nativeProps={tabA11y(t('tabs.deck'))}
                    >
                        <Label hidden>{t('tabs.deck')}</Label>
                        <Icon
                            sf="list.bullet.rectangle.fill"
                            src={<VectorIcon family={MaterialIcons} name="view-agenda" />}
                        />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger
                        name="world"
                        disableScrollToTop
                        unstable_nativeProps={tabA11y(t('tabs.world'))}
                    >
                        <Label hidden>{t('tabs.world')}</Label>
                        <Icon sf="globe" src={<VectorIcon family={MaterialIcons} name="public" />} />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger
                        name="library"
                        disableScrollToTop
                        unstable_nativeProps={tabA11y(t('tabs.library'))}
                    >
                        <Label hidden>{t('tabs.library')}</Label>
                        <Icon sf="bookmark.fill" src={<VectorIcon family={MaterialIcons} name="bookmark" />} />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger
                        name="you"
                        disableScrollToTop
                        unstable_nativeProps={tabA11y(t('tabs.you'))}
                    >
                        <Label hidden>{t('tabs.you')}</Label>
                        <Icon sf="person.fill" src={<VectorIcon family={MaterialIcons} name="person" />} />
                    </NativeTabs.Trigger>
                </NativeTabs>
            </ErrorBoundary>
            {/* The bell lives in each tab's page strip (Feed, Library, You);
                World has search there instead. */}
            <ModelDownloadBanner />
        </View>
    );
}
