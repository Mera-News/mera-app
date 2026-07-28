import BreakingStrip from '@/components/custom/for-you/BreakingStrip';
import FactSectionHeader from '@/components/custom/for-you/FactSectionHeader';
import SectionGradientPanel from '@/components/custom/for-you/SectionGradientPanel';
import SectionViewAllText from '@/components/custom/for-you/SectionViewAllText';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import { Box } from '@/components/ui/box';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { isViewedArticle, sortByPriority } from '@/lib/feed-ordering/priority-order';
import { SECTION_PREVIEW_COUNT } from '@/lib/stores/dashboard-section-selector';
import {
  isSuggestionOpened,
  type BreakingCardData,
  type FactRow,
  type FactRowGroup,
} from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { router } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { RefreshControl } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useComposedEventHandler,
} from 'react-native-reanimated';

/** Pull-to-refresh spinner tint — same value the Feed tab uses. */
const REFRESH_TINT = '#EDA77E';

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
// 1 header + SECTION_PREVIEW_COUNT (3) cards + 1 pill ≈ 5 subviews, so the
// virtualization window still measures and recycles at roughly the same
// granularity it did before — it just counts sections instead of rows.
interface SectionItem {
  key: string;
  row: FactRow;
  /** The section's top-N preview groups, already priority-ordered. */
  preview: FactRowGroup[];
  /** TOTAL articles in the section (header pill + closing row). */
  total: number;
}

interface DashboardSectionsFeedProps {
  breaking: BreakingCardData[];
  rows: FactRow[];
  /** Live opened set — drives the per-card read/dimmed treatment (visual only;
   *  ORDER comes from the throttled snapshot below). */
  openedIds: Set<string>;
  /** THROTTLED viewed-state snapshot that decides section ORDER. Frozen between
   *  re-sorts so sections never reshuffle under the reader — see
   *  lib/feed-ordering/dashboard-resort and ForYouScreen. */
  sortSnapshot: { cardStates: Record<string, unknown>; openedArticleIds: Set<string> };
  onPressSuggestion: (s: ForYouSuggestion) => void;
  /** The collapsible-header scroll handler (worklet). */
  scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
  /** Dashboard header height — content top padding. */
  headerHeight: number;
  ListEmptyComponent?: React.ComponentType<any> | React.ReactElement | null;
  /** Pull-to-refresh spinner state. Driven by the scheduler's feed-sync flag
   *  (see `useFeedSyncRefresh`), NOT by local state — so it rises on the same
   *  frame as the pull and stays up for the real duration of the sync. */
  refreshing?: boolean;
  /** Pull-to-refresh handler. Omit both props to render no refresh control. */
  onRefresh?: () => void;
}

/**
 * Dashboard sections feed (r5 redesign — supersedes FactSectionsFeed). Each
 * persona section becomes a pastel-gradient header (its stable fact color) over
 * up to 3 compact preview cards, with a "View all N stories" footer when the
 * section holds more than the preview count. The FAB / section-jump machinery
 * from the old feed is intentionally dropped — the header and footer are the
 * only navigation into a section's full fact feed.
 */
const DashboardSectionsFeed: React.FC<DashboardSectionsFeedProps> = ({
  breaking,
  rows,
  openedIds,
  sortSnapshot,
  onPressSuggestion,
  scrollHandler,
  headerHeight,
  ListEmptyComponent,
  refreshing,
  onRefresh,
}) => {
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
      const ordered = sortByPriority(row.groups, (g) => ({
        relevance: g.data.relevance ?? 0,
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
        total: row.groups.length,
      });
    }
    return data;
  }, [rows, sortSnapshot]);

  const openFactFeed = useCallback((row: FactRow) => {
    router.push({
      pathname: '/logged-in/fact-feed',
      params: {
        factId: row.factId,
        statement: row.statement,
      },
    });
  }, []);

  // Compose the collapsible-header handler with a scroll-tick notifier (drives
  // deferred TranslatableDynamic translation as items enter the viewport).
  const tickHandler = useAnimatedScrollHandler({
    onScroll: () => {
      runOnJS(notifyScrollTick)();
    },
  });
  const onScroll = useComposedEventHandler([scrollHandler, tickHandler]);

  const renderItem = useCallback(
    ({ item }: { item: SectionItem }) => {
      const { row, preview, total } = item;
      const open = () => openFactFeed(row);
      return (
        // ONE gradient panel per section, wrapping header + cards + closing
        // pill, so the pastel ink groups the whole section and the next section
        // visibly starts its own. `dashboard-section-${factId}` lives on this
        // container (SectionGradientPanel sets it), which is where the driver
        // already expected it.
        <SectionGradientPanel factId={row.factId} style={{ marginTop: 16, marginBottom: 8 }}>
          <FactSectionHeader
            title={row.statement}
            eventType={row.groups[0]?.data.eventType ?? null}
            total={total}
            onPress={open}
          />
          <Box className="px-2">
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
          {/* Closing row: plain "View all N articles" + chevron in the section
              title's type style — NOT a second pill. */}
          <SectionViewAllText total={total} onPress={open} />
        </SectionGradientPanel>
      );
    },
    [onPressSuggestion, openedIds, openFactFeed],
  );

  const ListHeader = useMemo(
    () =>
      breaking.length > 0 ? (
        <BreakingStrip items={breaking} onPressItem={onPressSuggestion} />
      ) : null,
    [breaking, onPressSuggestion],
  );

  return (
    <Box className="flex-1" testID="dashboard-sections-feed-root">
      <Animated.FlatList
        testID="dashboard-feed-list"
        data={sectionData}
        keyExtractor={(it) => it.key}
        renderItem={renderItem}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={ListEmptyComponent}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={!!refreshing}
              onRefresh={onRefresh}
              tintColor={REFRESH_TINT}
              colors={[REFRESH_TINT]}
              // Push the spinner below the absolute collapsing header so it
              // isn't hidden behind it (Android). Mirrors FeedScreen.
              progressViewOffset={headerHeight}
            />
          ) : undefined
        }
        contentContainerStyle={{
          paddingTop: headerHeight + 12,
          paddingHorizontal: 12,
          paddingBottom: TAB_BAR_HEIGHT + 120,
        }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
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
        // was fixed at the same time (ForYouScreen's header VStack is now
        // `box-none`). If the pull works now, THIS change may have been
        // unnecessary: restoring `autoscrollToTopThreshold: 10` is a one-line
        // revert. The cost of removing it is the auto-scroll-to-new-top when
        // sections re-sort while parked at the top — behaviour FeedScreen
        // deliberately refuses anyway, because it yanks a reader off the first
        // card. `minIndexForVisible` is kept, so position is still anchored.
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      />
    </Box>
  );
};

export default DashboardSectionsFeed;
