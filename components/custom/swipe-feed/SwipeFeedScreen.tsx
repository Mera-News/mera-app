// SwipeFeedScreen — the "Deck" tab (landing tab). A Tinder-style card stack whose
// PRIMARY interaction is the thumbs VerdictBar (thumb-down = less like this,
// thumb-up = more like this, + Ask Mera); a horizontal swipe is a secondary quick
// verdict. The header is the "Your deck" heading + the 24h stats sentence, with
// round icon-only Back / Next controls ABOVE the card. Tapping a thumb records a
// verdict and floats the FeedbackCardOverlay over the (dimmed) top card; a
// terminal (non-openChat) leaf auto-advances the deck.

import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedPreparingCard from '@/components/custom/FeedPreparingCard';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import FeedStatsSentence from '@/components/custom/for-you/FeedStatsSentence';
import WhatsNewSheet from '@/components/custom/for-you/WhatsNewSheet';
import SwipeDeck, { type DeckWindowEntry } from './SwipeDeck';
import VerdictBar from './VerdictBar';
import FeedbackCardOverlay from './FeedbackCardOverlay';
import { swipeCallbacks } from './swipe-callbacks';
import { wireSwipeCallbacks } from '@/lib/services/swipe-feedback';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const H_MARGIN = 16;
const NAV_ACCENT = '#EDA77E';
const NAV_BUTTON_SIZE = 44;

/** A round, icon-only Back/Next control — mirrors the bordered circular buttons
 *  used across the app (ArticleActionsRow). Label lives in `accessibilityLabel`. */
const NavIconButton: React.FC<{
  icon: keyof typeof MaterialIcons.glyphMap;
  onPress: () => void;
  accessibilityLabel: string;
}> = ({ icon, onPress, accessibilityLabel }) => (
  <Pressable
    onPress={onPress}
    hitSlop={10}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel}
    className="items-center justify-center rounded-full"
    style={{
      width: NAV_BUTTON_SIZE,
      height: NAV_BUTTON_SIZE,
      borderWidth: 1.75,
      borderColor: NAV_ACCENT,
      backgroundColor: 'transparent',
    }}
  >
    <MaterialIcons name={icon} size={24} color={NAV_ACCENT} />
  </Pressable>
);

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

  // ── Feedback-tree overlay (floats OVER the top card once a thumb is tapped) ──
  const [treeOpen, setTreeOpen] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Any change of the top card (advance / Back) closes the overlay — a revisited
  // card shows its stored verdict on the thumbs but does NOT auto-open the tree.
  useEffect(() => {
    setTreeOpen(false);
  }, [topId]);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

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

  // ── VerdictBar (records a verdict, then opens the tree overlay — no advance) ──
  const handlePillVerdict = useCallback((verdict: Verdict) => {
    const cand = windowRef.current[0]?.candidate;
    if (!cand) return;
    useSwipeDeckStore.getState().setVerdict(cand.id, verdict);
    swipeCallbacks.onVerdict(cand.suggestion, verdict);
    setTreeOpen(true);
  }, []);

  const handlePillChanged = useCallback((from: Verdict, to: Verdict) => {
    const cand = windowRef.current[0]?.candidate;
    if (!cand) return;
    useSwipeDeckStore.getState().setVerdict(cand.id, to);
    swipeCallbacks.onVerdictChanged(cand.suggestion, from, to);
    setTreeOpen(true);
  }, []);

  const handleReopenTree = useCallback(() => setTreeOpen(true), []);

  const handleAskMera = useCallback(() => {
    const cand = windowRef.current[0]?.candidate;
    if (!cand) return;
    const rec = useSwipeDeckStore.getState().verdicts[cand.id];
    swipeCallbacks.onInvokeMera(cand.suggestion, rec?.verdict ?? 'like', rec?.path ?? []);
  }, []);

  // ── Feedback tree (inside the overlay) ──
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

  // Terminal (non-openChat) leaf tapped: path is already recorded — give the
  // selection a brief beat to register, then close the overlay + advance. The
  // verdict was recorded on the thumb tap, so this only needs the seen-impression
  // + advance (same path as Next on a decided card).
  const handleLeafCommitted = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      const cand = windowRef.current[0]?.candidate;
      setTreeOpen(false);
      if (cand) recordSeen(cand.suggestion);
      useSwipeDeckStore.getState().advance();
    }, 250);
  }, []);

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
      {/* Header — "Your deck" heading (top-left) + the 24h stats sentence. */}
      <VStack className="px-5 pb-2" space="xs" style={{ paddingTop: insets.top + 16 }}>
        <Heading size="3xl" className="text-white" numberOfLines={1}>
          {t('swipeFeed.yourDeck')}
        </Heading>
        <FeedStatsSentence />
      </VStack>

      {/* Back / Next — compact icon-only controls ABOVE the card. */}
      <HStack className="items-center justify-between px-5 pb-2">
        {cursor > 0 ? (
          <NavIconButton
            icon="chevron-left"
            onPress={handleBack}
            accessibilityLabel={t('swipeFeed.back')}
          />
        ) : (
          <View style={{ width: NAV_BUTTON_SIZE, height: NAV_BUTTON_SIZE }} />
        )}
        {showDeck ? (
          <NavIconButton
            icon="chevron-right"
            onPress={handleNext}
            accessibilityLabel={t('swipeFeed.next')}
          />
        ) : (
          <View style={{ width: NAV_BUTTON_SIZE, height: NAV_BUTTON_SIZE }} />
        )}
      </HStack>

      {/* Deck area. */}
      <View style={{ flex: 1, paddingHorizontal: H_MARGIN, paddingVertical: 8 }}>
        {showDeck ? (
          <SwipeDeck
            window={deckWindow}
            onSwipeVerdict={handleSwipeVerdict}
            onAdvanceSentinel={handleAdvanceSentinel}
            hMargin={H_MARGIN}
            topDimmed={treeOpen && topIsReal && topVerdict != null}
          />
        ) : (
          <View style={{ flex: 1, justifyContent: 'center' }}>{renderEmpty()}</View>
        )}

        {/* Feedback-tree overlay — floats over the (dimmed) top card. */}
        {treeOpen && topIsReal && topVerdict != null && topEntry?.candidate ? (
          <FeedbackCardOverlay
            key={topId ?? undefined}
            suggestion={topEntry.candidate.suggestion}
            verdict={topVerdict}
            initialPathIds={topId ? verdicts[topId]?.path : undefined}
            onClose={() => setTreeOpen(false)}
            onTreePathChanged={handleTreePathChanged}
            onInvokeMera={handleTreeInvokeMera}
            onLeafCommitted={handleLeafCommitted}
            onAskMera={handleAskMera}
          />
        ) : null}
      </View>

      {/* Controls — the thumbs VerdictBar (real cards only). */}
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
            onReopenTree={handleReopenTree}
            onAskMera={handleAskMera}
          />
        ) : null}
      </VStack>

      {/* One-time "What's new" sheet (moved here from ForYouScreen). */}
      <WhatsNewSheet />
    </Box>
  );
};

export default SwipeFeedScreen;
