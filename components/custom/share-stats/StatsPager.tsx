// StatsPager: the Library's Stats page. The share cards as a horizontal pager
// with dots, "Share this card", and the publication-names privacy switch.
//
// ## Two copies of the card, on purpose
//
// The visible card is fitted to the page; the capture host is laid out at its
// full point size off to the left and is the one that gets captured, from the
// SAME props, so the two never disagree. The host is POSITIONED away, never
// `display: none` and never conditionally mounted while sharing: both capture
// as nothing. It mounts only while the page is active, so a warmed neighbour
// does not lay out a full-size card nobody can share.
//
// ## The capture waits for the switch to commit
//
// Pressing share sets a flag; an effect keyed on it waits two animation frames
// before capturing, so a card never goes out carrying publication names the
// reader just switched off.
//
// ## Inside the page swipe
//
// The pager is RNGH's ScrollView with the tab swipe's blocker ref, so the page
// swipe waits for it, and it reports its edges: at the first or last card the
// page swipe takes over in that direction (one continuous swipe from Visited
// through Stats to You).
//
// ## Height
//
// The card is fitted to what the page measures (onLayout), less the header,
// the dots, the share block and the tab bar (`statsCardBox`), never to the
// window: inside a tab the window is not the page. The page scrolls
// vertically, so the "How this page works" row and the list-end clearance
// live below the fold.

import ShareCardPill from '@/components/custom/analytics/ShareCardPill';
import ShareStatsCard, { fitCardToPage, hostSizeForScale } from '@/components/custom/share-stats/ShareStatsCard';
import { CARD_ACCENT, ink } from '@/components/custom/share-stats/card-theme';
import { captureAndShare } from '@/components/custom/share-stats/capture-and-share';
import {
  DOTS_ALLOWANCE,
  PILL_ALLOWANCE,
  STATS_SIDE_GAP,
  STATS_TOP_GAP,
  statsCardBox,
} from '@/components/custom/share-stats/screen-metrics';
import { useSwipeTabsBlocker } from '@/components/custom/nav/swipe-blocker';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { HStack } from '@/components/ui/hstack';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import logger from '@/lib/logger';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import {
  availableCards,
  emptyReadingStats,
  resolveStatsCardParam,
  type ReadingStats,
  type StatsCardId,
} from '@/lib/stats/reading-stats';
import { loadReadingStats } from '@/lib/stats/reading-stats-source';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelRatio, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { ScrollView as GestureScrollView } from 'react-native-gesture-handler';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';

type ShareMessage = 'unavailable' | 'failed' | null;

/** Where the pager's scroll position sits against its two ends. */
export function pagerEdges(offsetX: number, pageWidth: number, pages: number): { start: boolean; end: boolean } {
  const max = Math.max(0, (pages - 1) * pageWidth);
  return { start: offsetX <= 1, end: offsetX >= max - 1 };
}

interface Props {
  /** The visible page of the focused tab. Reloads on becoming active. */
  readonly active?: boolean;
  readonly headerHeight?: number;
  readonly scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
  /** List-end padding (tab bar plus Mera button clearance). */
  readonly listEndPadding?: number;
  /** Raw `card` arrival param. Untrusted: validated against the known ids and
   *  against what this device has, never used directly. */
  readonly requestedCard?: unknown;
  /** Drawn below the share block (the host's "How this page works" row). */
  readonly footer?: React.ReactNode;
}

const StatsPager: React.FC<Props> = ({
  active = true,
  headerHeight = 0,
  scrollHandler,
  listEndPadding = 0,
  requestedCard,
  footer,
}) => {
  const { t, i18n } = useTranslation();
  const blocker = useSwipeTabsBlocker();
  const tabClearance = useTabBarClearance();

  const [stats, setStats] = useState<ReadingStats>(emptyReadingStats);
  const [isLoading, setIsLoading] = useState(true);
  const [showNames, setShowNames] = useState(true);
  const [pendingShare, setPendingShare] = useState(false);
  const [stampedAtMs, setStampedAtMs] = useState(() => Date.now());
  const [message, setMessage] = useState<ShareMessage>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [page, setPage] = useState(0);

  const captureHostRef = useRef<View>(null);
  const pagerRef = useRef<any>(null);
  const frames = useRef<number | null>(null);
  const pixelRatio = PixelRatio.get();
  const host = hostSizeForScale(pixelRatio);

  // Read on mount and each time the page becomes active, so a visit recorded
  // meanwhile shows. The first read shows the spinner; later ones are silent.
  useEffect(() => {
    if (!active && !isLoading) return;
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
    // isLoading only gates the first read; it must not re-trigger one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const cards = availableCards(stats);
  const pageWidth = box.width;

  // Land on the card an arrival asked for (validated), once per request.
  const landing: StatsCardId | null = resolveStatsCardParam(requestedCard, stats);
  useEffect(() => {
    if (requestedCard == null || !landing || pageWidth === 0) return;
    const index = Math.max(0, cards.indexOf(landing));
    setPage(index);
    pagerRef.current?.scrollTo?.({ x: index * pageWidth, animated: false });
    // A new request, or the cards it names becoming available, re-lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedCard, landing, pageWidth, cards.length]);

  const activeCard: StatsCardId | null = cards[Math.min(page, Math.max(cards.length - 1, 0))] ?? null;

  // Tell the page swipe where the pager stands, so it takes over at an end.
  const reportEdges = useCallback(
    (offsetX: number) => {
      blocker?.setEdge(pagerEdges(offsetX, pageWidth, cards.length));
    },
    [blocker, pageWidth, cards.length],
  );
  useEffect(() => {
    reportEdges(page * pageWidth);
  }, [reportEdges, page, pageWidth]);

  const onPagerScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => reportEdges(event.nativeEvent.contentOffset.x),
    [reportEdges],
  );
  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(event.nativeEvent.contentOffset.x / Math.max(pageWidth, 1));
      setPage(Math.min(Math.max(next, 0), Math.max(cards.length - 1, 0)));
      reportEdges(event.nativeEvent.contentOffset.x);
    },
    [pageWidth, cards.length, reportEdges],
  );

  useEffect(() => {
    if (!pendingShare) return;
    let cancelled = false;
    const outer = requestAnimationFrame(() => {
      const inner = requestAnimationFrame(async () => {
        const result = await captureAndShare({
          ref: captureHostRef,
          hostWidth: host.width,
          hostHeight: host.height,
          dialogTitle: t('shareStats.shareDialogTitle'),
        });
        if (cancelled) return;
        if (result.status === 'failed') {
          logger.captureException(result.error, { tags: { screen: 'StatsPager', method: 'captureAndShare' } });
        }
        setMessage(result.status === 'shared' ? null : result.status);
        setPendingShare(false);
      });
      frames.current = inner;
    });
    frames.current = outer;
    return () => {
      cancelled = true;
      if (frames.current !== null) cancelAnimationFrame(frames.current);
    };
  }, [pendingShare, host.width, host.height, t]);

  const onShare = useCallback(() => {
    setMessage(null);
    setStampedAtMs(Date.now());
    setPendingShare(true);
  }, []);

  const onToggleNames = useCallback((next: boolean) => {
    setShowNames(next);
    setMessage(null);
  }, []);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  const cardSize = fitCardToPage(statsCardBox(box, headerHeight, tabClearance));

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <View style={{ alignItems: 'center', paddingVertical: 48 }} testID="stats-loading">
        <Spinner size="large" />
        <Text size="sm" className="mt-3" style={ink('muted')}>
          {t('shareStats.preparing')}
        </Text>
      </View>
    );
  } else if (cards.length === 0) {
    // Before the first card exists: the real rule, no counter.
    body = (
      <ForYouEmptyState
        icon="insights"
        title={t('library.stats.emptyTitle')}
        body={t('library.stats.emptyBody')}
        testID="stats-empty"
      />
    );
  } else {
    body = (
      <>
        <GestureScrollView
          ref={(node: unknown) => {
            pagerRef.current = node;
            if (blocker) (blocker.ref as React.MutableRefObject<unknown>).current = node;
          }}
          testID="stats-pager"
          horizontal
          pagingEnabled
          bounces={false}
          overScrollMode="never"
          showsHorizontalScrollIndicator={false}
          onScroll={onPagerScroll}
          onMomentumScrollEnd={onMomentumEnd}
          scrollEventThrottle={32}
          style={{ flexGrow: 0 }}
        >
          {cards.map((id) => (
            <View
              key={id}
              testID={`stats-page-${id}`}
              style={{ width: pageWidth, alignItems: 'center', justifyContent: 'center' }}
            >
              <View style={{ width: cardSize.width, height: cardSize.height }}>
                <ShareStatsCard
                  card={id}
                  stats={stats}
                  showPublicationNames={showNames}
                  pixelRatio={pixelRatio}
                  stampedAtMs={stampedAtMs}
                  locale={i18n.language}
                  hostSize={cardSize}
                />
              </View>
            </View>
          ))}
        </GestureScrollView>

        {/* An indicator, not a control: hidden from the screen reader, which
            already hears the pager. */}
        <HStack
          testID="stats-dots"
          className="items-center justify-center"
          style={{ columnGap: 6, height: DOTS_ALLOWANCE }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {cards.map((id, index) => (
            <View
              key={id}
              testID={`stats-dot-${id}`}
              style={{
                width: index === page ? 18 : 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: index === page ? CARD_ACCENT : 'rgba(255,255,255,0.3)',
              }}
            />
          ))}
        </HStack>

        <View style={{ minHeight: PILL_ALLOWANCE }}>
          <ShareCardPill
            label={t('library.stats.share')}
            onPress={onShare}
            disabled={pendingShare}
            testID="stats-share-button"
          />
          <HStack className="items-center justify-center px-5 mt-2" space="sm">
            {pendingShare ? <Spinner size="small" /> : null}
            {/* flex-1 is load-bearing: without it the line keeps its intrinsic
                width in a centred row and spills past both edges. */}
            <Text size="sm" style={ink('muted')} className="flex-1 text-center" numberOfLines={3}>
              {message === null
                ? t('shareStats.nameTogglePrivacy')
                : message === 'unavailable'
                  ? t('shareStats.sharingUnavailable')
                  : t('shareStats.shareFailed')}
            </Text>
            <Switch testID="stats-names-switch" value={showNames} onToggle={onToggleNames} size="sm" />
          </HStack>
        </View>
      </>
    );
  }

  return (
    <View style={{ flex: 1 }} onLayout={onLayout} testID="stats-page">
      {active && activeCard ? (
        <View
          testID="stats-capture-host"
          style={{ position: 'absolute', left: -8000, top: 0, width: host.width, height: host.height }}
          pointerEvents="none"
        >
          <ShareStatsCard
            ref={captureHostRef}
            card={activeCard}
            stats={stats}
            showPublicationNames={showNames}
            pixelRatio={pixelRatio}
            stampedAtMs={stampedAtMs}
            locale={i18n.language}
          />
        </View>
      ) : null}
      <Animated.ScrollView
        testID="stats-scroll"
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: headerHeight + STATS_TOP_GAP, paddingBottom: listEndPadding }}
      >
        {box.width > 0 ? body : null}
        {footer ? <View style={{ paddingHorizontal: STATS_SIDE_GAP, marginTop: 16 }}>{footer}</View> : null}
      </Animated.ScrollView>
    </View>
  );
};

export default StatsPager;
