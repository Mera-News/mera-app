// FeedScreen — the "For you" tab (landing tab). An Instagram-style vertical
// scroll feed of personalized story cards (replaces the retired Tinder swipe
// deck). Each card carries a small borderless action bar (like / dislike / Mera
// / save); tapping a thumb records a verdict and floats the FeedbackTreeSheet.
// The header is the "For you" heading + notification bell + 24h stats sentence.

import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedPreparingCard from '@/components/custom/FeedPreparingCard';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import FeedStatsSentence from '@/components/custom/for-you/FeedStatsSentence';
import WhatsNewSheet from '@/components/custom/for-you/WhatsNewSheet';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import FeedArticleCard from './FeedArticleCard';
import FeedbackTreeSheet from './FeedbackTreeSheet';
import { markViewedImpression, useFeedImpressions } from './use-feed-impressions';
import { swipeCallbacks } from './swipe-callbacks';
import { wireSwipeCallbacks } from '@/lib/services/swipe-feedback';
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
  buildProvisionalFeedList,
  PROVISIONAL_FEED_CAP,
  type FeedListItem,
} from '@/lib/stores/feed-list-selector';
import {
  useFeedSessionStore,
  type Verdict,
} from '@/lib/stores/feed-session-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useViewedStoriesStore } from '@/lib/stores/viewed-stories-store';
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
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, RefreshControl } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const REFRESH_TINT = '#EDA77E';

// Install the real Feed-signal implementations onto the swipe-callbacks contract
// once, when this screen's module loads (before any render). Idempotent.
wireSwipeCallbacks();

/** Union of the opened + viewed seen sets — the exclusion buildFeedList uses. */
function excludedUnion(opened: Set<string>, viewed: Set<string>): Set<string> {
  const out = new Set(opened);
  for (const id of viewed) out.add(id);
  return out;
}

interface ActiveFeedback {
  suggestion: ForYouSuggestion;
  verdict: Verdict;
  initialPathIds?: string[];
}

const FeedScreen: React.FC = () => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();

  const { isLoading, errorMessage } = useFeedBootstrap();

  // ── Live inputs ──
  const suggestions = useForYouSuggestions();
  const openedIds = useOpenedStoriesStore((s) => s.ids);
  const viewedIds = useViewedStoriesStore((s) => s.ids);

  // Hydrate the viewed-story set on mount + refocus (useFeedBootstrap already
  // hydrates the opened set the same way).
  useEffect(() => {
    void useViewedStoriesStore.getState().hydrate();
  }, []);
  useEffect(() => {
    if (isFocused) void useViewedStoriesStore.getState().hydrate();
  }, [isFocused]);

  // The user's geo/language context (home/other countries + app language) —
  // makes representative election tier-aware. Null while loading/on failure,
  // which `buildFeedList` treats as the legacy geo/language-blind pick.
  const userGeoLanguageCtx = useUserGeoLanguageContext();

  const candidates = useMemo(
    () => buildFeedList(suggestions, excludedUnion(openedIds, viewedIds), Date.now(), userGeoLanguageCtx),
    [suggestions, openedIds, viewedIds, userGeoLanguageCtx],
  );
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  // ── Session order store (reactive) ──
  const order = useFeedSessionStore((s) => s.order);
  const itemsById = useFeedSessionStore((s) => s.itemsById);
  const verdicts = useFeedSessionStore((s) => s.verdicts);

  // Snapshot-vs-resume decision runs ONCE per focus (reads latest candidates).
  useFocusEffect(
    useCallback(() => {
      useFeedSessionStore.getState().onTabFocus(candidatesRef.current);
    }, []),
  );
  // Pick up newly-synced / rescored candidates while the tab is active (frozen
  // ingest — never reorders rows already laid out in front of the user).
  useEffect(() => {
    if (!isFocused) return;
    useFeedSessionStore.getState().ingest(candidates);
  }, [candidates, isFocused]);

  const data = useMemo(
    () => order.map((id) => itemsById[id]).filter((it): it is FeedListItem => !!it),
    [order, itemsById],
  );

  // ── Provisional feed (P7c) — the pre-scoring fallback. When the real ranked
  //    list is empty (post-wipe / fresh install / ManageData clear), render the
  //    newest in-window stories UNSCORED so the feed isn't blank for tens of
  //    seconds to minutes. It DELIBERATELY BYPASSES the feed-session-store — the
  //    frozen session order starts only from the real ranked list, so scrolled
  //    provisional cards are never baked into the session — and is swapped out
  //    wholesale the moment ≥1 real row exists (`data.length > 0`).
  const provisional = useMemo(
    () =>
      data.length === 0
        ? buildProvisionalFeedList(
            suggestions,
            excludedUnion(openedIds, viewedIds),
            Date.now(),
            PROVISIONAL_FEED_CAP,
            userGeoLanguageCtx,
          )
        : [],
    [data.length, suggestions, openedIds, viewedIds, userGeoLanguageCtx],
  );
  const showProvisional = data.length === 0 && provisional.length > 0;
  const listData = showProvisional ? provisional : data;

  // ── Impressions (viewability → mark-viewed) ──
  // Suppressed while provisional: scrolled-past UNSCORED cards must NOT be added
  // to the viewed set, or they'd be excluded forever once the real feed lands.
  const { viewabilityConfigCallbackPairs } = useFeedImpressions(isFocused && !showProvisional);

  // ── Feedback sheet ──
  const [activeFeedback, setActiveFeedback] = useState<ActiveFeedback | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  // ── Handlers ──
  const openSuggestion = useOpenSuggestion('feed');

  const handleVerdict = useCallback((item: FeedListItem, next: Verdict) => {
    const store = useFeedSessionStore.getState();
    const existing = store.verdicts[item.id]?.verdict ?? null;
    if (existing === next) {
      // Re-tap of the same thumb — reopen the sheet on the stored path; no re-record.
    } else if (existing != null) {
      store.setVerdict(item.id, next);
      swipeCallbacks.onVerdictChanged(item.suggestion, existing, next);
    } else {
      store.setVerdict(item.id, next);
      swipeCallbacks.onVerdict(item.suggestion, next);
    }
    markViewedImpression(item.suggestion);
    setActiveFeedback({
      suggestion: item.suggestion,
      verdict: next,
      initialPathIds: useFeedSessionStore.getState().verdicts[item.id]?.path,
    });
  }, []);

  const handleAskMera = useCallback((item: FeedListItem) => {
    swipeCallbacks.onOpenArticleChat(item.suggestion);
  }, []);

  const closeSheet = useCallback(() => setActiveFeedback(null), []);

  // Sheet callbacks (map 1:1 to the old overlay handlers, minus deck advance).
  const handleTreePathChanged = useCallback(
    (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
      useFeedSessionStore.getState().setPath(s.articleId, pathIds);
      swipeCallbacks.onTreePathChanged(s, v, pathIds);
    },
    [],
  );

  const handleTreeInvokeMera = useCallback(
    (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
      swipeCallbacks.onInvokeMera(s, v, pathIds);
    },
    [],
  );

  // Terminal (non-openChat) leaf: path already recorded — settle briefly, close.
  const handleLeafCommitted = useCallback(
    (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
      useFeedSessionStore.getState().setPath(s.articleId, pathIds);
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => setActiveFeedback(null), 250);
    },
    [],
  );

  // Sheet's Mera entry row — the verdict + path-primed handoff.
  const handleSheetAskMera = useCallback(() => {
    setActiveFeedback((current) => {
      if (current) {
        const rec = useFeedSessionStore.getState().verdicts[current.suggestion.articleId];
        swipeCallbacks.onInvokeMera(
          current.suggestion,
          rec?.verdict ?? current.verdict,
          rec?.path ?? [],
        );
      }
      return current;
    });
  }, []);

  // ── Pull-to-refresh — trigger a feed sync, then rebuild from the latest pool. ──
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await AppScheduler.trigger('feed-sync').catch(() => {});
    const latest = useForYouStore.getState().suggestions;
    const excluded = excludedUnion(
      useOpenedStoriesStore.getState().ids,
      useViewedStoriesStore.getState().ids,
    );
    useFeedSessionStore.getState().rebuild(buildFeedList(latest, excluded, Date.now(), userGeoLanguageCtx));
    setRefreshing(false);
  }, [userGeoLanguageCtx]);

  const renderItem = useCallback(
    ({ item }: { item: FeedListItem }) => (
      <FeedArticleCard
        item={item}
        verdict={verdicts[item.id]?.verdict ?? null}
        onPress={openSuggestion}
        onVerdict={handleVerdict}
        onAskMera={handleAskMera}
      />
    ),
    [verdicts, openSuggestion, handleVerdict, handleAskMera],
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
        ListHeaderComponent={
          showProvisional ? (
            <Box className="px-1 pb-2">
              <Text size="xs" className="text-typography-400 leading-4">
                {t('feed.personalizingFeed')}
              </Text>
            </Box>
          ) : null
        }
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

      {/* Feedback tree sheet — mounted once, driven by activeFeedback. */}
      <FeedbackTreeSheet
        suggestion={activeFeedback?.suggestion ?? null}
        verdict={activeFeedback?.verdict ?? null}
        initialPathIds={activeFeedback?.initialPathIds}
        onClose={closeSheet}
        onTreePathChanged={handleTreePathChanged}
        onInvokeMera={handleTreeInvokeMera}
        onLeafCommitted={handleLeafCommitted}
        onAskMera={handleSheetAskMera}
      />

      {/* One-time "What's new" sheet (carried over from the old feed screen). */}
      <WhatsNewSheet />
    </Box>
  );
};

export default FeedScreen;
