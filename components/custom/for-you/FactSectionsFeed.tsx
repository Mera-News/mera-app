import BreakingStrip from '@/components/custom/for-you/BreakingStrip';
import FactSectionHeader from '@/components/custom/for-you/FactSectionHeader';
import SectionJumpFab, { type SectionEntry } from '@/components/custom/for-you/SectionJumpFab';
import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import { Box } from '@/components/ui/box';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { notifyScrollTick } from '@/lib/visibility-tick';
import {
  isSuggestionOpened,
  type BreakingCardData,
  type FactRow,
  type FactRowGroup,
} from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { router } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewToken } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useComposedEventHandler,
} from 'react-native-reanimated';

/** Distinct extra source publications a collapsed story carries ("+N sources").
 *  Mirrors FactFeedScreen's helper so Dashboard cards show the same chip. */
function moreSourcesCount(rep: ForYouSuggestion, members: ForYouSuggestion[]): number {
  if (members.length === 0) return 0;
  const repPub = (rep.publication_name ?? '').trim().toLowerCase();
  const distinct = new Set<string>();
  for (const m of members) {
    const pub = (m.publication_name ?? '').trim().toLowerCase();
    if (pub !== repPub) distinct.add(pub || `__unknown_${m._id}`);
  }
  return distinct.size > 0 ? distinct.size : members.length;
}

// Flattened list model: a section header followed by all of its cards.
type FeedItem =
  | { type: 'header'; key: string; sectionId: string; row: FactRow }
  | { type: 'card'; key: string; sectionId: string; row: FactRow; group: FactRowGroup };

interface FactSectionsFeedProps {
  breaking: BreakingCardData[];
  rows: FactRow[];
  /** Live opened set — drives the per-card green tick. */
  openedIds: Set<string>;
  onPressSuggestion: (s: ForYouSuggestion) => void;
  /** The collapsible-header scroll handler (worklet). */
  scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
  /** Dashboard header height — content top padding + scroll-to-section offset. */
  headerHeight: number;
  ListEmptyComponent?: React.ComponentType<any> | React.ReactElement | null;
}

// --- section header row ----------------------------------------------------

interface HeaderRowProps {
  row: FactRow;
}

const SectionHeaderRow: React.FC<HeaderRowProps> = React.memo(({ row }) => {
  const openFactFeed = useCallback(() => {
    router.push({
      pathname: '/logged-in/fact-feed',
      params: { factId: row.factId, statement: row.statement },
    });
  }, [row.factId, row.statement]);

  return (
    <FactSectionHeader
      kind={row.kind}
      title={row.statement}
      eventType={row.groups[0]?.data.eventType ?? null}
      unreadCount={row.unreadCount}
      onPress={row.kind === 'fact' ? openFactFeed : undefined}
    />
  );
});
SectionHeaderRow.displayName = 'SectionHeaderRow';

// --- one vertical list, section header → all cards → next section ----------

const FactSectionsFeed: React.FC<FactSectionsFeedProps> = ({
  breaking,
  rows,
  openedIds,
  onPressSuggestion,
  scrollHandler,
  headerHeight,
  ListEmptyComponent,
}) => {
  const { t } = useTranslation();
  const listRef = useRef<Animated.FlatList<FeedItem>>(null);
  const [currentSectionId, setCurrentSectionId] = useState<string | null>(null);

  // Flatten rows into [header, card, card, …, header, …] + a sectionId → header
  // index map for scroll-to-section jumps.
  const { flatData, sectionIndexMap } = useMemo(() => {
    const data: FeedItem[] = [];
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.factId, data.length);
      data.push({ type: 'header', key: `h:${row.factId}`, sectionId: row.factId, row });
      for (const group of row.groups) {
        data.push({
          type: 'card',
          key: `c:${group.data._id}`,
          sectionId: row.factId,
          row,
          group,
        });
      }
    }
    return { flatData: data, sectionIndexMap: map };
  }, [rows]);

  const sections: SectionEntry[] = useMemo(
    () =>
      rows.map((r) => ({
        id: r.factId,
        label: r.kind === 'also' ? t('forYou.alsoForYou') : r.statement,
        count: r.groups.length,
      })),
    [rows, t],
  );

  // Compose the collapsible-header handler with a scroll-tick notifier (drives
  // deferred TranslatableDynamic translation as items enter the viewport).
  const tickHandler = useAnimatedScrollHandler({
    onScroll: () => {
      runOnJS(notifyScrollTick)();
    },
  });
  const onScroll = useComposedEventHandler([scrollHandler, tickHandler]);

  // Current-section tracking — first viewable item that carries a sectionId.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems.find((v) => v.item && (v.item as FeedItem).sectionId);
      if (first) setCurrentSectionId((first.item as FeedItem).sectionId);
    },
  ).current;

  const jumpToSection = useCallback(
    (sectionId: string) => {
      const index = sectionIndexMap.get(sectionId);
      if (index == null) return;
      listRef.current?.scrollToIndex({
        index,
        animated: true,
        viewOffset: headerHeight,
        viewPosition: 0,
      });
    },
    [sectionIndexMap, headerHeight],
  );

  const jumpToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      listRef.current?.scrollToOffset({
        offset: Math.max(0, info.averageItemLength * info.index - headerHeight),
        animated: true,
      });
      setTimeout(() => {
        listRef.current?.scrollToIndex({
          index: info.index,
          animated: true,
          viewOffset: headerHeight,
        });
      }, 120);
    },
    [headerHeight],
  );

  const renderItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      if (item.type === 'header') {
        return <SectionHeaderRow row={item.row} />;
      }
      const { group } = item;
      return (
        <ArticleSuggestionCard
          suggestion={group.data}
          moreSourcesCount={moreSourcesCount(group.data, group.members)}
          onPress={onPressSuggestion}
          surface="for_you"
          read={isSuggestionOpened(group.data, openedIds)}
        />
      );
    },
    [onPressSuggestion, openedIds],
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
        ref={listRef}
        data={flatData}
        keyExtractor={(it) => it.key}
        renderItem={renderItem}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={ListEmptyComponent}
        contentContainerStyle={{
          paddingTop: headerHeight + 12,
          paddingHorizontal: 16,
          paddingBottom: TAB_BAR_HEIGHT + 120,
        }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        viewabilityConfig={viewabilityConfig}
        onViewableItemsChanged={onViewableItemsChanged}
        onScrollToIndexFailed={onScrollToIndexFailed}
        initialNumToRender={6}
        windowSize={7}
        maxToRenderPerBatch={4}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={false}
        maintainVisibleContentPosition={{
          minIndexForVisible: 0,
          autoscrollToTopThreshold: 10,
        }}
      />
      <SectionJumpFab
        sections={sections}
        currentSectionId={currentSectionId}
        onJumpToSection={jumpToSection}
        onJumpToTop={jumpToTop}
      />
    </Box>
  );
};

export default FactSectionsFeed;
