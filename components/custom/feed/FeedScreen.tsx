// FeedScreen — the "For you" tab (landing tab). A static, insert-only vertical
// scroll feed of personalized story cards. The order is built ONCE when empty
// (first launch / post-wipe) and NEVER fully rebuilt — new Complete suggestions
// are INSERTED beyond the current viewport, and read (tapped) cards stay in
// place, dimmed. The order persists across app restarts (feed-order-store).
// Each card carries a small borderless action bar (like / dislike / Mera /
// save); tapping a thumb records a verdict and floats the FeedbackTreeSheet.
// The header is the "For you" heading + notification bell + 24h stats sentence.

import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedPreparingCard from '@/components/custom/FeedPreparingCard';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import FeedStatsSentence from '@/components/custom/for-you/FeedStatsSentence';
import WhatsNewSheet from '@/components/custom/for-you/WhatsNewSheet';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import { useVisibleIndex } from './use-visible-index';
import { useFeedbackSheet, type VerdictStoreAdapter } from './use-feedback-sheet';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useFeedBootstrap } from '@/lib/hooks/use-feed-bootstrap';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import {
  buildFeedList,
  type FeedListItem,
} from '@/lib/stores/feed-list-selector';
import { useFeedOrderStore, type Verdict } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useDatabaseReady } from '@/lib/stores/database-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { isSuggestionOpened } from '@/lib/stores/fact-rows-selector';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import {
  useForYouAsyncJobPhase,
  useForYouDeviceProcessing,
  useForYouHasGeneratedTopics,
  useForYouLastProcessingRunFinishedAt,
  useForYouSuggestions,
  useForYouSyncStatusMessage,
} from '@/lib/stores/selectors';
import { notifyScrollTick } from '@/lib/visibility-tick';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, RefreshControl } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const REFRESH_TINT = '#EDA77E';

// Module-constant empty exclusion set: candidates keep opened items (they back
// frozen rows for refresh + hydrate survival). Opened-exclusion happens only
// for NEW ids inside `ingest`.
const EMPTY_SET: Set<string> = new Set();

/** One rendered feed row. Subscribes to its OWN verdict + opened state so a
 *  verdict/open change re-renders only this row, not the whole list. The action
 *  handlers are the (stable) card-action handlers from `useFeedbackSheet`, which
 *  resolve the suggestion → list-item verdict key via the screen's adapter. */
const FeedRow = React.memo(function FeedRow({
  item,
  onPress,
  onVerdict,
  onAskMera,
}: {
  item: FeedListItem;
  onPress: (suggestion: ForYouSuggestion) => void;
  onVerdict: (suggestion: ForYouSuggestion, verdict: Verdict) => void;
  onAskMera: (suggestion: ForYouSuggestion) => void;
}) {
  const verdict = useFeedOrderStore((s) => s.verdicts[item.id]?.verdict ?? null);
  const read = useOpenedStoriesStore((s) => isSuggestionOpened(item.suggestion, s.ids));
  const extraSources = item.memberCount > 1 ? item.memberCount - 1 : 0;
  return (
    <ArticleSuggestionCard
      suggestion={item.suggestion}
      onPress={onPress}
      moreSourcesCount={extraSources}
      verdict={verdict}
      onVerdict={onVerdict}
      onAskMera={onAskMera}
      dimmed={verdict != null || read}
      read={read}
      flat
    />
  );
});

const FeedScreen: React.FC = () => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();

  const { isLoading, errorMessage } = useFeedBootstrap();

  // ── Live inputs ──
  const suggestions = useForYouSuggestions();

  // The user's geo/language context (home/other countries + app language) —
  // makes representative election tier-aware. Null while loading/on failure,
  // which `buildFeedList` treats as the legacy geo/language-blind pick.
  const userGeoLanguageCtx = useUserGeoLanguageContext();

  // Candidates keep opened items in (they back frozen rows + survive hydrate) —
  // no exclusion here; opened-filtering happens only for NEW ids in ingest.
  const candidates = useMemo(
    () => buildFeedList(suggestions, EMPTY_SET, Date.now(), userGeoLanguageCtx),
    [suggestions, userGeoLanguageCtx],
  );
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  // ── Persisted order store (reactive) ──
  const order = useFeedOrderStore((s) => s.order);
  const itemsById = useFeedOrderStore((s) => s.itemsById);
  const orderHydrated = useFeedOrderStore((s) => s.hydrated);
  const openedHydrated = useOpenedStoriesStore((s) => s.hydrated);

  // ── Freeze boundary (viewability → ref only; no store/DB writes mid-scroll) ──
  const { viewabilityConfigCallbackPairs, maxVisibleIndexRef } = useVisibleIndex();

  // Hydrate the persisted order ONCE, when the DB is ready. Evicts persisted ids
  // with no live backing item; restores survivors in their persisted order.
  const dbReady = useDatabaseReady();
  const didHydrate = useRef(false);
  useEffect(() => {
    if (!dbReady || didHydrate.current) return;
    didHydrate.current = true;
    void useFeedOrderStore.getState().hydrate(candidatesRef.current);
  }, [dbReady]);

  // Insert newly-Complete candidates while the tab is active (frozen ingest —
  // never reorders rows already laid out; freezes through viewport + 2).
  useEffect(() => {
    if (!isFocused || !orderHydrated || !openedHydrated) return;
    useFeedOrderStore
      .getState()
      .ingest(
        candidates,
        useOpenedStoriesStore.getState().ids,
        maxVisibleIndexRef.current + 2,
      );
  }, [candidates, isFocused, orderHydrated, openedHydrated, maxVisibleIndexRef]);

  const data = useMemo(
    () => order.map((id) => itemsById[id]).filter((it): it is FeedListItem => !!it),
    [order, itemsById],
  );
  const listData = data;

  // ── Feedback sheet (shared plumbing) ──
  // The verdict store is `feed-order-store`, keyed by the rep-switch-safe
  // list-item id. The card hands back the suggestion, so the adapter resolves
  // suggestion._id → list-item id via a ref map rebuilt from the live order.
  const openSuggestion = useOpenSuggestion('feed');

  const suggestionToItemId = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of data) m.set(it.suggestion._id, it.id);
    return m;
  }, [data]);
  const suggestionToItemIdRef = useRef(suggestionToItemId);
  suggestionToItemIdRef.current = suggestionToItemId;

  const feedAdapter: VerdictStoreAdapter = {
    keyFor: (s) => suggestionToItemIdRef.current.get(s._id) ?? null,
    getVerdict: (key) => useFeedOrderStore.getState().verdicts[key]?.verdict ?? null,
    setVerdict: (key, v) => useFeedOrderStore.getState().setVerdict(key, v),
    getPath: (key) => useFeedOrderStore.getState().verdicts[key]?.path,
    setPath: (key, path) => useFeedOrderStore.getState().setPath(key, path),
  };
  const { onVerdict, onAskMera, sheet } = useFeedbackSheet(feedAdapter);

  // ── Pull-to-refresh — trigger a feed sync ONLY. New completes then flow in
  //    via the ingest effect (inserted below the viewport); the order is never
  //    rebuilt. ──
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await AppScheduler.trigger('feed-sync').catch(() => {});
    setRefreshing(false);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: FeedListItem }) => (
      <FeedRow
        item={item}
        onPress={openSuggestion}
        onVerdict={onVerdict}
        onAskMera={onAskMera}
      />
    ),
    [openSuggestion, onVerdict, onAskMera],
  );

  const keyExtractor = useCallback((item: FeedListItem) => item.id, []);

  // ── Empty-state chain (mirrors ForYouScreen.renderEmpty priority) ──
  const hasGeneratedInterests = useForYouHasGeneratedTopics();
  const asyncJobPhase = useForYouAsyncJobPhase();
  const { isDeviceProcessing } = useForYouDeviceProcessing();
  const syncStatusMessage = useForYouSyncStatusMessage();
  const lastProcessingRunFinishedAt = useForYouLastProcessingRunFinishedAt();

  const isAnySyncActive =
    syncStatusMessage !== null &&
    syncStatusMessage.state !== 'idle' &&
    syncStatusMessage.state !== 'done' &&
    syncStatusMessage.state !== 'failed' &&
    syncStatusMessage.state !== 'paused-offline';
  const isFeedProcessing =
    isAnySyncActive || asyncJobPhase !== 'idle' || isDeviceProcessing;

  const renderEmpty = () => {
    if (isLoading) {
      return (
        <Box className="items-center justify-center py-20">
          <Spinner size="large" />
        </Box>
      );
    }
    if (errorMessage) {
      return (
        <Box className="items-center justify-center py-20 px-6">
          <Icon as={AlertCircleIcon} size="xl" className="text-error-400 mb-3" />
          <Text size="md" className="text-error-400 text-center font-semibold mb-1">
            {t('errors.failedToLoad')}
          </Text>
          <Text size="sm" className="text-typography-400 text-center">
            {errorMessage}
          </Text>
        </Box>
      );
    }
    if (!hasGeneratedInterests) {
      return <NoGeneratedInterestsCard />;
    }
    // Caught-up flash guard: only show AllCaughtUpCard once hydrated AND not
    // processing; otherwise the feed is still preparing.
    if (isFeedProcessing || lastProcessingRunFinishedAt === null) {
      return <FeedPreparingCard />;
    }
    return <AllCaughtUpCard />;
  };

  return (
    <Box className="flex-1 bg-black">
      {/* Header — "For you" heading (top-left) + notification bell (top-right),
          with the 24h stats sentence beneath. */}
      <VStack className="px-5 pb-2" space="xs" style={{ paddingTop: insets.top + 16 }}>
        <HStack className="items-start justify-between">
          <VStack className="flex-1 min-w-0 mr-3">
            <Heading size="3xl" className="text-white" numberOfLines={1}>
              {t('swipeFeed.yourDeck')}
            </Heading>
          </VStack>
          <HStack className="items-center flex-shrink-0" space="sm">
            <NotificationBellButton />
          </HStack>
        </HStack>
        <FeedStatsSentence />
      </VStack>

      <FlatList
        data={listData}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={() => notifyScrollTick()}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={REFRESH_TINT}
            colors={[REFRESH_TINT]}
          />
        }
        contentContainerStyle={{
          paddingHorizontal: 12,
          paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
          flexGrow: 1,
        }}
        ListEmptyComponent={renderEmpty()}
        ListFooterComponent={
          data.length > 0 ? (
            <Box style={{ marginTop: 16 }}>
              <AllCaughtUpCard />
            </Box>
          ) : null
        }
        initialNumToRender={4}
        windowSize={7}
        maxToRenderPerBatch={3}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={false}
      />

      {/* Feedback tree sheet — mounted once, driven by the shared hook. */}
      {sheet}

      {/* One-time "What's new" sheet (carried over from the old feed screen). */}
      <WhatsNewSheet />
    </Box>
  );
};

export default FeedScreen;
