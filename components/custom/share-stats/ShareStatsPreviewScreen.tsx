// ShareStatsPreviewScreen — preview the stats card, choose whether publication
// names go on it, and hand the PNG to the share sheet.
//
// ## Two copies of the card, on purpose
//
// The card renders twice from the SAME props. The visible one is scaled down
// with a transform so a 9:16 card fits on a phone screen; the hidden one is
// laid out at its full point size, off to the left, and is the one that gets
// captured. A transform is a paint-time effect, so capturing the scaled copy
// would be gambling on how the rasteriser treats a parent transform, and a
// single shared `stats`/`showNames` pair means the two can never disagree about
// what they show.
//
// The offscreen copy is POSITIONED away, never `display: none` and never
// conditionally mounted: both capture as nothing.
//
// ## The capture waits for the toggle to commit
//
// Pressing share sets a flag; an effect keyed on that flag waits two animation
// frames before capturing. Capturing inside the press handler would rasterise
// whatever React last painted, which is how a card ends up carrying publication
// names the reader just switched off.

import ShareCardPill from '@/components/custom/analytics/ShareCardPill';
import ShareStatsCard, {
  fitCardToPage,
  hostSizeForScale,
} from '@/components/custom/share-stats/ShareStatsCard';
import { CARD_ACCENT, ink } from '@/components/custom/share-stats/card-theme';
import { captureAndShare } from '@/components/custom/share-stats/capture-and-share';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import {
  availableCards,
  emptyReadingStats,
  resolveStatsCardParam,
  type ReadingStats,
  type StatsCardId,
} from '@/lib/stats/reading-stats';
import { loadReadingStats } from '@/lib/stats/reading-stats-source';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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

import {
  DOTS_ALLOWANCE,
  HEADER_ALLOWANCE,
  PILL_ALLOWANCE,
} from '@/components/custom/share-stats/screen-metrics';

type ShareMessage = 'unavailable' | 'failed' | null;


interface Props {
  readonly onBack: () => void;
  /** Raw `card` param off the URL. Untrusted: validated against the known ids
   *  and against what this device actually has, never used directly. */
  readonly requestedCard?: unknown;
}

const ShareStatsPreviewScreen: React.FC<Props> = ({ onBack, requestedCard }) => {
  const { t, i18n } = useTranslation();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [stats, setStats] = useState<ReadingStats>(emptyReadingStats);
  const [isLoading, setIsLoading] = useState(true);
  const [showNames, setShowNames] = useState(true);
  const [pendingShare, setPendingShare] = useState(false);
  /**
   * When the card being captured was made.
   *
   * Stamped when the SHARE is pressed, not at mount, so a card left on screen
   * across midnight goes out with today's date. The two animation frames the
   * capture already waits for cover the re-render this causes, so it costs no
   * extra delay and needs no extra frame.
   */
  const [stampedAtMs, setStampedAtMs] = useState(() => Date.now());
  const [message, setMessage] = useState<ShareMessage>(null);

  const captureHostRef = useRef<View>(null);
  /** The pending animation-frame handle, so an unmount mid-wait cancels it. */
  const frames = useRef<number | null>(null);

  const pixelRatio = PixelRatio.get();
  const host = hostSizeForScale(pixelRatio);

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

  useEffect(() => {
    if (!pendingShare) return;
    let cancelled = false;

    // Two frames: the first lets the commit that set `pendingShare` paint, the
    // second lets any toggle change that landed in the same batch paint with
    // it. Capturing before both have is how a stale render reaches the PNG.
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
          logger.captureException(result.error, {
            tags: { screen: 'ShareStatsPreviewScreen', method: 'captureAndShare' },
          });
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
    // Same tick as the flag, so both land in one commit and the first of the
    // two frames paints the card with the capture-moment date.
    setStampedAtMs(Date.now());
    setPendingShare(true);
  }, []);

  const onToggleNames = useCallback((next: boolean) => {
    setShowNames(next);
    // A card captured under the previous setting is no longer what this screen
    // is offering, so any standing message about it goes too.
    setMessage(null);
  }, []);

  // Every card this device has anything to say with, and the one the deep link
  // asked for. `resolveStatsCardParam` validates an untrusted `card` param
  // against the known ids AND against what is actually available, so the
  // shipped no-param link still lands on a real card and `?card=foo` cannot
  // open an empty one.
  const cards = availableCards(stats);
  const landing: StatsCardId | null = resolveStatsCardParam(requestedCard, stats);
  const landingIndex = Math.max(0, cards.indexOf(landing ?? cards[0]));
  const [page, setPage] = useState(landingIndex);
  const activeCard: StatsCardId | null = cards[page] ?? landing;

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(event.nativeEvent.contentOffset.x / Math.max(screenWidth, 1));
      setPage(Math.min(Math.max(next, 0), Math.max(cards.length - 1, 0)));
    },
    [screenWidth, cards.length],
  );

  /**
   * The on-screen card's size, fitted to the EXPORT'S CONTENT-BOX RATIO.
   *
   * The card the reader sees must be the same SHAPE as the one they share, so
   * it is fitted rather than stretched: `fitCardToPage` takes the space the
   * page actually has and returns 1080/1420 inside it, letterboxing
   * horizontally when the page is wider than the ratio allows.
   *
   * Height is the binding dimension, which is why this screen is full-screen
   * and not a Dashboard pane. The earlier pane version had already spent its
   * vertical budget on a collapsing header, a stats sentence and a sub-tab row
   * before the card got any, so a 360x640 portrait host was simply clipped by
   * the pager's bounds — which read as a landscape card with its heatmap sliced
   * mid-row. Nothing was resized; it was cropped. A full-screen route removes
   * the cause rather than shrinking the card to survive it.
   */
  const pageBox = {
    width: screenWidth,
    height:
      screenHeight
      - insets.top
      - insets.bottom
      - HEADER_ALLOWANCE
      - DOTS_ALLOWANCE
      - PILL_ALLOWANCE,
  };
  const cardSize = fitCardToPage(pageBox);

  const renderCard = (id: StatsCardId) => (
    <ShareStatsCard
      card={id}
      stats={stats}
      showPublicationNames={showNames}
      pixelRatio={pixelRatio}
      stampedAtMs={stampedAtMs}
      locale={i18n.language}
      hostSize={cardSize}
    />
  );

  return (
    <Box className="flex-1">
      <DrillDownHeader
        title={t('shareStats.screenTitle')}
        subtitle={t('shareStats.screenSubtitle')}
        onBack={onBack}
      />

      {/* The captured host. Off-screen and fully laid out. Rendered whatever
          the load state is, so a share pressed the instant the data lands has
          a host to snapshot.

          The empty-state gate below is `availableCards`, NOT `hasAnyData`.
          `hasAnyData` is keyed on visits alone so that Manage Data then Clear
          viewing history visibly empties what it promised to; but a reader who
          clears it still has real saved articles, and that action never
          promised to touch those. Per-card availability keeps both claims true
          at once, where the single screen-level flag could only keep one. */}
      <View
        style={{ position: 'absolute', left: -8000, top: 0, width: host.width, height: host.height }}
        pointerEvents="none"
      >
        {activeCard ? (
          <ShareStatsCard
            ref={captureHostRef}
            card={activeCard}
            stats={stats}
            showPublicationNames={showNames}
            pixelRatio={pixelRatio}
            stampedAtMs={stampedAtMs}
            locale={i18n.language}
          />
        ) : null}
      </View>

      {isLoading ? (
        <Box className="flex-1 items-center justify-center">
          <Spinner size="large" />
          <Text size="sm" className="mt-3" style={ink('muted')}>
            {t('shareStats.preparing')}
          </Text>
        </Box>
      ) : cards.length === 0 ? (
        <VStack className="flex-1 items-center justify-center p-6" space="md">
          <MaterialIcons name="insights" size={48} color="#666666" />
          <Text size="md" className="text-white text-center">
            {t('shareStats.emptyTitle')}
          </Text>
          <Text size="sm" className="text-center" style={ink('muted')}>
            {t('shareStats.emptyBody')}
          </Text>
        </VStack>
      ) : (
        <View style={{ flex: 1 }}>
          {/* The pager. A paging ScrollView rather than a Pan detector, so it
              composes through the ordinary responder system and needs no
              arbitration against anything added later. Nothing competes with it
              here: this is a full-screen route, and the Dashboard's right-edge
              strip that would have eaten the last 20pt is deleted outright. */}
          <ScrollView
            testID="share-stats-pager"
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onMomentumEnd}
            contentOffset={{ x: landingIndex * screenWidth, y: 0 }}
            style={{ flexGrow: 0 }}
          >
            {cards.map((id) => (
              <View
                key={id}
                testID={`share-stats-page-${id}`}
                style={{ width: screenWidth, alignItems: 'center', justifyContent: 'center' }}
              >
                {/* Letterboxed, never stretched and never cropped: the card is
                    1080/1420 inside whatever the page has, centred, with space
                    either side when the page is wider than the ratio allows. */}
                <View style={{ width: cardSize.width, height: cardSize.height }}>
                  {renderCard(id)}
                </View>
              </View>
            ))}
          </ScrollView>

          {/* An INDICATOR, not a control. Hidden from the screen reader: the
              pager already announces itself and a second announcement is noise
              rather than access. */}
          <HStack
            testID="share-stats-dots"
            className="items-center justify-center"
            style={{ columnGap: 7, height: DOTS_ALLOWANCE }}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {cards.map((id, index) => (
              <View
                key={id}
                testID={`share-stats-dot-${id}`}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: index === page ? CARD_ACCENT : 'rgba(255,255,255,0.28)',
                }}
              />
            ))}
          </HStack>

          <VStack style={{ height: PILL_ALLOWANCE }}>
            <ShareCardPill
              label={t('shareStats.shareAction')}
              onPress={onShare}
              disabled={pendingShare}
              testID="share-stats-share-button"
            />

            <HStack className="items-center justify-center px-5 mt-2" space="sm">
              {pendingShare ? <Spinner size="small" /> : null}
              {/* `flex-1` is load-bearing, not tidiness. Without it this Text
                  keeps its intrinsic width inside a centred row and spills past
                  BOTH edges rather than wrapping, which is what the privacy
                  line did the moment it was rewritten longer. `numberOfLines`
                  does not save it: a clamp caps the number of lines, it does not
                  make a single unconstrained line wrap. The longest locale is
                  the real test, and German is longer than this again. */}
              <Text
                size="sm"
                style={ink('muted')}
                className="flex-1 text-center"
                numberOfLines={3}
              >
                {message === null
                  ? t('shareStats.nameTogglePrivacy')
                  : message === 'unavailable'
                    ? t('shareStats.sharingUnavailable')
                    : t('shareStats.shareFailed')}
              </Text>
              <Switch
                testID="share-stats-names-switch"
                value={showNames}
                onToggle={onToggleNames}
                size="sm"
              />
            </HStack>
          </VStack>
        </View>
      )}
    </Box>
  );
};

export default ShareStatsPreviewScreen;
