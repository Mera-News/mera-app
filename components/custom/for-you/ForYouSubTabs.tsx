import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { observeUnseenTotal } from '@/lib/database/services/tracked-story-service';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

export type ForYouSubTab = 'feed' | 'stories' | 'saved' | 'history' | 'factChecks';

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

/** Slack before a fade shows, so a sub-pixel offset does not flicker one in. */
const FADE_SLOP = 4;
/** Each fade is stepped bands (no CSS gradient on iOS here). Darkest at the edge. */
export const PILL_FADE_BANDS = [0.55, 0.4, 0.25, 0.12] as const;
const PILL_FADE_BAND_WIDTH = 6;

/**
 * Which edges hide pills. A fade at an edge is the ONLY sign more pills exist
 * past it: at 402pt the five pills total ~570pt, so Fact checks and Visited sit
 * off-screen at rest, and a row that simply stops reads as all there is.
 */
export function pillEdgeFades(
  scrollX: number,
  viewportWidth: number,
  contentWidth: number,
): { left: boolean; right: boolean } {
  if (viewportWidth <= 0 || contentWidth <= viewportWidth + FADE_SLOP) {
    return { left: false, right: false };
  }
  return {
    left: scrollX > FADE_SLOP,
    right: scrollX + viewportWidth < contentWidth - FADE_SLOP,
  };
}

function EdgeFade({ side }: { side: 'left' | 'right' }) {
  return (
    <View
      testID={`dashboard-subtabs-fade-${side}`}
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        [side]: 0,
        width: PILL_FADE_BANDS.length * PILL_FADE_BAND_WIDTH,
        flexDirection: side === 'left' ? 'row' : 'row-reverse',
      }}
    >
      {PILL_FADE_BANDS.map((alpha) => (
        <View
          key={alpha}
          style={{ width: PILL_FADE_BAND_WIDTH, backgroundColor: `rgba(12,12,14,${alpha})` }}
        />
      ))}
    </View>
  );
}

/**
 * The For-You sub-tab pill row — `[Feed] [Stories ●n] [Saved] [History] [Fact checks]`.
 * Pill styling mirrors Explore's ScopeChipRow (accent border, accent-filled active
 * chip). The Stories pill carries a live badge with the total unseen tracked-story
 * count, subscribed here so it stays fresh without the parent re-rendering.
 *
 * FIVE pills now. The row was already a horizontal `ScrollView` (added when the
 * count reached four, because a long translation could push them past the screen
 * edge), so the fifth scrolls into reach on a narrow device rather than clipping
 * or squeezing its neighbours — no pill was shrunk to make room.
 */
const ForYouSubTabs: React.FC<ForYouSubTabsProps> = ({ activeSubTab, onSelect }) => {
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
        scrollRef.current?.scrollTo({ x: Math.max(0, layout.x - 12), animated: true });
    }, [activeSubTab]);

    // Edge fades: tracked from the ScrollView's own layout, content size and
    // offset, all JS-side and throttled by the scroll event rate below.
    const [geom, setGeom] = useState({ x: 0, viewport: 0, content: 0 });
    const fades = pillEdgeFades(geom.x, geom.viewport, geom.content);
    const onScroll = useCallback((e: any) => {
        const x = e?.nativeEvent?.contentOffset?.x ?? 0;
        setGeom((g) => (g.x === x ? g : { ...g, x }));
    }, []);

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
                ref={scrollRef}
                testID="dashboard-subtabs-scroll"
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingRight: 20 }}
                onScroll={onScroll}
                scrollEventThrottle={32}
                onLayout={(e) => {
                    const w = e.nativeEvent.layout.width;
                    setGeom((g) => (g.viewport === w ? g : { ...g, viewport: w }));
                }}
                onContentSizeChange={(w) => {
                    setGeom((g) => (g.content === w ? g : { ...g, content: w }));
                }}
            >
                {/* The iOS tab-bar trait makes VoiceOver read each pill as
                    "tab, N of 5" with no extra copy (RN maps 'tabbar', not
                    'tablist', to UIAccessibilityTraitTabBar). Android reads
                    the collection from 'tablist'. */}
                <HStack
                    className="items-center"
                    space="sm"
                    accessibilityRole={Platform.OS === 'ios' ? 'tabbar' : 'tablist'}
                    testID="dashboard-subtabs-list"
                >
                    {TABS.map((tab) => {
                        const active = tab.key === activeSubTab;
                        const showBadge = tab.key === 'stories' && unseenTotal > 0;
                        return (
                            <Pressable
                                key={tab.key}
                                onPress={() => onSelect(tab.key)}
                                // x is relative to the HStack, which IS the
                                // scroll content — so it is directly usable as
                                // a scroll offset.
                                onLayout={(e) => {
                                    const { x, width } = e.nativeEvent.layout;
                                    pillLayouts.current[tab.key] = { x, width };
                                }}
                                accessibilityRole="tab"
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
            {fades.left && <EdgeFade side="left" />}
            {fades.right && <EdgeFade side="right" />}
        </View>
    );
};

export default ForYouSubTabs;
