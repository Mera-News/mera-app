import BreakingStrip from '@/components/custom/for-you/BreakingStrip';
import FreeTierCard from '@/components/custom/subscription/FreeTierCard';
import FactSectionHeader from '@/components/custom/for-you/FactSectionHeader';
import SectionGradientPanel from '@/components/custom/for-you/SectionGradientPanel';
import SectionViewAllText from '@/components/custom/for-you/SectionViewAllText';
import SectionDenominatorLine from '@/components/custom/for-you/SectionDenominatorLine';
import { sectionTitle } from '@/components/custom/for-you/section-title';
import { filterGroupsByImportance } from '@/components/custom/for-you/dashboard-importance';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import { Box } from '@/components/ui/box';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { isViewedArticle, sortByPriority } from '@/lib/feed-ordering/priority-order';
import { SECTION_PREVIEW_COUNT } from '@/lib/stores/dashboard-section-selector';
import { useImportanceFilterStore } from '@/lib/stores/importance-filter-store';
import {
  isHeadlineRow,
  isSuggestionOpened,
  type BreakingCardData,
  type FactRow,
  type FactRowGroup,
} from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { router } from 'expo-router';
import { useTabPressScrollRefresh } from '@/lib/hooks/use-tab-press-scroll-refresh';
import React, { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useComposedEventHandler,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  /** Resolved display title — the fact statement, or the localized headline
   *  scope title. Computed once here so the header, the "View all" route param
   *  and the destination screen all show the same string. */
  title: string;
  /** True for the two headline section kinds: adds the denominator line and
   *  drops the "News about:" prefix / dynamic translation of the title. */
  headline: boolean;
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
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  // Re-tap the Dashboard tab icon → scroll to top; tap again at the top →
  // refresh. Wired HERE rather than in ForYouScreen because this is where the
  // list ref lives — mirrors how `scrollHandler` is already threaded down.
  // `onRefresh` is the prop ForYouScreen already passes to the RefreshControl
  // (useFeedSyncRefresh), so the two paths are literally the same function.
  const listRef = useRef<Animated.FlatList<SectionItem>>(null);
  const lastOffsetShared = useSharedValue(0);
  useTabPressScrollRefresh({
    listRef,
    getOffset: () => lastOffsetShared.value,
    onRefresh,
    isRefreshing: !!refreshing,
  });
  // Section content order: the SAME rule the Feed tab uses
  // (lib/feed-ordering/priority-order) — unviewed high→med→low, then viewed
  // high→med→low — so a story cannot be ranked differently on the two screens.
  //
  // It reads the THROTTLED `sortSnapshot`, not the live opened set: the live set
  // changes the instant a card is tapped, which would re-rank the section under
  // the user's finger. `openedIds` still drives the per-card read styling, which
  // is allowed to update immediately because it moves nothing.
  const dashboardThreshold = useImportanceFilterStore((s) => s.dashboardThreshold);

  const sectionData = useMemo(() => {
    const data: SectionItem[] = [];
    for (const row of rows) {
      // Display-only importance filter, applied BEFORE ordering/slicing so the
      // preview, the total, and the "+N"/denominator counts all agree on what
      // actually renders. At 'low' (default) this is `row.groups` unchanged —
      // see filterGroupsByImportance — reproducing today's output exactly.
      const filteredGroups = filterGroupsByImportance(row.groups, dashboardThreshold);
      // A row that had groups but the filter hid all of them is dropped
      // entirely, same as a fact section that never qualifies for a section in
      // the first place. A row that had NO groups to begin with (a headline
      // shell whose denominator line IS its content) is untouched — there is
      // nothing for the filter to have hidden.
      if (row.groups.length > 0 && filteredGroups.length === 0) continue;
      const ordered = sortByPriority(filteredGroups, (g) => ({
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
        total: filteredGroups.length,
        title: sectionTitle(t, row),
        headline: isHeadlineRow(row),
      });
    }
    return data;
  }, [rows, sortSnapshot, t, dashboardThreshold]);

  const openFactFeed = useCallback((row: FactRow, title: string) => {
    router.push({
      pathname: '/logged-in/fact-feed',
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
      runOnJS(notifyScrollTick)();
      lastOffsetShared.value = e.contentOffset.y;
    },
  });
  const onScroll = useComposedEventHandler([scrollHandler, tickHandler]);

  const renderItem = useCallback(
    ({ item }: { item: SectionItem }) => {
      const { row, preview, total, title, headline } = item;
      const open = () => openFactFeed(row, title);
      // The ONLY zero-card section is a headline section where nothing cleared
      // the bar; its denominator line is the content, so it gets no header
      // affordance and no "View all" row pointing at an empty list.
      const canOpen = total > 0;
      return (
        // ONE gradient panel per section, wrapping header + cards + closing
        // pill, so the pastel ink groups the whole section and the next section
        // visibly starts its own. `dashboard-section-${factId}` lives on this
        // container (SectionGradientPanel sets it), which is where the driver
        // already expected it.
        <SectionGradientPanel factId={row.factId} style={{ marginTop: 16, marginBottom: 8 }}>
          <FactSectionHeader
            title={title}
            eventType={row.groups[0]?.data.eventType ?? null}
            total={total}
            onPress={canOpen ? open : undefined}
            // A headline section is not "News about:" anything, and its title is
            // app copy that is already in the reader's language.
            prefix={headline ? null : undefined}
            translateTitle={!headline}
          />
          {headline && (
            <SectionDenominatorLine read={row.headlineReadCount ?? 0} shown={total} />
          )}
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
          {canOpen && <SectionViewAllText total={total} onPress={open} />}
        </SectionGradientPanel>
      );
    },
    [onPressSuggestion, openedIds, openFactFeed],
  );

  // Composed, not replaced: the free-tier card sits ABOVE the breaking strip,
  // and both are above the sections. Mounted here rather than threaded down
  // from ForYouScreen as a prop because this component is the Dashboard's list
  // and its only consumer — a prop would be indirection with one caller.
  //
  // The card reads entitlement itself and renders null unless locked, so this
  // costs an empty fragment in the normal case, and every section below keeps
  // rendering underneath it when it does appear. Nothing is hidden or replaced.
  const ListHeader = useMemo(
    () => (
      <>
        <FreeTierCard surface="dashboard" />
        {breaking.length > 0 ? (
          <BreakingStrip items={breaking} onPressItem={onPressSuggestion} />
        ) : null}
      </>
    ),
    [breaking, onPressSuggestion],
  );

  return (
    <Box className="flex-1" testID="dashboard-sections-feed-root">
      <Animated.FlatList
        ref={listRef}
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
          // Bottom clearance for the floating tab bar — same expression as
          // FeedScreen's list (safe-area bottom + tab-bar height + a fixed
          // breathing-room tail), converged here from a previous ad-hoc
          // `TAB_BAR_HEIGHT + 120` that omitted the safe-area inset entirely.
          paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
        }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        // Initial visibility tick — same reason as FeedScreen's list: without a
        // tick at mount, TranslatableDynamic titles stay on the original text
        // until the user's first scroll and then swap (and re-wrap) under them.
        // Plain JS prop; does not touch the reanimated `onScroll` above.
        onContentSizeChange={notifyScrollTick}
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
