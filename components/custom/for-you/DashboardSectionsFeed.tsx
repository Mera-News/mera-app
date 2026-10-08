import SectionGradientPanel from '@/components/custom/for-you/SectionGradientPanel';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { sectionTitle } from '@/components/custom/for-you/section-title';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { isViewedArticle, sortByPriority } from '@/lib/feed-ordering/priority-order';
import { isMutedPublication, rankedRelevance, type RankingContext } from '@/lib/feed-ordering/publication-tags';
import { SECTION_PREVIEW_COUNT } from '@/lib/stores/dashboard-section-selector';
import {
  isSuggestionOpened,
  type FactRow,
  type FactRowGroup,
} from '@/lib/stores/fact-rows-selector';
import { Text } from '@/components/ui/text';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { router } from 'expo-router';
import { useTabPressScrollRefresh } from '@/lib/hooks/use-tab-press-scroll-refresh';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, StyleSheet, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useComposedEventHandler,
  useSharedValue,
} from 'react-native-reanimated';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET, PAGE_TITLE_GAP } from '@/components/custom/nav/page-registry';

/** Pull-to-refresh spinner tint — same value the Feed tab uses. */

// ONE list item per section (was three kinds of row: header / card / footer).
//
// Why the flattening was reversed: the pastel gradient must now run as a single
// continuous panel from the section header THROUGH its closing pill, and a
// gradient cannot span sibling FlatList rows — each row is its own view with its
// own background. Rendering the section as one item lets `SectionGradientPanel`
// wrap all of its children, which is the whole visual grouping the redesign is
// after.
//
// Cost to list performance is small and bounded: a section is at most
// 1 header band + SECTION_PREVIEW_COUNT (3) cards ≈ 4 subviews, so the
// virtualization window still measures and recycles at roughly the same
// granularity it did before — it just counts sections instead of rows.
interface SectionItem {
  key: string;
  row: FactRow;
  /** The section's top-N preview groups, already priority-ordered. */
  preview: FactRowGroup[];
  /** TOTAL stories in the section (the header's count). */
  total: number;
  /** The fact statement, computed once so the header, the route param and
   *  the fact page show the same string. */
  title: string;
}

const HIDDEN = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

/**
 * A section's header (FinalFeed #5): ONE link band, the fact then
 * "· N stories ›", opening that interest's fact page. The title is a fact
 * statement, user data, so it is translated. A hidden visual under a childless
 * labelled button (the glyph-leak pattern); the label is the title as SHOWN.
 */
function SectionLinkBand({
  factId,
  title,
  total,
  onPress,
}: {
  readonly factId: string;
  readonly title: string;
  readonly total: number;
  readonly onPress: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [shown, setShown] = useState(title);
  const count = t('forYou.sectionStories', { count: total });
  return (
    <View>
      <View pointerEvents="none" {...HIDDEN} style={styles.band}>
        <TranslatableDynamic
          text={title}
          bold
          numberOfLines={3}
          style={{ color: c.ink, fontSize: 16, lineHeight: 21 }}
          onDisplayChange={(d) => setShown(d.displayedText)}
        />
        <HStack className="items-center">
          <Text style={{ color: c.accentText, fontSize: 14, lineHeight: 20, fontWeight: '600' }}>{`· ${count}`}</Text>
          <MaterialIcons name="chevron-right" size={18} color={c.accentText} {...HIDDEN} />
        </HStack>
      </View>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${shown}, ${count}`}
        testID={`section-open-${factId}`}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

interface DashboardSectionsFeedProps {
  rows: FactRow[];
  /** Live opened set — drives the per-card read/dimmed treatment (visual only;
   *  ORDER comes from the throttled snapshot below). */
  openedIds: Set<string>;
  /** THROTTLED viewed-state snapshot that decides section ORDER. Frozen between
   *  re-sorts so sections never reshuffle under the reader — see
   *  lib/feed-ordering/dashboard-resort and InterestsPage. */
  sortSnapshot: { cardStates: Record<string, unknown>; openedArticleIds: Set<string> };
  onPressSuggestion: (s: ForYouSuggestion) => void;
  /** The collapsible-header scroll handler (worklet). */
  scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
  /** The Feed tab's header height: content top padding. */
  headerHeight: number;
  /** The Interests page's nothing-yet state: shown when no section has a story (the
   *  empty sections themselves are never drawn). */
  ListEmptyComponent?: React.ComponentType<any> | React.ReactElement | null;
  /** The Feed page's title row, the list's first item. */
  ListHeaderComponent?: React.ReactElement;
  /** Pull-to-refresh spinner state. Driven by the scheduler's feed-sync flag
   *  (see `useFeedSyncRefresh`), NOT by local state — so it rises on the same
   *  frame as the pull and stays up for the real duration of the sync. */
  refreshing?: boolean;
  /** Pull-to-refresh handler. Omit both props to render no refresh control. */
  onRefresh?: () => void;
  /** The publication tags: they weigh a section's order, and a muted
   *  publication's stories leave it (lib/feed-ordering/publication-tags). */
  rankingCtx?: RankingContext | null;
  /** False while this is not the visible page of the focused Feed tab: no
   *  scroll ticks, and the tab re-tap neither scrolls nor refreshes through
   *  it. Default true. */
  active?: boolean;
}

/**
 * The Interests page's list (it was the Dashboard's Overview). Only FACT
 * sections reach it; World covers the headline scopes. Each
 * persona section becomes a pastel-gradient header (its stable fact color) over
 * up to 3 compact preview cards, with a "View all N stories" footer when the
 * section holds more than the preview count. The FAB / section-jump machinery
 * from the old feed is intentionally dropped — the header and footer are the
 * only navigation into a section's full fact feed.
 */
const DashboardSectionsFeed: React.FC<DashboardSectionsFeedProps> = ({
  rows,
  openedIds,
  sortSnapshot,
  onPressSuggestion,
  scrollHandler,
  headerHeight,
  ListEmptyComponent,
  ListHeaderComponent,
  refreshing,
  onRefresh,
  rankingCtx = null,
  active = true,
}) => {
  // Inside a tab on iOS the inset already includes the tab bar; measured on
  // device, adding TAB_BAR_HEIGHT left ~2x the bar of dead space at the end.
  const listEndClearance = useListEndClearance();
  const { t } = useTranslation();
  const colors = useColors();

  // Re-tap the Feed tab icon while this page shows: scroll to top, tap again
  // at the top: refresh. Wired HERE because this is where the list ref lives.
  // `onRefresh` is the prop the Interests page passes to the RefreshControl
  // (useFeedSyncRefresh), so the two paths are literally the same function.
  const listRef = useRef<Animated.FlatList<SectionItem>>(null);
  const lastOffsetShared = useSharedValue(0);
  // Only the active panel may act on a tab re-tap (an off-screen one reads as
  // "at the top" with nothing to refresh).
  useTabPressScrollRefresh({
    listRef,
    getOffset: () => (active ? lastOffsetShared.value : 0),
    onRefresh: active ? onRefresh : undefined,
    isRefreshing: !!refreshing,
    enabled: active,
  });
  // Section content order: the SAME rule the Feed tab uses
  // (lib/feed-ordering/priority-order) — unviewed high→med→low, then viewed
  // high→med→low — so a story cannot be ranked differently on the two screens.
  //
  // It reads the THROTTLED `sortSnapshot`, not the live opened set: the live set
  // changes the instant a card is tapped, which would re-rank the section under
  // the user's finger. `openedIds` still drives the per-card read styling, which
  // is allowed to update immediately because it moves nothing.
  const sectionData = useMemo(() => {
    const data: SectionItem[] = [];
    for (const row of rows) {
      // Owner (reversing D4): a section with no stories is not drawn at all,
      // no header and no placeholder. The selector still builds it (a fact
      // feed opened directly shows its own empty state), nothing is persisted,
      // and it appears as soon as a refresh gives it a story.
      // Every group renders except a muted publication's (Mute means skip),
      // so the preview, the total and the "+N"/denominator counts agree on
      // `groups` by construction.
      const groups = row.groups.filter((g) => !isMutedPublication(g.data.publication_name, rankingCtx));
      if (groups.length === 0) continue;
      const ordered = sortByPriority(groups, (g) => ({
        relevance: rankedRelevance(g.data.relevance ?? 0, g.data.publication_name, rankingCtx),
        viewed: isViewedArticle(
          g.data.articleId,
          g.data.articleId,
          sortSnapshot.cardStates,
          sortSnapshot.openedArticleIds,
        ),
      }));
      // The 3 preview cards are simply the top 3 of that same order — no
      // separate ranking, and no pre-filtering of opened stories: the order
      // already sinks them, and filtering them out entirely used to leave a
      // fully-read section rendering as a bare header + footer.
      data.push({
        key: `s:${row.factId}`,
        row,
        preview: ordered.slice(0, SECTION_PREVIEW_COUNT),
        total: groups.length,
        title: sectionTitle(t, row),
      });
    }
    return data;
  }, [rows, sortSnapshot, t, rankingCtx]);

  const openFactFeed = useCallback((row: FactRow, title: string) => {
    router.push({
      pathname: '/logged-in/app_container/feed/interest',
      params: {
        factId: row.factId,
        statement: title,
      },
    });
  }, []);

  // Compose the collapsible-header handler with a scroll-tick notifier (drives
  // deferred TranslatableDynamic translation as items enter the viewport).
  //
  // The raw offset is mirrored into a shared value in the SAME worklet rather
  // than via a second, plain-JS `onScroll` — the list already routes onScroll
  // through `useComposedEventHandler`, and adding a JS handler alongside it
  // would have the two fight over the prop. UI thread only: no bridge crossing,
  // no re-render.
  const tickHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      // Only a real offset change ticks (see FeedScreen).
      if (e.contentOffset.y === lastOffsetShared.value) return;
      runOnJS(notifyScrollTick)();
      lastOffsetShared.value = e.contentOffset.y;
    },
  });
  const onScroll = useComposedEventHandler([scrollHandler, tickHandler]);

  const renderItem = useCallback(
    ({ item }: { item: SectionItem }) => {
      const { row, preview, total, title } = item;
      return (
        // ONE gradient panel per section, so the pastel groups the band and
        // its cards and the next section visibly starts its own.
        // Sections stack PAGE_TITLE_GAP apart, as the board's `.body` gap.
        <SectionGradientPanel factId={row.factId} style={{ marginBottom: PAGE_TITLE_GAP }}>
          <SectionLinkBand factId={row.factId} title={title} total={total} onPress={() => openFactFeed(row, title)} />
          <Box className="px-2 pb-2">
            {preview.map((group) => (
              <ArticleSuggestionCompactCard
                key={group.data._id}
                suggestion={group.data}
                onPress={onPressSuggestion}
                surface="sectioned"
                read={isSuggestionOpened(group.data, openedIds)}
              />
            ))}
          </Box>
        </SectionGradientPanel>
      );
    },
    [onPressSuggestion, openedIds, openFactFeed],
  );

  return (
    <Box className="flex-1" testID="dashboard-sections-feed-root">
      <Animated.FlatList
        ref={listRef}
        testID="dashboard-feed-list"
        data={sectionData}
        keyExtractor={(it) => it.key}
        renderItem={renderItem}
        ListHeaderComponent={
          ListHeaderComponent ? <View style={{ marginBottom: PAGE_TITLE_GAP }}>{ListHeaderComponent}</View> : null
        }
        ListEmptyComponent={ListEmptyComponent}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={!!refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent}
              colors={[colors.accent]}
              // Push the spinner below the absolute collapsing header so it
              // isn't hidden behind it (Android). Mirrors FeedScreen.
              progressViewOffset={headerHeight}
            />
          ) : undefined
        }
        contentContainerStyle={{
          paddingTop: headerHeight + PAGE_CONTENT_GAP,
          paddingHorizontal: PAGE_SIDE_INSET,
          // Bottom clearance for the tab bar plus a breathing-room tail. The
          // helper, never insets.bottom + TAB_BAR_HEIGHT (see tab-bar.ts).
          paddingBottom: listEndClearance,
        }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        // Initial visibility tick — same reason as FeedScreen's list: without a
        // tick at mount, TranslatableDynamic titles stay on the original text
        // until the user's first scroll and then swap (and re-wrap) under them.
        // Plain JS prop; does not touch the reanimated `onScroll` above.
        onContentSizeChange={active ? notifyScrollTick : undefined}
        // Tuned for SECTIONS, not rows: each item is ~5 subviews, so these are
        // scaled down from the old per-row values to keep a comparable amount of
        // work per batch.
        initialNumToRender={3}
        windowSize={5}
        maxToRenderPerBatch={2}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={false}
        // `autoscrollToTopThreshold` removed. UNVERIFIED HYPOTHESIS, not a
        // proven mechanism: this prop was the only MVCP difference between this
        // list and the Feed tab's, and the Feed's pull-to-refresh works while
        // this one only bounced a couple of px and never armed the spinner. The
        // suspicion is that with the threshold set, a content update landing
        // while the user is within 10px of the top re-pins contentOffset and
        // cancels the pull — and this list re-derives constantly
        // (`buildFactRows` re-runs on every suggestion/opened-set tick, and
        // sections live-resort), so such an update is likely mid-gesture.
        //
        // The other suspect — the tall collapsing header swallowing the drag —
        // was fixed at the same time (the tab header is `box-none` now too,
        // TabPages). If the pull works now, THIS change may have been
        // unnecessary: restoring `autoscrollToTopThreshold: 10` is a one-line
        // revert. The cost of removing it is the auto-scroll-to-new-top when
        // sections re-sort while parked at the top — behaviour FeedScreen
        // deliberately refuses anyway, because it yanks a reader off the first
        // card. `minIndexForVisible` is kept, so position is still anchored.
        // Not while there are no sections: with nothing to anchor, iOS's MVCP
        // adjust and the scroll worklet loop on the main thread (see
        // FeedScreen).
        maintainVisibleContentPosition={sectionData.length > 0 ? { minIndexForVisible: 0 } : undefined}
      />
    </Box>
  );
};

const styles = StyleSheet.create({
  band: { paddingHorizontal: 12, paddingVertical: 10, gap: 2 },
});

export default DashboardSectionsFeed;
