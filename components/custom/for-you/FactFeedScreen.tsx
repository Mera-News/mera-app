import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import { useFeedbackSheet, type VerdictStoreAdapter } from '@/components/custom/feed/use-feedback-sheet';
import { useFeedbackDismissedStore } from '@/lib/stores/feedback-dismissed-store';
import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import {
  GLASS_HEADER_SCRIM,
  GLASS_HEADER_TINT,
  GlassPlate,
} from '@/components/custom/GlassSurface';
import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import logger from '@/lib/logger';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import {
  buildFactRows,
  isHeadlineSectionId,
  isSuggestionOpened,
  type FactRowGroup,
} from '@/lib/stores/fact-rows-selector';
import { loadSectionSnapshots, type SectionSnapshots } from '@/lib/stores/section-snapshots';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useForYouSuggestions } from '@/lib/stores/selectors';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useSectionVisitsStore } from '@/lib/stores/section-visits-store';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import type { Verdict } from '@/lib/stores/feed-order-store';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Show the scroll-to-top FAB once the list is scrolled past this many px. */
const SCROLL_THRESHOLD = 300;

interface FactFeedScreenProps {
  /** The SECTION id — a fact id, or a synthetic headline-scope id (see
   *  `isHeadlineSectionId`). Both address a row in `buildFactRows`. */
  factId: string;
  /** Section display title, passed through from the row header (avoids a reload
   *  flash before the snapshots hydrate). For a fact section this is the fact
   *  statement (user data); for a headline section it is already-localized app
   *  copy. */
  statement: string;
}

/**
 * The full feed for a single fact (Round-3 C2). Reached by tapping a fact row's
 * header. Plain vertical list of full article cards, pubDate desc; each collapsed
 * story shows the newest member (so the card's timestamp is the newest member's
 * pubDate).
 */
const FactFeedScreen: React.FC<FactFeedScreenProps> = ({ factId, statement }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const suggestions = useForYouSuggestions();
  const openedIds = useOpenedStoriesStore((s) => s.ids);
  const handlePress = useOpenSuggestion('sectioned');
  const [snapshots, setSnapshots] = useState<SectionSnapshots | null>(null);
  const isHeadline = isHeadlineSectionId(factId);

  // Last-visit timestamp captured on entry (before we mark this visit) — drives
  // the per-card NEW badge. `null` until hydrated; `0` on a first-ever visit
  // (⇒ no badges, avoiding first-run badge spam).
  const [prevVisitMs, setPrevVisitMs] = useState<number | null>(null);

  useEffect(() => {
    void useOpenedStoriesStore.getState().hydrate();
    let cancelled = false;
    loadSectionSnapshots()
      .then((s) => { if (!cancelled) setSnapshots(s); })
      .catch((err: unknown) => {
        logger.captureException(err, {
          tags: { screen: 'FactFeedScreen', method: 'loadSectionSnapshots' },
        });
      });
    return () => { cancelled = true; };
  }, []);

  // Visit tracking: read the prior visit time, then mark this section visited
  // (both on entry and again on unmount, so a long dwell still advances the
  // clock). Keyed by factId so navigating between fact feeds re-runs it.
  useEffect(() => {
    let cancelled = false;
    void useSectionVisitsStore.getState().hydrate().then(() => {
      if (cancelled) return;
      setPrevVisitMs(useSectionVisitsStore.getState().visits[factId] ?? 0);
      useSectionVisitsStore.getState().markVisited(factId);
    });
    return () => {
      cancelled = true;
      useSectionVisitsStore.getState().markVisited(factId);
    };
  }, [factId]);

  // The user's geo/language context (home/other countries + app language) —
  // makes representative election tier-aware. Null while loading/on failure,
  // which `buildFactRows` treats as the legacy geo/language-blind pick.
  const userGeoLanguageCtx = useUserGeoLanguageContext();

  const groups: FactRowGroup[] = useMemo(() => {
    if (!snapshots) return [];
    const { rows } = buildFactRows(suggestions, snapshots, openedIds, Date.now(), DEFAULT_HARNESS_CONFIG, userGeoLanguageCtx);
    const found = rows.find((r) => r.factId === factId)?.groups ?? [];
    // Order this screen by article publication freshness — newest PUBLISHED on
    // top (`pubDateMs`), not suggestion-creation time (the shared `cardCompare`
    // the Dashboard uses). Copy before sorting so the selector's array is left
    // untouched. Tiebreak on `_id` for a stable order.
    return [...found].sort(
      (a, b) =>
        b.pubDateMs - a.pubDateMs ||
        (a.data._id < b.data._id ? -1 : a.data._id > b.data._id ? 1 : 0),
    );
  }, [snapshots, suggestions, factId, openedIds, userGeoLanguageCtx]);

  // ── Scroll-to-top FAB ──
  const listRef = useRef<FlatList<FactRowGroup>>(null);
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = e.nativeEvent.contentOffset.y > SCROLL_THRESHOLD;
    // Functional update → only re-render when the boolean actually flips.
    setShowScrollToTop((prev) => (prev === next ? prev : next));
  }, []);
  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // ── Feedback sheet ──
  // Unlike the For You feed (which persists its order + verdicts), this screen
  // keeps verdicts in a component-local store keyed by articleId. The signal
  // persistence (article_feedback rows / Mera handoff) still goes through the
  // shared `swipeCallbacks` inside the hook, identical to the feed.
  const [verdicts, setVerdicts] = useState<
    Record<string, { verdict: Verdict; path: string[]; committed?: boolean }>
  >({});
  const verdictsRef = useRef(verdicts);
  verdictsRef.current = verdicts;

  const factAdapter: VerdictStoreAdapter = {
    keyFor: (s) => s.articleId,
    getVerdict: (key) => verdictsRef.current[key]?.verdict ?? null,
    setVerdict: (key, v) =>
      setVerdicts((prev) => {
        if (v == null) {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return { ...prev, [key]: { verdict: v, path: prev[key]?.path ?? [] } };
      }),
    getPath: (key) => verdictsRef.current[key]?.path,
    setPath: (key, path) =>
      setVerdicts((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], path } } : prev)),
    getCommitted: (key) => !!verdictsRef.current[key]?.committed,
    setCommitted: (key, committed) =>
      setVerdicts((prev) =>
        prev[key] ? { ...prev, [key]: { ...prev[key], committed } } : prev,
      ),
  };
  const { onVerdict, onAskMera, feedbackHandlers } = useFeedbackSheet(factAdapter);
  const dismissedMap = useFeedbackDismissedStore((s) => s.dismissed);

  const renderItem = useCallback(
    ({ item }: { item: FactRowGroup }) => {
      const rec = verdicts[item.data.articleId];
      const verdict = rec?.verdict ?? null;
      return (
        <ArticleSuggestionCard
          suggestion={item.data}
          onPress={handlePress}
          verdict={verdict}
          onVerdict={onVerdict}
          onAskMera={onAskMera}
          feedbackVisible={verdict != null && !dismissedMap[item.data.articleId]}
          feedbackInitialPath={rec?.path}
          feedbackCommitted={!!rec?.committed}
          feedbackHandlers={feedbackHandlers}
          read={isSuggestionOpened(item.data, openedIds)}
          // NEW pill only for stories that became visible since the last visit —
          // and never on a first-ever visit (prevVisitMs 0).
          isNew={prevVisitMs != null && prevVisitMs > 0 && item.addedMs > prevVisitMs}
          flat
        />
      );
    },
    [handlePress, openedIds, prevVisitMs, verdicts, dismissedMap, onVerdict, onAskMera, feedbackHandlers],
  );

  return (
    // No `bg-black`: the AbstractGradientBackdrop below is the page background.
    <Box className="flex-1">
      {/* Page background. Must be the FIRST child so it paints behind
          everything else on the page, exactly as the tab screens mount it.
          Seeded with the SECTION id, so every fact list draws its own stable
          palette walk instead of all of them sharing one look. */}
      <AbstractGradientBackdrop seed={factId} />

      {/* Header material. This wrapper is deliberately UNPADDED (all padding
          lives on the HStack below) because `GlassPlate` is an absolute fill
          resolved against the CONTENT box — see GlassSurface.

          The scrim is painted in BOTH branches, not just under glass: unlike
          the tab screens' headers this one sits in normal flow with nothing
          scrolling underneath it, so it has no reason to be opaque, and a flat
          black band here would punch a hole in the very gradient this screen
          is supposed to show. Translucent dark keeps the small
          `text-typography-500` prefix readable over a bright blob while the
          field still reads as continuous top-to-bottom.

          No border here: the HStack below already owns the divider, and a
          second hairline on this wrapper would both double the line and add a
          pixel of height. */}
      <Box testID="fact-feed-header" style={{ backgroundColor: GLASS_HEADER_SCRIM }}>
        <GlassPlate tint={GLASS_HEADER_TINT} />
        <HStack
          className="items-center px-4 pb-3 border-b border-gray-900"
          style={{ paddingTop: insets.top + 12 }}
          space="sm"
        >
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
          >
            <MaterialIcons name="arrow-back" size={24} color="#FFFFFF" />
          </Pressable>
          <Box className="flex-1 min-w-0">
            {/* A headline section is not "News about:" anything, and its title
                is app copy already in the reader's language — running it through
                TranslatableDynamic would machine-translate a localized string. */}
            {!isHeadline && (
              <Text size="xs" className="text-typography-500">{t('forYou.sectionPrefix')}</Text>
            )}
            {isHeadline ? (
              <Text size="lg" bold numberOfLines={1} className="text-white">
                {statement}
              </Text>
            ) : (
              <TranslatableDynamic
                text={statement}
                as="heading"
                size="lg"
                bold
                numberOfLines={1}
                className="text-white"
              />
            )}
          </Box>
        </HStack>
      </Box>
      <FlatList
        ref={listRef}
        data={groups}
        keyExtractor={(g) => g.data._id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 16, paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        ListEmptyComponent={<AllCaughtUpCard />}
      />

      <ScrollToTopFab visible={showScrollToTop} onPress={scrollToTop} />
    </Box>
  );
};

export default FactFeedScreen;
