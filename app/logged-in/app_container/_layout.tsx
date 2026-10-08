import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { MaterialIcons } from '@expo/vector-icons';
import { View } from 'react-native';

import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ModelDownloadBanner from '@/components/custom/ModelDownloadBanner';
import { setTabDot, useTabDot } from '@/components/custom/nav/current-surface';
import { observeUnreadCount } from '@/lib/database/services/notification-service';
import { useChecksUnseen } from '@/lib/stores/fact-checks-store';
import { useColors } from '@/lib/theme/tokens';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Foreground polling, AppState listening, and recoverCycle calls have moved
// to AppScheduler (lib/scheduler/AppScheduler.ts) and its registered tasks:
//   - feed-sync-task.ts   — syncs the feed on a 60-second cadence + foreground
//   - inference-recover-task.ts — calls recoverCycle on foreground

// The house accent from the theme tokens is the NativeTabs `tintColor` (and
// the dot's fill); everything else (blur/liquid-glass on iOS 26, Material on
// Android) is left to the native appearance, no custom tabBarStyle.

const { Badge, Icon, Label, VectorIcon } = NativeTabs.Trigger;

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
    const colors = useColors();
    const dot = {
        feed: useTabDot('feed'),
        world: useTabDot('world'),
        library: useTabDot('library'),
        you: useTabDot('you'),
    };
    // The item label is the only thing VoiceOver reads (a blank badge adds
    // nothing), so a dot is spoken there.
    const label = (key: 'tabs.deck' | 'tabs.world' | 'tabs.library' | 'tabs.you', on: boolean) =>
        on ? t('nav.tabNewA11y', { label: t(key) }) : t(key);

    // The Feed's dot (everything new): its own (first stories landed while
    // away, FeedPages) OR unread notices (its Notifications page marks them
    // read). Combined here, so neither source clears the other.
    const [unread, setUnread] = useState(false);
    useEffect(() => {
        const sub = observeUnreadCount().subscribe((n) => setUnread(n > 0));
        return () => sub.unsubscribe();
    }, []);
    const feedDot = dot.feed || unread;
    // Library's dot: a fact check finished since Fact checks was seen (the
    // reader's own request, so it stays here).
    const checksUnseen = useChecksUnseen();
    useEffect(() => setTabDot('library', checksUnseen), [checksUnseen]);

    // Trigger order defines both the tab order AND the initial route: the first
    // trigger (`feed`) is selected on first mount, and Android Back on another
    // tab returns to it (backBehavior 'initialRoute').
    return (
        <View style={{ flex: 1, backgroundColor: colors.base }}>
            <ErrorBoundary
                level="screen"
                FallbackComponent={FullScreenErrorFallback}
            >
                {/* Icons-only navbar: every `<Label hidden>` keeps the tab's
                    accessibility title (the string children) while suppressing the
                    visible caption. `hidden` on NativeTabsTriggerLabelProps is the
                    supported cross-platform mechanism (iOS + Android). */}
                <NativeTabs
                    // Outline glyphs in ink, the picked one in the accent's mark
                    // tone (the boards' tab bar). The selected PILL's tint is the
                    // system's on iOS 26 (no prop reaches it; native list).
                    tintColor={colors.accentMark}
                    iconColor={{ default: colors.ink, selected: colors.accentMark }}
                    badgeBackgroundColor={colors.accent}
                    minimizeBehavior="onScrollDown"
                >
                    {/* navx: four tabs, Feed, World, Library, You, each a folder
                        with its own Stack. `disableScrollToTop` because the
                        tab's visible page handles a re-tap in JS (TabPages +
                        nav/page-scroll: scroll up, then refresh where the page
                        has one); popToRoot stays ON, so a re-tap
                        with a screen pushed in the tab's stack (One interest,
                        a View-all) pops back to the pages. */}
                    <NativeTabs.Trigger
                        name="feed"
                        disableScrollToTop
                        unstable_nativeProps={tabA11y(label('tabs.deck', feedDot))}
                    >
                        <Label hidden>{t('tabs.deck')}</Label>
                        <Badge hidden={!feedDot} />
                        <Icon
                            sf={{ default: 'newspaper', selected: 'newspaper' }}
                            src={<VectorIcon family={MaterialIcons} name="newspaper" />}
                        />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger
                        name="world"
                        disableScrollToTop
                        unstable_nativeProps={tabA11y(label('tabs.world', dot.world))}
                    >
                        <Label hidden>{t('tabs.world')}</Label>
                        <Badge hidden={!dot.world} />
                        <Icon sf={{ default: 'globe', selected: 'globe' }} src={<VectorIcon family={MaterialIcons} name="public" />} />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger
                        name="library"
                        disableScrollToTop
                        unstable_nativeProps={tabA11y(label('tabs.library', dot.library))}
                    >
                        <Label hidden>{t('tabs.library')}</Label>
                        <Badge hidden={!dot.library} />
                        <Icon sf={{ default: 'books.vertical', selected: 'books.vertical' }} src={<VectorIcon family={MaterialIcons} name="menu-book" />} />
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger
                        name="you"
                        disableScrollToTop
                        unstable_nativeProps={tabA11y(label('tabs.you', dot.you))}
                    >
                        <Label hidden>{t('tabs.you')}</Label>
                        <Badge hidden={!dot.you} />
                        {/* You is configuration now (owner): the gear, an SF Symbol and the
                            Material font glyph, so no native asset (OTA-able). */}
                        <Icon sf={{ default: 'gearshape', selected: 'gearshape' }} src={<VectorIcon family={MaterialIcons} name="settings" />} />
                    </NativeTabs.Trigger>
                </NativeTabs>
            </ErrorBoundary>
            {/* No bell: notices live in You > Notifications, and a dot on
                the You tab says one is unread. */}
            <ModelDownloadBanner />
        </View>
    );
}
