// AnalyticsScreen — the Dashboard's Analytics sub-tab.
//
// A horizontal pager, one card per page, with page dots and a single share
// pill as chrome around it. The cards themselves are the share cards from
// `components/custom/share-stats/`, rendered at the viewport rather than at the
// export size.
//
// ## Two boxes, and they are not the same box
//
// The EXPORT is a fixed 1080x1920 with a 1080x1420 content box, and that is
// what `share-stats-locale-budget` asserts against. The on-screen PAGE is
// whatever the viewport is, which on most devices is neither 9:16 nor 360pt
// wide. The card component is authored on a 360-wide grid and scales by `k`, so
// it renders at either size, but the two budgets are separate and must stay so:
// a card that fits the export box can still overflow a short viewport, and that
// is a different bug with a different fix.
//
// ## There is no gesture arbitration here, and that is now a fact rather than a
// ## design choice
//
// The Dashboard used to own a right-edge `Gesture.Pan` on a 20pt strip drawn
// OVER the sub-tab content, which opened Profile and swallowed every touch in
// its band. A pager underneath it would have been dead in that band, and
// negotiating between a paging ScrollView and a live RNGH detector is the
// reliable way to make paging feel broken exactly where people swipe.
//
// That strip is DELETED, along with its module. Do not reintroduce it: the
// pager now owns the full width, and a 20pt dead band at the right edge would
// come back as "paging sometimes does nothing" rather than as an obvious
// regression. Profile is a bottom tab and is reached by tapping it.
//
// The pager is still a paging ScrollView rather than a Pan detector, because
// that composes through the ordinary responder system and needs no arbitration
// against anything that might be added later.
//
// ## Static header padding is correct HERE
//
// `ForYouScreen` carries a warning that padding a wrapper with `headerHeight`
// reserves the space statically and leaves nothing to scroll under. That
// warning is about a SCROLLING pane. This pane does not scroll vertically at
// all — each card fits one page by construction, and the budget is what keeps
// it true — so static padding is the right shape and the header simply stays
// put. Say which case you are in if you change this.

import ShareCardPill from '@/components/custom/analytics/ShareCardPill';
import ShareStatsCard from '@/components/custom/share-stats/ShareStatsCard';
import { CARD_ACCENT } from '@/components/custom/share-stats/card-theme';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import {
  availableCards,
  emptyReadingStats,
  type ReadingStats,
  type StatsCardId,
} from '@/lib/stats/reading-stats';
import { loadReadingStats } from '@/lib/stats/reading-stats-source';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PixelRatio,
  ScrollView,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const DOT_METRICS = {
  size: 6,
  gap: 7,
  marginTop: 14,
} as const;

interface Props {
  readonly headerHeight?: number;
}

const AnalyticsScreen: React.FC<Props> = ({ headerHeight = 0 }) => {
  const { t, i18n } = useTranslation();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [stats, setStats] = useState<ReadingStats>(emptyReadingStats);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    let cancelled = false;
    loadReadingStats()
      .then((loaded) => {
        if (!cancelled) setStats(loaded);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cards = useMemo(() => availableCards(stats), [stats]);
  const pixelRatio = PixelRatio.get();

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(event.nativeEvent.contentOffset.x / Math.max(width, 1));
      setPage(Math.min(Math.max(next, 0), Math.max(cards.length - 1, 0)));
    },
    [width, cards.length],
  );

  const onShare = useCallback(() => {
    const card: StatsCardId | undefined = cards[page];
    if (!card) return;
    // Routed rather than captured here: the share path owns the offscreen host,
    // the capture-moment date stamp and the two-frame wait, and duplicating any
    // of that would be a second chance to get the export size wrong.
    router.push(`/logged-in/share-stats?card=${card}`);
  }, [cards, page]);

  // Clearance, not a target. TAB_BAR_HEIGHT is a conservative ESTIMATE (49 iOS
  // / 56 Android) because the native bar owns its own height and does not
  // expose it to JS, so this adds the safe-area inset on top of it and then
  // some rather than sitting exactly on the number.
  const bottomClearance = TAB_BAR_HEIGHT + insets.bottom + 16;

  if (isLoading) {
    return (
      <Box className="flex-1 items-center justify-center" style={{ paddingTop: headerHeight }}>
        <Spinner size="large" />
        <Text size="sm" className="mt-3" style={{ color: 'rgba(255,255,255,0.56)' }}>
          {t('analytics.loading')}
        </Text>
      </Box>
    );
  }

  if (cards.length === 0) {
    return (
      <VStack
        testID="analytics-empty"
        className="flex-1 items-center justify-center p-6"
        space="md"
        style={{ paddingTop: headerHeight }}
      >
        <Text size="md" className="text-white text-center">{t('shareStats.emptyTitle')}</Text>
        <Text size="sm" className="text-center" style={{ color: 'rgba(255,255,255,0.56)' }}>
          {t('analytics.emptyBody')}
        </Text>
      </VStack>
    );
  }

  return (
    <View style={{ flex: 1, paddingTop: headerHeight }} testID="analytics-screen">
      <VStack className="px-5" style={{ paddingBottom: 8 }}>
        <Text className="text-white font-semibold" style={{ fontSize: 20, lineHeight: 28 }}>
          {t('analytics.title')}
        </Text>
        <Text size="sm" style={{ color: 'rgba(255,255,255,0.56)' }}>
          {t('analytics.subtitle')}
        </Text>
      </VStack>

      <ScrollView
        ref={scrollRef}
        testID="analytics-pager"
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumEnd}
        style={{ flex: 1 }}
      >
        {cards.map((card) => (
          <View key={card} style={{ width }} testID={`analytics-page-${card}`}>
            {/* Rendered at the VIEWPORT, not the export size. The card scales
                by k off its own 360-wide grid, so the same component serves
                both, and nothing here may assume the 9:16 export box. */}
            <ShareStatsCard
              card={card}
              stats={stats}
              pixelRatio={pixelRatio}
              stampedAtMs={Date.now()}
              locale={i18n.language}
            />
          </View>
        ))}
      </ScrollView>

      {/* An INDICATOR, not a control: no press target, no count, no progress
          semantics. It exists to say there is more to the right. */}
      <HStack
        testID="analytics-dots"
        className="items-center justify-center"
        style={{ columnGap: DOT_METRICS.gap, marginTop: DOT_METRICS.marginTop }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {cards.map((card, index) => (
          <View
            key={card}
            testID={`analytics-dot-${card}`}
            style={{
              width: DOT_METRICS.size,
              height: DOT_METRICS.size,
              borderRadius: DOT_METRICS.size / 2,
              backgroundColor: index === page ? CARD_ACCENT : 'rgba(255,255,255,0.28)',
            }}
          />
        ))}
      </HStack>

      <View style={{ paddingBottom: bottomClearance }}>
        <ShareCardPill
          label={t('analytics.shareCard')}
          onPress={onShare}
          testID="analytics-share-pill"
        />
      </View>
    </View>
  );
};

export default AnalyticsScreen;
