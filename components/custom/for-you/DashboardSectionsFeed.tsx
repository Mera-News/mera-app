import BreakingStrip from '@/components/custom/for-you/BreakingStrip';
import FactSectionHeader from '@/components/custom/for-you/FactSectionHeader';
import SectionGradientPanel from '@/components/custom/for-you/SectionGradientPanel';
import SectionViewAllRow from '@/components/custom/for-you/SectionViewAllRow';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import { Box } from '@/components/ui/box';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { notifyScrollTick } from '@/lib/visibility-tick';
import {
  countNewGroups,
  selectTopGroups,
} from '@/lib/stores/dashboard-section-selector';
import { useSectionVisitsStore } from '@/lib/stores/section-visits-store';
import {
  isSuggestionOpened,
  type BreakingCardData,
  type FactRow,
  type FactRowGroup,
} from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { router } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useComposedEventHandler,
} from 'react-native-reanimated';

// Flattened list model: per section a gradient-panel header, up to 3 preview
// cards, and (only when the section has more than the preview count) a
// "View all" footer.
type FeedItem =
  | { type: 'header'; key: `h:${string}`; row: FactRow; newCount: number }
  | { type: 'card'; key: `c:${string}`; row: FactRow; group: FactRowGroup }
  | { type: 'footer'; key: `f:${string}`; row: FactRow; total: number };

interface DashboardSectionsFeedProps {
  breaking: BreakingCardData[];
  rows: FactRow[];
  /** Live opened set — drives the per-card read/dimmed treatment. */
  openedIds: Set<string>;
  onPressSuggestion: (s: ForYouSuggestion) => void;
  /** The collapsible-header scroll handler (worklet). */
  scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
  /** Dashboard header height — content top padding. */
  headerHeight: number;
  ListEmptyComponent?: React.ComponentType<any> | React.ReactElement | null;
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
  onPressSuggestion,
  scrollHandler,
  headerHeight,
  ListEmptyComponent,
}) => {
  const { t } = useTranslation();
  // Subscribe to visits so newness badges recompute after a section is visited.
  const visits = useSectionVisitsStore((s) => s.visits);

  const flatData = useMemo(() => {
    const data: FeedItem[] = [];
    for (const row of rows) {
      const newCount = countNewGroups(row.groups, visits[row.factId]);
      data.push({ type: 'header', key: `h:${row.factId}`, row, newCount });
      // Only surface UNSEEN suggestions in the compact preview — a story the
      // user already opened is dropped here (still reachable via "View all").
      // If nothing unopened remains, the section shows just header + footer.
      const unopened = row.groups.filter(
        (g) => !isSuggestionOpened(g.data, openedIds),
      );
      const previewGroups = selectTopGroups(unopened);
      for (const group of previewGroups) {
        data.push({ type: 'card', key: `c:${group.data._id}`, row, group });
      }
      // Footer whenever the section holds more stories than the preview shows
      // (including opened ones filtered out above), so the full feed stays
      // reachable.
      if (row.groups.length > previewGroups.length) {
        data.push({ type: 'footer', key: `f:${row.factId}`, row, total: row.groups.length });
      }
    }
    return data;
    // openedIds is a dep: the preview must drop a card as soon as it's opened.
  }, [rows, visits, openedIds]);

  const openFactFeed = useCallback((row: FactRow) => {
    router.push({
      pathname: '/logged-in/fact-feed',
      params: {
        factId: row.factId,
        // The "also" catch-all navigates too, with its static i18n title.
        statement: row.kind === 'also' ? t('forYou.alsoForYou') : row.statement,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    ({ item }: { item: FeedItem }) => {
      if (item.type === 'header') {
        return (
          <SectionGradientPanel
            factId={item.row.factId}
            style={{ marginTop: 16, marginBottom: 8 }}
          >
            <FactSectionHeader
              kind={item.row.kind}
              title={item.row.statement}
              eventType={item.row.groups[0]?.data.eventType ?? null}
              newCount={item.newCount}
              onPress={() => openFactFeed(item.row)}
            />
          </SectionGradientPanel>
        );
      }
      if (item.type === 'footer') {
        return <SectionViewAllRow total={item.total} onPress={() => openFactFeed(item.row)} />;
      }
      const { group } = item;
      return (
        <ArticleSuggestionCompactCard
          suggestion={group.data}
          onPress={onPressSuggestion}
          surface="sectioned"
          read={isSuggestionOpened(group.data, openedIds)}
        />
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
    <Box className="flex-1">
      <Animated.FlatList
        data={flatData}
        keyExtractor={(it) => it.key}
        renderItem={renderItem}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={ListEmptyComponent}
        contentContainerStyle={{
          paddingTop: headerHeight + 12,
          paddingHorizontal: 12,
          paddingBottom: TAB_BAR_HEIGHT + 120,
        }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        initialNumToRender={8}
        windowSize={7}
        maxToRenderPerBatch={4}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={false}
        maintainVisibleContentPosition={{
          minIndexForVisible: 0,
          autoscrollToTopThreshold: 10,
        }}
      />
    </Box>
  );
};

export default DashboardSectionsFeed;
