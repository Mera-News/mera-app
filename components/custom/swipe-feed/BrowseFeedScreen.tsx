// BrowseFeedScreen — the Browse tab's vertical swipe deck (Wave 8, N3).
//
// A vertical, one-card-at-a-time snapping FlatList. Cards page with peek above/
// below; the snap-centered card is detected from scroll offset. Seen semantics
// are OPENS-ONLY: scrolling never drains the deck (impressions don't mark seen);
// only OPENING a story (tap the card body → recordOpen) excludes it next launch.
//
// Freshly-scored chunks fold into the deck live (swipe-feed-store's release
// listener). Because an insert can re-sort the unread region above the visible
// card, we re-center the SAME card after every deck change so it never jumps.

import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import SwipeCard from '@/components/custom/swipe-feed/SwipeCard';
import { useReduceMotion } from '@/components/custom/swipe-feed/useReduceMotion';
import { recordImpression, recordOpen } from '@/lib/database/services/story-impression-service';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import {
  useSwipeDeck,
  useSwipeFeedStore,
  useSwipeInitialized,
} from '@/lib/stores/swipe-feed-store';
import type { DeckCard } from '@/lib/news-harness/feed-select/deck';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef } from 'react';
import {
  FlatList,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const H_MARGIN = 16;
const GAP = 16;
/** Impressions fire only after a card has been centered this long (opens-only
 *  seen-state means impressions never exclude — this is a soft signal). */
const IMPRESSION_DWELL_MS = 600;

function titleNormOf(title: string | null | undefined): string | null {
  return (title ?? '').toLowerCase().trim().replace(/\s+/g, ' ') || null;
}

const BrowseFeedScreen: React.FC = () => {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();

  const deck = useSwipeDeck();
  const initialized = useSwipeInitialized();

  const cardSize = Math.max(0, width - 2 * H_MARGIN);
  const ITEM_HEIGHT = cardSize + GAP;

  // Visible band above the tab bar → vertical padding that centers the first/
  // last card and lets prev/next peek.
  const visibleHeight = Math.max(
    ITEM_HEIGHT,
    height - insets.top - insets.bottom - TAB_BAR_HEIGHT,
  );
  const verticalPad = Math.max(0, (visibleHeight - ITEM_HEIGHT) / 2);

  const flatListRef = useRef<FlatList<DeckCard>>(null);
  const centeredIndexRef = useRef(0);
  const centeredIdRef = useRef<string | null>(null);
  const impressionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const impressedIdsRef = useRef<Set<string>>(new Set());

  // --- Lifecycle: build the deck on mount, tear down the release listener. ---
  useEffect(() => {
    void useSwipeFeedStore.getState().initDeck();
    return () => {
      if (impressionTimerRef.current) clearTimeout(impressionTimerRef.current);
      useSwipeFeedStore.getState().teardown();
    };
  }, []);

  // --- Suppress the floating chat bubble on THIS tab only (the action row owns
  //     chat here). Keyed to the route via useFocusEffect. ---
  useFocusEffect(
    useCallback(() => {
      useFloatingChatStore.getState().setSuppressed(true);
      // A card can re-earn an impression once per focus.
      impressedIdsRef.current = new Set();
      return () => {
        useFloatingChatStore.getState().setSuppressed(false);
        if (impressionTimerRef.current) clearTimeout(impressionTimerRef.current);
      };
    }, []),
  );

  const fireImpression = useCallback((cardId: string) => {
    if (impressedIdsRef.current.has(cardId)) return;
    const s = useSwipeFeedStore.getState().suggestionsById.get(cardId);
    if (!s) return;
    impressedIdsRef.current.add(cardId);
    void recordImpression({
      articleId: s.articleId,
      suggestionId: s._id,
      stableClusterId:
        s.clusters.find((c) => c.stableClusterId)?.stableClusterId ?? null,
      titleNorm: titleNormOf(s.title_en),
      surface: 'swipe',
    });
  }, []);

  // Detect the snap-centered card from the scroll offset; arm the dwell timer.
  const onCentered = useCallback(
    (offsetY: number) => {
      const current = useSwipeFeedStore.getState().deck;
      if (current.length === 0) return;
      const raw = Math.round(offsetY / ITEM_HEIGHT);
      const idx = Math.min(Math.max(raw, 0), current.length - 1);
      const card = current[idx];
      if (!card) return;
      if (
        idx === centeredIndexRef.current &&
        card.id === centeredIdRef.current
      ) {
        return;
      }
      centeredIndexRef.current = idx;
      centeredIdRef.current = card.id;
      useSwipeFeedStore.getState().setCurrentCard(idx, card.id);

      if (impressionTimerRef.current) clearTimeout(impressionTimerRef.current);
      if (!impressedIdsRef.current.has(card.id)) {
        impressionTimerRef.current = setTimeout(
          () => fireImpression(card.id),
          IMPRESSION_DWELL_MS,
        );
      }
    },
    [ITEM_HEIGHT, fireImpression],
  );

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) =>
      onCentered(e.nativeEvent.contentOffset.y),
    [onCentered],
  );

  // --- Insertion no-jump: after any deck change, re-center the SAME card. ---
  useEffect(() => {
    const id = centeredIdRef.current;
    if (!id) return;
    const newIndex = deck.findIndex((c) => c.id === id);
    if (newIndex < 0) return;
    if (newIndex === centeredIndexRef.current) return;
    centeredIndexRef.current = newIndex;
    // Instant correction (never animated) so the visible card doesn't slide.
    requestAnimationFrame(() => {
      flatListRef.current?.scrollToOffset({
        offset: newIndex * ITEM_HEIGHT,
        animated: false,
      });
    });
  }, [deck, ITEM_HEIGHT]);

  const renderItem = useCallback(
    ({ item }: { item: DeckCard }) => {
      const s = useSwipeFeedStore.getState().suggestionsById.get(item.id);
      return (
        <View
          style={{ height: ITEM_HEIGHT, justifyContent: 'center' }}
        >
          {s ? (
            <SwipeCard
              suggestion={s}
              onOpenDetail={() => {
                void recordOpen({
                  articleId: s.articleId,
                  suggestionId: s._id,
                  stableClusterId:
                    s.clusters.find((c) => c.stableClusterId)?.stableClusterId ??
                    null,
                  titleNorm: titleNormOf(s.title_en),
                  surface: 'swipe',
                });
                router.push({
                  pathname: '/logged-in/suggestion-detail',
                  params: { articleSuggestionId: s._id },
                });
              }}
            />
          ) : null}
        </View>
      );
    },
    [ITEM_HEIGHT],
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<DeckCard> | null | undefined, index: number) => ({
      length: ITEM_HEIGHT,
      offset: ITEM_HEIGHT * index,
      index,
    }),
    [ITEM_HEIGHT],
  );

  // Empty state (also the "all caught up" end when the deck is empty).
  if (initialized && deck.length === 0) {
    return (
      <Box className="flex-1 bg-black">
        <VStack
          className="flex-1 items-center justify-center px-4"
          style={{ paddingBottom: TAB_BAR_HEIGHT + insets.bottom }}
        >
          <AllCaughtUpCard />
        </VStack>
      </Box>
    );
  }

  return (
    <Box className="flex-1 bg-black">
      <FlatList
        ref={flatListRef}
        data={deck}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_HEIGHT}
        snapToAlignment="start"
        decelerationRate={reduceMotion ? 'normal' : 'fast'}
        disableIntervalMomentum
        scrollEventThrottle={16}
        onScroll={onScroll}
        onMomentumScrollEnd={onScroll}
        onScrollToIndexFailed={() => {
          /* getItemLayout is O(1) so this shouldn't fire; no-op fallback. */
        }}
        contentContainerStyle={{
          paddingTop: verticalPad,
          paddingBottom: verticalPad,
        }}
        // The last real card is followed by the "all caught up" end card, so
        // paging past the final story lands on the mindful end state.
        ListFooterComponent={
          deck.length > 0 ? (
            <View
              style={{ height: ITEM_HEIGHT, justifyContent: 'center' }}
              className="px-1"
            >
              <AllCaughtUpCard />
            </View>
          ) : null
        }
      />
    </Box>
  );
};

export default BrowseFeedScreen;
