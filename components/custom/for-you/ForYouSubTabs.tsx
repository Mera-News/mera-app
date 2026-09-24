import { GlassPanel } from '@/components/custom/GlassSurface';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { observeUnseenTotal } from '@/lib/database/services/tracked-story-service';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/**
 * Accessibility roles for the row and each pill, per platform.
 *
 * iOS: React Native maps `tabbar` to UIAccessibilityTraitTabBar but maps `tab`
 * to NO trait at all (react-native accessibilityPropsConversions.h), so a pill
 * marked `tab` is a traitless element: captured on the simulator, every pill
 * read as `Other`. A UIKit tab bar item is a BUTTON inside a TabBar-trait
 * container, and that pairing is what VoiceOver reads as "tab, N of 5".
 * Android has real `tab` / `tablist` roles.
 */
export function subTabA11yRoles(os: string): { row: 'tabbar' | 'tablist'; pill: 'button' | 'tab' } {
    return os === 'ios' ? { row: 'tabbar', pill: 'button' } : { row: 'tablist', pill: 'tab' };
}
const A11Y_ROLES = subTabA11yRoles(Platform.OS);

export type ForYouSubTab = 'feed' | 'stories' | 'saved' | 'history' | 'factChecks';

interface ForYouSubTabsProps {
    readonly activeSubTab: ForYouSubTab;
    readonly onSelect: (tab: ForYouSubTab) => void;
    /**
     * The host's horizontal padding. The row pulls itself out by this much and
     * puts it back as content padding, so at rest the first pill lines up with
     * the title while scrolled pills run to the SCREEN edges instead of being
     * clipped at the header's inner padding. Works with or without a header
     * plate behind it. Default 0: no bleed.
     */
    readonly bleed?: number;
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
    // Fact checks sits BEFORE History, and that ordering is the point: this row
    // scrolls horizontally, so the last pill is the one a reader has to know is
    // there before they can reach it. A fact check is something the user
    // deliberately asked for and is waiting on; History is a passive record
    // they can browse whenever. The thing being waited on goes first.
    //
    // It was last, and reaching it on a phone needed a fling that plain scroll
    // and swipe both misfired — which is the ordering problem showing up as a
    // navigation problem.
    //
    // Reuses `factCheck.dashboard.title` rather than minting a `forYou.subTab*`
    // twin: the pill and the section it opens are the same noun.
    { key: 'factChecks', icon: 'fact-check', labelKey: 'factCheck.dashboard.title' },
    { key: 'history', icon: 'history', labelKey: 'forYou.subTabHistory' },
];

/**
 * The For-You sub-tab pill row — `[Overview] [Stories ●n] [Saved] [Fact checks] [History]`.
 * Pill styling is Explore's ScopeChipRow, copied token for token (owner: the
 * orange outline, orange label and icon together were "too much"): inactive
 * pills are a round `GlassPanel` with a white label, the active one a solid
 * accent fill with a black label, and the icons stay because Explore keeps
 * them. ScopeChipRow itself is not reusable (typed to places, add chip,
 * long-press remove), so a change there has to be copied here by hand. The Stories pill carries a live badge with the total unseen tracked-story
 * count, subscribed here so it stays fresh without the parent re-rendering.
 *
 * FIVE pills now. The row was already a horizontal `ScrollView` (added when the
 * count reached four, because a long translation could push them past the screen
 * edge), so the fifth scrolls into reach on a narrow device rather than clipping
 * or squeezing its neighbours — no pill was shrunk to make room.
 */
const ForYouSubTabs: React.FC<ForYouSubTabsProps> = ({ activeSubTab, onSelect, bleed = 0 }) => {
    const { t } = useTranslation();
    const [unseenTotal, setUnseenTotal] = useState(0);

    // ── Keep the SELECTED pill on screen ────────────────────────────────────
    // Measured on an iPhone 17 Pro (402pt wide): the pills total ~570pt, so
    // History is already clipped and Fact checks sits entirely off-screen at
    // rest. Selecting a pill that is off-screen therefore left the body
    // changing under a row that still appeared to have Overview selected —
    // observed on-device before this was added. (It was first found via a
    // deep link that preselected the pill; that link is gone with the
    // fact-check push, but a plain tap on a partly-clipped pill has the same
    // problem, so the scroll-into-view stays.)
    //
    // So selection scrolls the row to reveal its own pill. Only on CHANGE, and
    // only from the measured layout — nothing here resizes or reorders a pill.
    const scrollRef = useRef<ScrollView>(null);
    const pillLayouts = useRef<Partial<Record<ForYouSubTab, { x: number; width: number }>>>({});

    useEffect(() => {
        const layout = pillLayouts.current[activeSubTab];
        if (!layout) return;
        // Left-align the pill with a little breathing room, clamped at 0 so the
        // first pills never scroll to a negative offset.
        // With a bleed the pill lands where the first one rests, in line with
        // the title; without one, 12pt in from the row's edge as before.
        scrollRef.current?.scrollTo({ x: Math.max(0, layout.x - (bleed ? 0 : 12)), animated: true });
    }, [activeSubTab, bleed]);

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
        <View
            testID="dashboard-subtabs-row"
            pointerEvents="box-none"
            style={bleed ? { marginHorizontal: -bleed } : undefined}
        >
            <ScrollView
                ref={scrollRef}
                testID="dashboard-subtabs-scroll"
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={bleed ? { paddingHorizontal: bleed } : { paddingRight: 20 }}
            >
                {/* No edge fade. A painted one (stepped Views, and any single-
                    colour gradient) read as dark blocks over the translucent
                    header, which moves over the backdrop, and no mask is
                    available without a native dependency. The last pill simply
                    clips at the edge; seen half-cut, it says the row goes on. */}
                {/* Roles per platform: see `subTabA11yRoles`. */}
                <HStack
                    className="items-center"
                    space="sm"
                    accessibilityRole={A11Y_ROLES.row}
                    testID="dashboard-subtabs-list"
                >
                    {TABS.map((tab) => {
                        const active = tab.key === activeSubTab;
                        const showBadge = tab.key === 'stories' && unseenTotal > 0;
                        const label = t(tab.labelKey as any);
                        const inner = (
                            <>
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
                                    className={active ? 'text-black font-semibold' : 'text-white'}
                                >
                                    {label}
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
                            </>
                        );
                        const pressableProps = {
                            onPress: () => onSelect(tab.key),
                            accessibilityRole: A11Y_ROLES.pill,
                            accessibilityState: { selected: active },
                            accessibilityLabel: label,
                            testID: `dashboard-tab-${tab.key}`,
                        };
                        return (
                            <View
                                key={tab.key}
                                // On the wrapper, the HStack's direct child: x is
                                // relative to the HStack, which IS the scroll
                                // content, so it is directly usable as an offset.
                                onLayout={(e) => {
                                    const { x, width } = e.nativeEvent.layout;
                                    pillLayouts.current[tab.key] = { x, width };
                                }}
                            >
                                {active ? (
                                    // Explore's active chip: a solid accent fill,
                                    // which IS the selection signal, never glassed.
                                    <Pressable
                                        {...pressableProps}
                                        className="flex-row items-center rounded-full border px-4 py-2 bg-primary-400 border-primary-400"
                                    >
                                        {inner}
                                    </Pressable>
                                ) : (
                                    // Explore's inactive chip: a round translucent
                                    // plate with a hairline edge, white label.
                                    <GlassPanel radius={999}>
                                        <Pressable {...pressableProps} className="flex-row items-center px-4 py-2">
                                            {inner}
                                        </Pressable>
                                    </GlassPanel>
                                )}
                            </View>
                        );
                    })}
                </HStack>
            </ScrollView>
        </View>
    );
};

export default ForYouSubTabs;
