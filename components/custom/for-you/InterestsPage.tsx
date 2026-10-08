// The Interests page of the Feed tab: one section per thing Mera knows about
// the reader (the Dashboard Overview's FACT sections; World covers the
// headline scopes). Section header and "View all" push One interest inside
// the Feed tab's stack.
//
// Section ORDER reads a THROTTLED snapshot of the viewed state, replaced at
// most once per DASHBOARD_RESORT_INTERVAL_MS and on leaving the page or the
// app, so sections never reshuffle under the reader's eyes. New arrivals are
// not throttled: they slot into their band at once (the sort key is viewed,
// relevance band, incoming index, and only `viewed` is frozen).

import { useFeedSyncRefresh, useIsFeedProcessing } from '@/components/custom/FeedSyncIndicator';
import DashboardSectionsFeed from '@/components/custom/for-you/DashboardSectionsFeed';
import { FeedNoFacts } from '@/components/custom/for-you/ForYouEmptyState';
import FeedShortcuts from '@/components/custom/feed/FeedShortcuts';
import { useSectionSnapshots } from '@/components/custom/for-you/use-section-snapshots';
import type { PageHeaderBinding } from '@/components/custom/nav/types';
import FeedProcessingCard from '@/components/custom/processing/FeedProcessingCard';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import {
  DASHBOARD_RESORT_INTERVAL_MS,
  msUntilResortDue,
  shouldResort,
  type ResortTrigger,
} from '@/lib/feed-ordering/dashboard-resort';
import { useFeedBootstrap } from '@/lib/hooks/use-feed-bootstrap';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { buildFactRows, isHeadlineRow } from '@/lib/stores/fact-rows-selector';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useSectionVisitsStore } from '@/lib/stores/section-visits-store';
import {
  useForYouHasGeneratedTopics,
  useForYouLastProcessingRunFinishedAt,
  useForYouSuggestions,
} from '@/lib/stores/selectors';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, View } from 'react-native';
import { setEmptyWantsCard } from '@/components/custom/for-you/feed-status-card';
import Animated, { FadeOut } from 'react-native-reanimated';

interface SortSnapshot {
  cardStates: Record<string, unknown>;
  openedArticleIds: Set<string>;
  openedIds: Set<string>;
}

export interface InterestsPageProps {
  readonly active: boolean;
  readonly header: PageHeaderBinding;
}

const InterestsPage: React.FC<InterestsPageProps> = ({ active, header }) => {
  const { t } = useTranslation();
  const { isLoading, errorMessage } = useFeedBootstrap();
  const handleSuggestionPress = useOpenSuggestion('sectioned');
  const openedIds = useOpenedStoriesStore((s) => s.ids);

  // ── Section-order snapshot (THROTTLED) ──
  const [sortSnapshot, setSortSnapshot] = useState<SortSnapshot>(() => ({
    cardStates: {},
    openedArticleIds: new Set(),
    openedIds: new Set(),
  }));
  const lastResortAtRef = useRef<number | null>(null);
  const applyResort = useCallback((trigger: ResortTrigger) => {
    const nowMs = Date.now();
    if (!shouldResort({ lastAppliedMs: lastResortAtRef.current, nowMs, trigger })) return;
    lastResortAtRef.current = nowMs;
    const next: SortSnapshot = {
      cardStates: useFeedOrderStore.getState().cardStates,
      openedArticleIds: useOpenedStoriesStore.getState().articleIds,
      openedIds: useOpenedStoriesStore.getState().ids,
    };
    // Same store objects: nothing was viewed since, keep the old snapshot so
    // the list does not re-derive for nothing.
    setSortSnapshot((prev) =>
      prev.cardStates === next.cardStates && prev.openedIds === next.openedIds ? prev : next,
    );
  }, []);

  const openedHydrated = useOpenedStoriesStore((s) => s.hydrated);
  useEffect(() => {
    if (!openedHydrated || lastResortAtRef.current !== null) return;
    applyResort('unwatched');
  }, [openedHydrated, applyResort]);
  // Leaving the page (or the tab) is an unwatched moment.
  useEffect(() => {
    if (active) return;
    applyResort('unwatched');
  }, [active, applyResort]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') applyResort('unwatched');
    });
    return () => sub.remove();
  }, [applyResort]);
  useEffect(() => {
    if (!active) return;
    const delay = msUntilResortDue(lastResortAtRef.current, Date.now());
    const timer = setTimeout(() => applyResort('elapsed'), delay || DASHBOARD_RESORT_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [active, sortSnapshot, applyResort]);

  useEffect(() => {
    void useSectionVisitsStore.getState().hydrate();
  }, []);

  // ── Rows ──
  const suggestions = useForYouSuggestions();
  const hasGeneratedInterests = useForYouHasGeneratedTopics();
  const lastProcessingRunFinishedAt = useForYouLastProcessingRunFinishedAt();
  const snapshots = useSectionSnapshots('InterestsPage', [hasGeneratedInterests, suggestions.length]);
  const userGeoLanguageCtx = useUserGeoLanguageContext();
  const rows = useMemo(() => {
    if (!snapshots) return [];
    return buildFactRows(
      suggestions,
      snapshots,
      sortSnapshot.openedIds,
      Date.now(),
      DEFAULT_HARNESS_CONFIG,
      userGeoLanguageCtx,
      lastProcessingRunFinishedAt,
    ).rows.filter((row) => !isHeadlineRow(row));
  }, [snapshots, suggestions, sortSnapshot, userGeoLanguageCtx, lastProcessingRunFinishedAt]);

  const { refreshing, onRefresh } = useFeedSyncRefresh(header.reveal);
  const isFeedProcessing = useIsFeedProcessing();
  // An empty Sectioned view past its first run needs the header's counts
  // card (FeedHeaderAccessory), the same branch that shows the shortcuts.
  const hasStories = rows.some((r) => r.groups.length > 0);
  const emptyWantsCard =
    active &&
    !hasStories &&
    !isLoading &&
    snapshots !== null &&
    !errorMessage &&
    snapshots.facts.size > 0 &&
    lastProcessingRunFinishedAt !== null;
  useEffect(() => {
    if (active) setEmptyWantsCard(emptyWantsCard);
  }, [active, emptyWantsCard]);

  // ── Nothing to show yet ──
  let empty: React.ReactElement | null;
  if (isLoading || snapshots === null) {
    empty = (
      <Box className="items-center justify-center py-20" testID="interests-loading">
        <Spinner size="large" />
      </Box>
    );
  } else if (errorMessage) {
    empty = (
      <View style={{ paddingVertical: 48, paddingHorizontal: 24 }} testID="interests-error">
        <Text size="md" className="text-negative text-center font-semibold">
          {t('errors.failedToLoad')}
        </Text>
        <Text size="sm" className="text-ink-3 text-center">
          {t('feed.pullDownToRetry')}
        </Text>
      </View>
    );
  } else if (snapshots.facts.size === 0) {
    // Sectioned shows the block alone (no headline rows here, C4).
    empty = <FeedNoFacts view="sectioned" />;
  } else if (lastProcessingRunFinishedAt !== null) {
    // Nothing to show, the same as Continuous (FinalFeed "Feed, empty after
    // a long gap"): the counts card is in the header; the shortcuts here.
    empty = (
      <Animated.View exiting={FadeOut.duration(200)}>
        <FeedShortcuts reading={isFeedProcessing} />
      </Animated.View>
    );
  } else {
    empty = (
      <>
        <FeedProcessingCard />
        <FeedShortcuts reading />
      </>
    );
  }

  return (
    <View style={{ flex: 1 }} testID="interests-page">
      <DashboardSectionsFeed
        rows={rows}
        openedIds={openedIds}
        sortSnapshot={sortSnapshot}
        onPressSuggestion={handleSuggestionPress}
        scrollHandler={header.scrollHandler}
        headerHeight={header.headerHeight}

        ListEmptyComponent={empty}
        refreshing={refreshing}
        onRefresh={onRefresh}
        rankingCtx={userGeoLanguageCtx}
        active={active}
      />
    </View>
  );
};

export default InterestsPage;
