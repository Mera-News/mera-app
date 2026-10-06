// StatsPage: the Library's Stats page. The share cards that have something on
// them (reach, habits, keep), stacked in one vertical list, each with its own
// "Share this card" under it, and the publication-names privacy switch once at
// the top, so the reader sees it before any Share button.
//
// It is a plain vertical list on purpose. A horizontal card pager inside the
// tab's page swipe could not hand a swipe at its edge on to the next page on
// device, so the cards stack instead and nothing here competes with the page
// swipe.
//
// ## One capture host, off to the side
//
// The visible cards are fitted to the page; the capture host is laid out at
// its full point size off to the left and is the one that gets captured, from
// the SAME props, so the two never disagree. It draws the card being shared
// (the first card otherwise). It is POSITIONED away, never `display: none`
// and never conditionally mounted while sharing: both capture as nothing. It
// mounts only while the page is active, so a warmed neighbour does not lay out
// a full-size card nobody can share.
//
// ## The capture waits for the switch and the card to commit
//
// Pressing Share records which card; an effect keyed on that waits two
// animation frames before capturing, so the host has drawn that card, with
// the names setting the reader just chose.
//
// ## Height
//
// Each card is fitted to what the page measures (onLayout) through
// `statsCardBox`: the content width, and at most the height that lets one card
// plus its Share pill sit between the header and the tab bar. Never the
// window: inside a tab the window is not the page.

import ShareCardPill from '@/components/custom/analytics/ShareCardPill';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import ShareStatsCard, { fitCardToPage, hostSizeForScale } from '@/components/custom/share-stats/ShareStatsCard';
import { ink } from '@/components/custom/share-stats/card-theme';
import { captureAndShare } from '@/components/custom/share-stats/capture-and-share';
import { STATS_SIDE_GAP, STATS_TOP_GAP, statsCardBox } from '@/components/custom/share-stats/screen-metrics';
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
import { PixelRatio, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';

/** Why the last share of a card did not reach the share sheet. */
type ShareFailure = { readonly card: StatsCardId; readonly kind: 'unavailable' | 'failed' };

/** Space between one card's Share pill and the next card. */
const CARD_GAP = 28;

interface Props {
  /** The visible page of the focused tab. Reloads on becoming active. */
  readonly active?: boolean;
  readonly headerHeight?: number;
  readonly scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
  /** List-end padding (tab bar plus Mera button clearance). */
  readonly listEndPadding?: number;
  /** Raw `card` arrival param (old share-stats links). Untrusted: validated
   *  against the known ids and against what this device has. */
  readonly requestedCard?: unknown;
  /** The list footer (the host's "How this page works" row). */
  readonly footer?: React.ReactNode;
}

const StatsPage: React.FC<Props> = ({
  active = true,
  headerHeight = 0,
  scrollHandler,
  listEndPadding = 0,
  requestedCard,
  footer,
}) => {
  const { t, i18n } = useTranslation();
  const tabClearance = useTabBarClearance();

  const [stats, setStats] = useState<ReadingStats>(emptyReadingStats);
  const [isLoading, setIsLoading] = useState(true);
  const [showNames, setShowNames] = useState(true);
  /** The card being captured, or null. */
  const [sharing, setSharing] = useState<StatsCardId | null>(null);
  const [stampedAtMs, setStampedAtMs] = useState(() => Date.now());
  const [failure, setFailure] = useState<ShareFailure | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [cardTops, setCardTops] = useState<Partial<Record<StatsCardId, number>>>({});

  const captureHostRef = useRef<View>(null);
  const scrollRef = useRef<any>(null);
  const frames = useRef<number | null>(null);
  const landedFor = useRef<unknown>(undefined);
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

  // An arrival naming a card scrolls to it once that card has laid out, once
  // per request. The first card (also where an unknown or unavailable card
  // resolves) is already in view with the names switch above it, so the page
  // stays at the top for it.
  const landing: StatsCardId | null = resolveStatsCardParam(requestedCard, stats);
  const landingTop = landing && landing !== cards[0] ? cardTops[landing] : undefined;
  useEffect(() => {
    if (requestedCard == null || landedFor.current === requestedCard || landingTop === undefined) return;
    landedFor.current = requestedCard;
    // The card's top lands just under the header, not behind it.
    scrollRef.current?.scrollTo?.({ y: Math.max(0, landingTop - headerHeight - STATS_TOP_GAP), animated: false });
    // headerHeight is read at landing time only; a later header resize must not re-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedCard, landingTop]);

  const onCardLayout = useCallback((card: StatsCardId, e: LayoutChangeEvent) => {
    const y = e.nativeEvent.layout.y;
    setCardTops((prev) => (prev[card] === y ? prev : { ...prev, [card]: y }));
  }, []);

  useEffect(() => {
    if (!sharing) return;
    let cancelled = false;
    const card = sharing;
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
          logger.captureException(result.error, { tags: { screen: 'StatsPage', method: 'captureAndShare' } });
        }
        setFailure(result.status === 'shared' ? null : { card, kind: result.status });
        setSharing(null);
      });
      frames.current = inner;
    });
    frames.current = outer;
    return () => {
      cancelled = true;
      if (frames.current !== null) cancelAnimationFrame(frames.current);
    };
  }, [sharing, host.width, host.height, t]);

  const onShare = useCallback((card: StatsCardId) => {
    setFailure(null);
    setStampedAtMs(Date.now());
    setSharing(card);
  }, []);

  const onToggleNames = useCallback((next: boolean) => {
    setShowNames(next);
    // A failure about a card made under the old setting no longer applies.
    setFailure(null);
  }, []);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  const cardSize = fitCardToPage(statsCardBox(box, headerHeight, tabClearance));
  const hostCard: StatsCardId | null = sharing ?? cards[0] ?? null;

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
        {/* Once, above every card: it applies to all of them, and the reader
            meets it before any Share button. */}
        <HStack className="items-center px-5" space="sm" style={{ marginBottom: 16 }} testID="stats-names-row">
          {/* flex-1 is load-bearing: without it the line keeps its intrinsic
              width and spills past the edge instead of wrapping. */}
          <Text size="sm" style={ink('muted')} className="flex-1">
            {t('shareStats.nameTogglePrivacy')}
          </Text>
          <Switch testID="stats-names-switch" value={showNames} onToggle={onToggleNames} size="sm" />
        </HStack>

        {cards.map((id) => (
          <View
            key={id}
            testID={`stats-card-${id}`}
            onLayout={(e) => onCardLayout(id, e)}
            style={{ alignItems: 'center', marginBottom: CARD_GAP }}
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
            <ShareCardPill
              label={t('library.stats.share')}
              onPress={() => onShare(id)}
              disabled={sharing !== null}
              testID={`stats-share-${id}`}
            />
            {sharing === id ? (
              <View style={{ marginTop: 8 }} testID={`stats-sharing-${id}`}>
                <Spinner size="small" />
              </View>
            ) : null}
            {failure?.card === id ? (
              <Text
                size="sm"
                style={ink('muted')}
                className="text-center px-5 mt-2"
                accessibilityLiveRegion="polite"
                testID={`stats-share-failure-${id}`}
              >
                {failure.kind === 'unavailable' ? t('shareStats.sharingUnavailable') : t('shareStats.shareFailed')}
              </Text>
            ) : null}
          </View>
        ))}
      </>
    );
  }

  return (
    <View style={{ flex: 1 }} onLayout={onLayout} testID="stats-page">
      {active && hostCard ? (
        <View
          testID="stats-capture-host"
          style={{ position: 'absolute', left: -8000, top: 0, width: host.width, height: host.height }}
          pointerEvents="none"
        >
          <ShareStatsCard
            ref={captureHostRef}
            card={hostCard}
            stats={stats}
            showPublicationNames={showNames}
            pixelRatio={pixelRatio}
            stampedAtMs={stampedAtMs}
            locale={i18n.language}
          />
        </View>
      ) : null}
      <Animated.ScrollView
        ref={scrollRef}
        testID="stats-scroll"
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: headerHeight + STATS_TOP_GAP, paddingBottom: listEndPadding }}
      >
        {box.width > 0 ? body : null}
        {footer ? <View style={{ paddingHorizontal: STATS_SIDE_GAP }}>{footer}</View> : null}
      </Animated.ScrollView>
    </View>
  );
};

export default StatsPage;
