import BreakingStrip from '@/components/custom/for-you/BreakingStrip';
import FactSectionHeader from '@/components/custom/for-you/FactSectionHeader';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
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
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { router } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  useWindowDimensions,
  View,
} from 'react-native';

const SCROLL_THRESHOLD = 300;
/** Rows rendered on first paint; grows by this each `onEndReached`. */
const ROWS_PER_PAGE = 3;
const CARD_WIDTH_RATIO = 0.82; // second card peeks
const CARD_GAP = 12;

interface FactRowsFeedProps {
  breaking: BreakingCardData[];
  rows: FactRow[];
  onPressSuggestion: (s: ForYouSuggestion) => void;
  ListEmptyComponent?: React.ComponentType<any> | React.ReactElement | null;
  ListFooterComponent?: React.ComponentType<any> | React.ReactElement | null;
}

// --- one fact row (header + horizontal card strip) ------------------------

interface FactRowViewProps {
  row: FactRow;
  cardWidth: number;
  openedIds: Set<string>;
  onPressSuggestion: (s: ForYouSuggestion) => void;
}

const FactRowView: React.FC<FactRowViewProps> = React.memo(
  ({ row, cardWidth, openedIds, onPressSuggestion }) => {
    const openFactFeed = useCallback(() => {
      router.push({
        pathname: '/logged-in/fact-feed',
        params: { factId: row.factId, statement: row.statement },
      });
    }, [row.factId, row.statement]);

    const renderCard = useCallback(
      ({ item }: { item: FactRowGroup }) => (
        <View style={{ width: cardWidth, marginRight: CARD_GAP }}>
          <ArticleSuggestionCompactCard
            suggestion={item.data}
            onPress={onPressSuggestion}
            surface="for_you"
            dimmed={isSuggestionOpened(item.data, openedIds)}
          />
        </View>
      ),
      [cardWidth, openedIds, onPressSuggestion],
    );

    return (
      <View>
        <FactSectionHeader
          kind={row.kind}
          title={row.statement}
          eventType={row.groups[0]?.data.eventType ?? null}
          onPress={row.kind === 'fact' ? openFactFeed : undefined}
        />
        <FlatList
          data={row.groups}
          keyExtractor={(g) => g.data._id}
          renderItem={renderCard}
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={cardWidth + CARD_GAP}
          snapToAlignment="start"
          decelerationRate="fast"
          disableIntervalMomentum
          removeClippedSubviews={false}
        />
      </View>
    );
  },
);
FactRowView.displayName = 'FactRowView';

// --- vertical rows feed ----------------------------------------------------

const FactRowsFeed: React.FC<FactRowsFeedProps> = ({
  breaking,
  rows,
  onPressSuggestion,
  ListEmptyComponent,
  ListFooterComponent,
}) => {
  const { width } = useWindowDimensions();
  const cardWidth = Math.round(width * CARD_WIDTH_RATIO);
  const openedIds = useOpenedStoriesStore((s) => s.ids);

  const listRef = useRef<FlatList<FactRow>>(null);
  const [visibleCount, setVisibleCount] = useState(ROWS_PER_PAGE);
  const [showScrollToTop, setShowScrollToTop] = useState(false);

  // Client-side row windowing: reveal ROWS_PER_PAGE more each time the user
  // nears the end. Reset when the row set shrinks below the current window.
  const visibleRows = useMemo(() => rows.slice(0, visibleCount), [rows, visibleCount]);

  const onEndReached = useCallback(() => {
    setVisibleCount((c) => (c < rows.length ? c + ROWS_PER_PAGE : c));
  }, [rows.length]);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setShowScrollToTop(e.nativeEvent.contentOffset.y > SCROLL_THRESHOLD);
    notifyScrollTick();
  }, []);

  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  const renderRow = useCallback(
    ({ item }: { item: FactRow }) => (
      <FactRowView
        row={item}
        cardWidth={cardWidth}
        openedIds={openedIds}
        onPressSuggestion={onPressSuggestion}
      />
    ),
    [cardWidth, openedIds, onPressSuggestion],
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
      <FlatList
        ref={listRef}
        data={visibleRows}
        keyExtractor={(r) => r.factId}
        renderItem={renderRow}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={ListEmptyComponent}
        ListFooterComponent={ListFooterComponent}
        contentContainerStyle={{ paddingVertical: 20, paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        windowSize={7}
        maxToRenderPerBatch={ROWS_PER_PAGE}
        initialNumToRender={ROWS_PER_PAGE}
        updateCellsBatchingPeriod={50}
        maintainVisibleContentPosition={{
          minIndexForVisible: 0,
          autoscrollToTopThreshold: 10,
        }}
      />
      <ScrollToTopFab
        visible={showScrollToTop}
        onPress={scrollToTop}
        extraBottomOffset={TAB_BAR_HEIGHT}
      />
    </Box>
  );
};

export default FactRowsFeed;
