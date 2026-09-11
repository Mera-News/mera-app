import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import { useFeedbackSheet, type VerdictStoreAdapter } from '@/components/custom/feed/use-feedback-sheet';
import { useFeedbackDismissedStore } from '@/lib/stores/feedback-dismissed-store';
import { filterGroupsByImportance } from '@/components/custom/for-you/dashboard-importance';
import ImportanceFilterDropdown from '@/components/custom/ImportanceFilterDropdown';
import { useImportanceFilterStore } from '@/lib/stores/importance-filter-store';
import type { ImportanceThreshold } from '@/lib/feed-ordering/importance-filter';
import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import {
  GLASS_HEADER_SCRIM,
  GLASS_HEADER_TINT,
  GlassHeaderAndroidBackdrop,
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
  type FactRow,
  type FactRowGroup,
} from '@/lib/stores/fact-rows-selector';
import { sectionTitle } from '@/components/custom/for-you/section-title';
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

  // Seeded from the Dashboard's importance filter so tapping into a section
  // never shows MORE stories than the preview promised — then LOCAL from
  // there on: this screen's dropdown is deliberately ephemeral (plain state,
  // no persistence), resetting to the Dashboard's value on every visit.
  const dashboardThreshold = useImportanceFilterStore((s) => s.dashboardThreshold);
  const [threshold, setThreshold] = useState<ImportanceThreshold>(dashboardThreshold);

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
    const filtered = filterGroupsByImportance(found, threshold);
    // Order this screen by article publication freshness — newest PUBLISHED on
    // top (`pubDateMs`), not suggestion-creation time (the shared `cardCompare`
    // the Dashboard uses). Copy before sorting so the selector's array is left
    // untouched. Tiebreak on `_id` for a stable order.
    return [...filtered].sort(
      (a, b) =>
        b.pubDateMs - a.pubDateMs ||
        (a.data._id < b.data._id ? -1 : a.data._id > b.data._id ? 1 : 0),
    );
  }, [allRows, factId, threshold]);

  // The NEXT fact, in Dashboard-VISIBLE order — so tapping the footer below
  // always lands on a section the user could also have reached by scrolling
  // the Dashboard, never a section hidden by their Dashboard filter.
  //
  // Deliberately `dashboardThreshold` (the persisted Dashboard pill), NOT this
  // screen's own ephemeral `threshold` — that local dropdown only reshapes
  // THIS section's article list and resets to `dashboardThreshold` on every
  // visit (see its declaration above); the ORDER of sections is a Dashboard
  // concept and must use the Dashboard's own filter, or "next" could point at
  // a section this user's Dashboard never actually shows.
  //
  // Mirrors DashboardSectionsFeed's own filter-and-drop rule exactly
  // (DashboardSectionsFeed.tsx ~146-152): a row that HAD groups but the filter
  // hid all of them is dropped; a row with no groups to begin with (a headline
  // shell whose denominator line is its content) is kept.
  const dashboardVisibleRows = useMemo(
    () =>
      allRows.filter((row) => {
        const filteredGroups = filterGroupsByImportance(row.groups, dashboardThreshold);
        return !(row.groups.length > 0 && filteredGroups.length === 0);
      }),
    [allRows, dashboardThreshold],
  );

  const nextFact = useMemo(() => {
    const idx = dashboardVisibleRows.findIndex((r) => r.factId === factId);
    if (idx === -1) return null;
    return dashboardVisibleRows[idx + 1] ?? null;
  }, [dashboardVisibleRows, factId]);

  const nextFactTitle = nextFact ? sectionTitle(t, nextFact) : null;

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
      params: { factId: nextFact.factId, statement: nextFactTitle },
    });
  }, [nextFact, nextFactTitle]);

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

  // "Jump from one fact feed list to the next" (r14 #6) — a tap target naming
  // the NEXT section in Dashboard-visible order (see `dashboardVisibleRows`
  // above). Renders nothing when there is no next fact — including on an
  // empty section, which the user reported is exactly when hopping onward is
  // most useful, so this deliberately coexists with the `ListEmptyComponent`
  // below rather than being suppressed by it.
  //
  // A headline section's title is app copy, already localized — rendered
  // as plain `Text`, mirroring the header above. A fact section's title is
  // user data, so it goes through `TranslatableDynamic`, exactly like the
  // header's own `statement`.
  const listFooter = nextFact && nextFactTitle ? (
    <Pressable
      testID="fact-feed-next"
      onPress={goToNextFact}
      accessibilityRole="button"
      accessibilityLabel={`${t('forYou.nextFactPrefix')}: ${nextFactTitle}`}
      className="items-center py-6 px-4"
    >
      <HStack className="items-center" space="xs">
        <Text size="xs" className="text-typography-500">
          {t('forYou.nextFactPrefix')}
        </Text>
        <MaterialIcons name="arrow-forward" size={14} color="#6B7280" />
      </HStack>
      {isHeadlineSectionId(nextFact.factId) ? (
        <Text size="md" bold numberOfLines={1} className="text-white text-center mt-1">
          {nextFactTitle}
        </Text>
      ) : (
        <TranslatableDynamic
          text={nextFactTitle}
          as="text"
          size="md"
          bold
          numberOfLines={1}
          className="text-white text-center mt-1"
        />
      )}
    </Pressable>
  ) : null;

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
                size="xl"
                bold
                numberOfLines={1}
                className="text-white"
              />
            )}
          </Box>
          <ImportanceFilterDropdown
            value={threshold}
            onChange={setThreshold}
            testIDPrefix="fact-feed-importance"
          />
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
        ListFooterComponent={listFooter}
      />

      <ScrollToTopFab visible={showScrollToTop} onPress={scrollToTop} />
    </Box>
  );
};

export default FactFeedScreen;
