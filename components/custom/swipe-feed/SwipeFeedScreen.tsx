// SwipeFeedScreen — the Feed tab (landing tab). A Tinder-style card stack whose
// PRIMARY interaction is the labeled VerdictBar ("Less like this" / "More like
// this" + Ask Mera); a horizontal swipe is a secondary quick verdict. The header
// is ONLY the 24h stats sentence. Below the deck: the VerdictBar, a "Next ›"
// advance control, and a "‹ Back" control (once past the first card).
//
// This phase ships the tab/deck/cards/verdict-bar + the swipe-callbacks contract
// (no-op defaults). P4 fills the callbacks + the inline-feedback tree (treeSlot).

import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedPreparingCard from '@/components/custom/FeedPreparingCard';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import FeedStatsSentence from '@/components/custom/for-you/FeedStatsSentence';
import WhatsNewSheet from '@/components/custom/for-you/WhatsNewSheet';
import SwipeDeck, { type DeckWindowEntry } from './SwipeDeck';
import VerdictBar from './VerdictBar';
import InlineFeedbackTree from './InlineFeedbackTree';
import { swipeCallbacks } from './swipe-callbacks';
import { wireSwipeCallbacks } from '@/lib/services/swipe-feedback';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import { useFeedBootstrap } from '@/lib/hooks/use-feed-bootstrap';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import {
  useForYouAsyncJobPhase,
  useForYouDeviceProcessing,
  useForYouHasGeneratedTopics,
  useForYouLastProcessingRunFinishedAt,
  useForYouSuggestions,
  useForYouSyncStatusMessage,
} from '@/lib/stores/selectors';
import {
  CAUGHT_UP_SENTINEL,
  useSwipeDeckStore,
  type Verdict,
} from '@/lib/stores/swipe-deck-store';
import { buildSwipeStack } from '@/lib/stores/swipe-stack-selector';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const H_MARGIN = 16;

// Install the real Feed-signal implementations onto the swipe-callbacks contract
// once, when this screen's module loads (before any render). Idempotent.
wireSwipeCallbacks();

/** Record an open impression for a story on the swipe surface (dim + persist).
 *  recordOpen upserts, so calling it on every advance is idempotent. */
function recordSeen(s: ForYouSuggestion) {
  const stableClusterId =
    s.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? null;
  useOpenedStoriesStore.getState().markOpened(s.articleId, stableClusterId);
  void recordOpen({
    articleId: s.articleId,
    suggestionId: s._id,
    stableClusterId,
    titleNorm: (s.title_en ?? '').toLowerCase().trim().replace(/\s+/g, ' ') || null,
    surface: 'swipe',
  });
}

const SwipeFeedScreen: React.FC = () => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();

  const { isLoading, errorMessage } = useFeedBootstrap();

  // ── Live inputs ──
  const suggestions = useForYouSuggestions();
  const openedIds = useOpenedStoriesStore((s) => s.ids);
  const candidates = useMemo(
    () => buildSwipeStack(suggestions, openedIds),
    [suggestions, openedIds],
  );
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  // ── Deck store (reactive layout) ──
  const order = useSwipeDeckStore((s) => s.order);
  const cursor = useSwipeDeckStore((s) => s.cursor);
  const cardsById = useSwipeDeckStore((s) => s.cardsById);
  const verdicts = useSwipeDeckStore((s) => s.verdicts);

  // Snapshot-vs-resume decision runs ONCE per focus (reads latest candidates).
  useFocusEffect(
    useCallback(() => {
      useSwipeDeckStore.getState().onTabFocus(candidatesRef.current);
    }, []),
  );
  // Pick up newly-synced / rescored candidates while the tab is active (frozen
  // ingest — never reshuffles cards already laid out in front of the user).
  useEffect(() => {
    if (!isFocused) return;
    useSwipeDeckStore.getState().ingest(candidates);
  }, [candidates, isFocused]);

  // ── The visible 3-card window ──
  const deckWindow: DeckWindowEntry[] = useMemo(() => {
    const out: DeckWindowEntry[] = [];
    for (let i = cursor; i < Math.min(order.length, cursor + 3); i += 1) {
      const id = order[i];
      if (id === CAUGHT_UP_SENTINEL) {
        out.push({ key: `${CAUGHT_UP_SENTINEL}#${i}`, candidate: null, isSentinel: true });
      } else {
        out.push({ key: `${id}#${i}`, candidate: cardsById[id] ?? null, isSentinel: false });
      }
    }
    return out;
  }, [order, cursor, cardsById]);
  const windowRef = useRef(deckWindow);
  windowRef.current = deckWindow;

  const topEntry = deckWindow[0];
  const topIsReal = !!topEntry && !topEntry.isSentinel && !!topEntry.candidate;
  const showDeck = deckWindow.length > 0;
  const topId = topEntry?.candidate?.id ?? null;
  const topVerdict: Verdict | null = topId ? verdicts[topId]?.verdict ?? null : null;

  // ── Commit paths ──
  const handleSwipeVerdict = useCallback((verdict: Verdict) => {
    const cand = windowRef.current[0]?.candidate;
    if (!cand) return;
    useSwipeDeckStore.getState().setVerdict(cand.id, verdict);
    swipeCallbacks.onVerdict(cand.suggestion, verdict);
    recordSeen(cand.suggestion);
    useSwipeDeckStore.getState().advance();
  }, []);

  const handleAdvanceSentinel = useCallback(() => {
    useSwipeDeckStore.getState().advance();
  }, []);

  const handleNext = useCallback(() => {
    const entry = windowRef.current[0];
    if (!entry) return;
    if (entry.isSentinel || !entry.candidate) {
      useSwipeDeckStore.getState().advance();
      return;
    }
    // Seen-only advance when undecided (no signal); if a verdict was already
    // set via a pill, it was recorded then — just record the open + advance.
    recordSeen(entry.candidate.suggestion);
    useSwipeDeckStore.getState().advance();
  }, []);

  const handleBack = useCallback(() => {
    useSwipeDeckStore.getState().goBack();
  }, []);

  // ── VerdictBar (no advance) ──
  const handlePillVerdict = useCallback((verdict: Verdict) => {
    const cand = windowRef.current[0]?.candidate;
    if (!cand) return;
    useSwipeDeckStore.getState().setVerdict(cand.id, verdict);
    swipeCallbacks.onVerdict(cand.suggestion, verdict);
  }, []);

  const handlePillChanged = useCallback((from: Verdict, to: Verdict) => {
    const cand = windowRef.current[0]?.candidate;
    if (!cand) return;
    useSwipeDeckStore.getState().setVerdict(cand.id, to);
    swipeCallbacks.onVerdictChanged(cand.suggestion, from, to);
  }, []);

  const handleAskMera = useCallback(() => {
    const cand = windowRef.current[0]?.candidate;
    if (!cand) return;
    const rec = useSwipeDeckStore.getState().verdicts[cand.id];
    swipeCallbacks.onInvokeMera(cand.suggestion, rec?.verdict ?? 'like', rec?.path ?? []);
  }, []);

  // ── Inline feedback tree (under the VerdictBar) ──
  const handleTreePathChanged = useCallback(
    (suggestion: ForYouSuggestion, verdict: Verdict, pathIds: string[]) => {
      const cand = windowRef.current[0]?.candidate;
      if (cand) useSwipeDeckStore.getState().setPath(cand.id, pathIds);
      swipeCallbacks.onTreePathChanged(suggestion, verdict, pathIds);
    },
    [],
  );

  const handleTreeInvokeMera = useCallback(
    (suggestion: ForYouSuggestion, verdict: Verdict, pathIds: string[]) => {
      swipeCallbacks.onInvokeMera(suggestion, verdict, pathIds);
    },
    [],
  );

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
      {/* Header — the stats sentence is the ONLY header element this phase. */}
      <VStack className="px-5 pb-3" style={{ paddingTop: insets.top + 16 }}>
        <FeedStatsSentence />
      </VStack>

      {/* Deck area. */}
      <View style={{ flex: 1, paddingHorizontal: H_MARGIN, paddingVertical: 8 }}>
        {showDeck ? (
          <SwipeDeck
            window={deckWindow}
            onSwipeVerdict={handleSwipeVerdict}
            onAdvanceSentinel={handleAdvanceSentinel}
            hMargin={H_MARGIN}
          />
        ) : (
          <View style={{ flex: 1, justifyContent: 'center' }}>{renderEmpty()}</View>
        )}
      </View>

      {/* Controls — VerdictBar (real cards only) + Next / Back. */}
      <VStack
        className="px-5"
        space="md"
        style={{ paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 12, paddingTop: 4 }}
      >
        {topIsReal ? (
          <VerdictBar
            verdict={topVerdict}
            onVerdict={handlePillVerdict}
            onVerdictChanged={handlePillChanged}
            onAskMera={handleAskMera}
            treeSlot={
              topVerdict != null && topEntry?.candidate ? (
                <InlineFeedbackTree
                  key={topId ?? undefined}
                  suggestion={topEntry.candidate.suggestion}
                  verdict={topVerdict}
                  onTreePathChanged={handleTreePathChanged}
                  onInvokeMera={handleTreeInvokeMera}
                  initialPathIds={topId ? verdicts[topId]?.path : undefined}
                />
              ) : undefined
            }
          />
        ) : null}

        <HStack className="items-center justify-between">
          {cursor > 0 ? (
            <Pressable
              onPress={handleBack}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('swipeFeed.back')}
            >
              <Text size="md" className="text-typography-400">
                {`‹ ${t('swipeFeed.back')}`}
              </Text>
            </Pressable>
          ) : (
            <View />
          )}
          {showDeck ? (
            <Pressable
              onPress={handleNext}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('swipeFeed.next')}
            >
              <Text size="md" className="text-primary-400 font-semibold">
                {`${t('swipeFeed.next')} ›`}
              </Text>
            </Pressable>
          ) : (
            <View />
          )}
        </HStack>
      </VStack>

      {/* One-time "What's new" sheet (moved here from ForYouScreen). */}
      <WhatsNewSheet />
    </Box>
  );
};

export default SwipeFeedScreen;
