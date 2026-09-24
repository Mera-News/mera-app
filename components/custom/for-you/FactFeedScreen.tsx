import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import { useFeedbackSheet, type VerdictStoreAdapter } from '@/components/custom/feed/use-feedback-sheet';
import { useFeedbackDismissedStore } from '@/lib/stores/feedback-dismissed-store';
import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import {
  GLASS_HEADER_SCRIM,
  GLASS_HEADER_TINT,
  GlassHeaderAndroidBackdrop,
  GlassPlate,
} from '@/components/custom/GlassSurface';
import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import NextSectionFooter from '@/components/custom/for-you/NextSectionFooter';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import {
  buildFactRows,
  isHeadlineSectionId,
  isSuggestionOpened,
  type FactRow,
  type FactRowGroup,
} from '@/lib/stores/fact-rows-selector';
import { sectionTitle } from '@/components/custom/for-you/section-title';
import { useSectionSnapshots } from '@/components/custom/for-you/use-section-snapshots';
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
import {
  AccessibilityInfo,
  FlatList,
  findNodeHandle,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
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
  /** Arrived through the previous section's "Next" row: the screen crossfades
   *  in and moves screen-reader focus to the new title. */
  arrivedFromNext?: boolean;
}

/**
 * The full feed for a single fact (Round-3 C2). Reached by tapping a fact row's
 * header. Plain vertical list of full article cards, pubDate desc; each collapsed
 * story shows the newest member (so the card's timestamp is the newest member's
 * pubDate).
 */
const FactFeedScreen: React.FC<FactFeedScreenProps> = ({ factId, statement, arrivedFromNext = false }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const suggestions = useForYouSuggestions();
  const openedIds = useOpenedStoriesStore((s) => s.ids);
  const handlePress = useOpenSuggestion('sectioned');
  const isHeadline = isHeadlineSectionId(factId);

  // Last-visit timestamp captured on entry (before we mark this visit) — drives
  // the per-card NEW badge. `null` until hydrated; `0` on a first-ever visit
  // (⇒ no badges, avoiding first-run badge spam).
  const [prevVisitMs, setPrevVisitMs] = useState<number | null>(null);

  useEffect(() => {
    void useOpenedStoriesStore.getState().hydrate();
  }, []);

  // Kept fresh (facts/locations changes and focus), not loaded once on mount:
  // a fact added while this screen was open, or a "Next" hop into a section
  // for a fact created since, used to read a stale snapshot.
  const snapshots = useSectionSnapshots('FactFeedScreen');

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

  // Hoisted so the "next fact" footer below can reuse it instead of calling
  // `buildFactRows` a second time — this was previously computed inline and
  // thrown away, keeping only this section's own `groups`.
  const allRows: FactRow[] = useMemo(() => {
    if (!snapshots) return [];
    const { rows } = buildFactRows(suggestions, snapshots, openedIds, Date.now(), DEFAULT_HARNESS_CONFIG, userGeoLanguageCtx);
    return rows;
  }, [snapshots, suggestions, openedIds, userGeoLanguageCtx]);

  const groups: FactRowGroup[] = useMemo(() => {
    const found = allRows.find((r) => r.factId === factId)?.groups ?? [];
    // Order this screen by article publication freshness — newest PUBLISHED on
    // top (`pubDateMs`), not suggestion-creation time (the shared `cardCompare`
    // the Dashboard uses). Copy before sorting so the selector's array is left
    // untouched. Tiebreak on `_id` for a stable order.
    return [...found].sort(
      (a, b) =>
        b.pubDateMs - a.pubDateMs ||
        (a.data._id < b.data._id ? -1 : a.data._id > b.data._id ? 1 : 0),
    );
  }, [allRows, factId]);

  // The NEXT fact, in Dashboard order — so tapping the footer below always
  // lands on a section the user could also have reached by scrolling the
  // Dashboard. This used to drop rows whose every group the Dashboard's
  // importance pill had hidden; with that pill gone the Dashboard shows every
  // row it builds, so `allRows` IS the Dashboard-visible order.
  const nextFact = useMemo(() => {
    const idx = allRows.findIndex((r) => r.factId === factId);
    if (idx === -1) return null;
    return allRows[idx + 1] ?? null;
  }, [allRows, factId]);

  const nextFactTitle = nextFact ? sectionTitle(t, nextFact) : null;
  // This section's own row: its empty reason when it is an interest with no
  // stories yet (D4), which "Next" can land on.
  const thisRow = useMemo(() => allRows.find((r) => r.factId === factId) ?? null, [allRows, factId]);
  const isLastSection = thisRow !== null && nextFact === null;

  // `router.replace`, not `push`: hopping from fact to fact via this footer
  // must not build a back-stack five deep. Both the visit-tracking effect
  // (above) and the seeded palette (`AbstractGradientBackdrop seed={factId}`
  // below) are keyed on `factId`, so a replace re-runs them for free — no
  // special-case needed for "arrived via the footer" vs. "arrived from the
  // Dashboard".
  const goToNextFact = useCallback(() => {
    if (!nextFact || !nextFactTitle) return;
    router.replace({
      pathname: '/logged-in/fact-feed',
      params: { factId: nextFact.factId, statement: nextFactTitle, via: 'next' },
    });
  }, [nextFact, nextFactTitle]);

  const backToDashboard = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/logged-in/app_container/for_you');
  }, []);

  // Screen-reader focus moves to the new section's title after a "Next" hop,
  // so VoiceOver does not stay on a footer that no longer exists.
  const titleRef = useRef<View>(null);
  useEffect(() => {
    if (!arrivedFromNext) return;
    const handle = findNodeHandle(titleRef.current);
    if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
  }, [arrivedFromNext, factId]);

  // The crossfade on a "Next" hop. Reduce Motion gets a plain cut.
  const reduceMotion = useReducedMotion();
  const entering = arrivedFromNext && !reduceMotion ? FadeIn.duration(220) : undefined;

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
  const { onVerdict, onAskMera, feedbackHandlers } = useFeedbackSheet(factAdapter, {
    onOpenSuggestion: handlePress,
  });
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

  // "Jump from one fact feed list to the next" (r14 #6), in the NEXT section's
  // gradient (N13). Renders on an empty section too: that is exactly when
  // hopping onward is most useful. The last section offers the way back.
  const listFooter =
    nextFact && nextFactTitle ? (
      <NextSectionFooter
        kind="next"
        factId={nextFact.factId}
        title={nextFactTitle}
        count={nextFact.groups.length}
        translateTitle={!isHeadlineSectionId(nextFact.factId)}
        onPress={goToNextFact}
      />
    ) : isLastSection ? (
      <NextSectionFooter kind="back" onPress={backToDashboard} />
    ) : null;

  // An interest with no stories yet says which of the two it is, like its
  // Dashboard section (D4); any other empty list is simply caught up.
  // Nothing until this section's snapshot has loaded: during a "Next" hop the
  // new screen mounts with no snapshot, and "all caught up" flashed for a
  // fifth of a second before the section's real content or empty state.
  const listEmpty = snapshots === null ? null : thisRow?.emptyReason ? (
    <ForYouEmptyState
      icon={thisRow.emptyReason === 'awaiting-first-run' ? 'hourglass-empty' : 'search'}
      body={
        thisRow.emptyReason === 'awaiting-first-run'
          ? t('forYou.emptySection.awaiting')
          : t('forYou.emptySection.none')
      }
      testID="fact-feed-empty-section"
    />
  ) : (
    <AllCaughtUpCard />
  );

  return (
    // No `bg-black`: the AbstractGradientBackdrop below is the page background.
    <Box className="flex-1">
      {/* Page background. Must be the FIRST child so it paints behind
          everything else on the page, exactly as the tab screens mount it.
          Seeded with the SECTION id, so every fact list draws its own stable
          palette walk instead of all of them sharing one look. */}
      <AbstractGradientBackdrop seed={factId} />

      {/* Everything above the backdrop crossfades in after a "Next" hop. */}
      <Animated.View style={{ flex: 1 }} entering={entering}>

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
        {/* Android-only opaque-ish gradient — must render BEFORE GlassPlate
            so the tint below still lifts it to a readable surface tone (see
            GlassSurface.tsx's GlassHeaderAndroidBackdrop doc comment). No-op
            on iOS. Applied here for the same lockstep reason as the other
            four header paint sites, even though this header sits in normal
            flow with nothing scrolling under it — see the doc comment above
            this Box for why that made translucency fine before; verify on
            device that the extra opacity doesn't read as a dark band over
            the seeded backdrop below it. */}
        <GlassHeaderAndroidBackdrop />
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
          <View
            ref={titleRef}
            className="flex-1 min-w-0"
            accessible
            accessibilityRole="header"
            testID="fact-feed-title"
          >
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
                size="xl"
                bold
                // Two lines, then an ellipsis: a long fact title keeps its
                // meaning without pushing the list down the screen.
                numberOfLines={2}
                className="text-white"
              />
            )}
          </View>
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
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
      />

      </Animated.View>

      <ScrollToTopFab visible={showScrollToTop} onPress={scrollToTop} />
    </Box>
  );
};

export default FactFeedScreen;
