import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { observeUnseenTotal } from '@/lib/database/services/tracked-story-service';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

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
 * The For-You sub-tab pill row — `[Feed] [Stories ●n] [Saved] [History]`. Pill styling
 * mirrors Explore's ScopeChipRow (accent border, accent-filled active chip). The
 * Stories pill carries a live badge with the total unseen tracked-story count,
 * subscribed here so it stays fresh without the parent re-rendering.
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

    // box-none: this row spans the full header width, and the space to the right
    // of the pills would otherwise be an opaque band that swallows the
    // Dashboard's pull-to-refresh. Only the pills themselves take touches.
    //
    // The pills now number four, and a long translation can push their total
    // width past the screen — so they scroll horizontally rather than clip. The
    // ScrollView itself CANNOT be `box-none` (that prop only makes a view's
    // background transparent to touches while keeping its children touchable;
    // a ScrollView needs to actually receive the touch to recognize a horizontal
    // drag), so box-none stays on this OUTER wrapper exactly as before and the
    // ScrollView is kept tight to the pills' own height (no flex/height override)
    // so it never grows into the blank space below the row that pull-to-refresh
    // needs to pass through.
    return (
        <View testID="dashboard-subtabs-row" pointerEvents="box-none">
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingRight: 20 }}
            >
                <HStack className="items-center" space="sm">
                    {TABS.map((tab) => {
                        const active = tab.key === activeSubTab;
                        const showBadge = tab.key === 'stories' && unseenTotal > 0;
                        return (
                            <Pressable
                                key={tab.key}
                                onPress={() => onSelect(tab.key)}
                                accessibilityRole="button"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={t(tab.labelKey as any)}
                                testID={`dashboard-tab-${tab.key}`}
                                className={`flex-row items-center rounded-full border px-4 py-2 ${
                                    active ? 'bg-primary-400 border-primary-400' : 'border-primary-500 bg-transparent'
                                }`}
                            >
                                <MaterialIcons
                                    name={tab.icon}
                                    size={16}
                                    color={active ? '#000000' : ACCENT}
                                    style={{ marginRight: 6 }}
                                />
                                <Text
                                    size="sm"
                                    // Tab labels sit in a row sized by its neighbours; past
                                    // ~1.4x they push the pills off-screen instead of
                                    // helping. See lib/typography/policy.ts.
                                    scaleTier="chrome"
                                    numberOfLines={1}
                                    className={active ? 'text-black font-semibold' : 'text-primary-500 font-semibold'}
                                >
                                    {t(tab.labelKey as any)}
                                </Text>
                                {showBadge && (
                                    <View
                                        accessibilityLabel={`${unseenTotal}`}
                                        testID={`dashboard-tab-${tab.key}-badge`}
                                        className="ml-1.5 rounded-full items-center justify-center px-1.5"
                                        // minHeight, not height: the count inside scales
                                        // with Dynamic Type, so a hard 18pt box clipped it.
                                        // The badge becomes a pill rather than a circle at
                                        // large sizes, which is the correct trade.
                                        style={{
                                            minWidth: 18,
                                            minHeight: 18,
                                            backgroundColor: active ? '#000000' : ACCENT,
                                        }}
                                    >
                                        <Text
                                            size="xs"
                                            scaleTier="chrome"
                                            className={active ? 'text-primary-400 font-bold' : 'text-black font-bold'}
                                        >
                                            {unseenTotal > 99 ? '99+' : unseenTotal}
                                        </Text>
                                    </View>
                                )}
                            </Pressable>
                        );
                    })}
                </HStack>
            </ScrollView>
        </View>
    );
};

export default ForYouSubTabs;
