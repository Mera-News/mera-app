import { Tabs, TabsIndicator, TabsList, TabsTrigger, TabsTriggerText } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';
import { observeUnseenTotal } from '@/lib/database/services/tracked-story-service';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

// MaterialIcons takes a `color` prop rather than a className, so the two
// typography tokens the Tabs primitive uses for label colour are mirrored here
// as literals (dark-mode values, which is the only mode the app ships).
const ICON_SELECTED = 'rgb(254, 254, 255)'; // typography-950
const ICON_IDLE = 'rgb(163, 163, 163)'; // typography-500

export type ForYouSubTab = 'feed' | 'stories' | 'saved' | 'history';

interface ForYouSubTabsProps {
    readonly activeSubTab: ForYouSubTab;
    readonly onSelect: (tab: ForYouSubTab) => void;
}

interface TabDef {
    readonly key: ForYouSubTab;
    readonly icon: keyof typeof MaterialIcons.glyphMap;
    readonly labelKey: string;
}

const TABS: readonly TabDef[] = [
    { key: 'feed', icon: 'dynamic-feed', labelKey: 'forYou.subTabFeed' },
    { key: 'stories', icon: 'auto-awesome', labelKey: 'forYou.subTabStories' },
    { key: 'saved', icon: 'bookmark', labelKey: 'forYou.subTabSaved' },
    { key: 'history', icon: 'history', labelKey: 'forYou.subTabHistory' },
];

/**
 * The For-You sub-tab strip — `[Overview] [Stories ●n] [Saved] [History]`, built
 * on the shared gluestack Tabs primitive (`components/ui/tabs`) in its `filled`
 * variant: a solid track with a sliding indicator behind the selected trigger.
 * The Stories trigger carries a live badge with the total unseen tracked-story
 * count, subscribed here so it stays fresh without the parent re-rendering.
 *
 * ── WHY THE POINTER-EVENTS DANCE (do not simplify) ──
 * This row sits inside the Dashboard's collapsing header, which is an absolutely
 * positioned overlay painted ON TOP of the feed list. React Native's responder
 * system does not fall through to siblings painted below in z-order, so ANY view
 * here with `pointerEvents="auto"` is a dead band where a downward drag can never
 * reach the list's pull-to-refresh. Hence:
 *   - the outer wrapper and the Tabs ROOT are `box-none` — the root renders
 *     `w-full`, so left alone it would swallow the full width of the header;
 *   - TabsList is deliberately NOT `box-none`: it owns a horizontal FlatList and
 *     has to actually receive the touch to recognise a sideways drag (the same
 *     reason the hand-rolled ScrollView it replaced could never be box-none);
 *   - TabsList's height is held to what that ScrollView occupied, so the dead
 *     band does not grow. `py-0.5` on the list plus `py-1.5` on each trigger
 *     reproduces the old bare pill's `py-2` height, keeping the measured
 *     `dashboard-header` at 227.67pt. That number is passed to three sibling
 *     panels as `headerHeight` (ForYouScreen), so drift here would silently
 *     re-pad Stories/Saved/History too.
 */
const ForYouSubTabs: React.FC<ForYouSubTabsProps> = ({ activeSubTab, onSelect }) => {
    const { t } = useTranslation();
    const [unseenTotal, setUnseenTotal] = useState(0);

    useEffect(() => {
        const sub = observeUnseenTotal().subscribe({
            next: (total) => setUnseenTotal(total),
            error: () => setUnseenTotal(0),
        });
        return () => sub.unsubscribe();
    }, []);

    return (
        <View testID="dashboard-subtabs-row" pointerEvents="box-none">
            <Tabs
                value={activeSubTab}
                onValueChange={(value: string) => onSelect(value as ForYouSubTab)}
                variant="filled"
                className="gap-0"
                pointerEvents="box-none"
            >
                <TabsList className="px-1 py-0.5" contentContainerStyle={{ paddingRight: 20 }}>
                    <TabsIndicator />
                    {TABS.map((tab) => {
                        const active = tab.key === activeSubTab;
                        const showBadge = tab.key === 'stories' && unseenTotal > 0;
                        return (
                            <TabsTrigger
                                key={tab.key}
                                value={tab.key}
                                testID={`dashboard-tab-${tab.key}`}
                                accessibilityLabel={t(tab.labelKey as any)}
                                accessibilityState={{ selected: active }}
                                // Measured: this lands dashboard-header at 225.67pt vs the
                                // pre-migration 227.67pt. The 2pt comes from TabsTriggerText
                                // being a raw RN Text, whose line box is 2pt shorter than the
                                // gluestack <Text size="sm"> this row used to use. Exactly
                                // closing it would need py-[7px], and arbitrary values do not
                                // compile in this tailwind setup (verified: padding collapsed
                                // to 0, row height 21.33). The 2pt is left as-is deliberately —
                                // it makes the header's non-pull-through dead band slightly
                                // SHORTER, never taller, which is the safe direction.
                                className="flex-row items-center rounded-lg px-4 py-1.5 mr-2"
                            >
                                <MaterialIcons
                                    name={tab.icon}
                                    size={16}
                                    color={active ? ICON_SELECTED : ICON_IDLE}
                                    style={{ marginRight: 6 }}
                                />
                                <TabsTriggerText
                                    numberOfLines={1}
                                    className={`text-sm ${active ? 'font-semibold' : 'font-medium'}`}
                                >
                                    {t(tab.labelKey as any)}
                                </TabsTriggerText>
                                {showBadge && (
                                    <View
                                        accessibilityLabel={`${unseenTotal}`}
                                        testID={`dashboard-tab-${tab.key}-badge`}
                                        className="ml-1.5 rounded-full items-center justify-center px-1.5"
                                        style={{
                                            minWidth: 18,
                                            height: 18,
                                            // The accent no longer signals selection (the sliding
                                            // indicator does), which frees it to be the single warm
                                            // colour in the row — that is what makes the badge read
                                            // as a notification rather than as chrome. Held constant
                                            // across states for exactly that reason.
                                            backgroundColor: ACCENT,
                                        }}
                                    >
                                        <Text size="xs" className="text-black font-bold">
                                            {unseenTotal > 99 ? '99+' : unseenTotal}
                                        </Text>
                                    </View>
                                )}
                            </TabsTrigger>
                        );
                    })}
                </TabsList>
            </Tabs>
        </View>
    );
};

export default ForYouSubTabs;
