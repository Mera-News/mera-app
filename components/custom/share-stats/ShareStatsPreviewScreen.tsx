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

import ShareStatsCard, { hostSizeForScale } from '@/components/custom/share-stats/ShareStatsCard';
import { ink } from '@/components/custom/share-stats/card-theme';
import { captureAndShare } from '@/components/custom/share-stats/capture-and-share';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import { emptyReadingStats, type ReadingStats } from '@/lib/stats/reading-stats';
import { loadReadingStats } from '@/lib/stats/reading-stats-source';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelRatio, ScrollView, useWindowDimensions, View } from 'react-native';

type ShareMessage = 'unavailable' | 'failed' | null;

interface Props {
  readonly onBack: () => void;
}

const ShareStatsPreviewScreen: React.FC<Props> = ({ onBack }) => {
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();

  const [stats, setStats] = useState<ReadingStats>(emptyReadingStats);
  const [isLoading, setIsLoading] = useState(true);
  const [showNames, setShowNames] = useState(true);
  const [pendingShare, setPendingShare] = useState(false);
  const [message, setMessage] = useState<ShareMessage>(null);

  const captureHostRef = useRef<View>(null);
  /** The pending animation-frame handle, so an unmount mid-wait cancels it. */
  const frames = useRef<number | null>(null);

  const pixelRatio = PixelRatio.get();
  const host = hostSizeForScale(pixelRatio);
  // Leave a gutter either side so the card reads as a card rather than as the
  // screen's background.
  const previewScale = Math.min(1, (screenWidth - 96) / host.width);

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
    setPendingShare(true);
  }, []);

  const onToggleNames = useCallback((next: boolean) => {
    setShowNames(next);
    // A card captured under the previous setting is no longer what this screen
    // is offering, so any standing message about it goes too.
    setMessage(null);
  }, []);

  const card = (
    <ShareStatsCard stats={stats} showPublicationNames={showNames} pixelRatio={pixelRatio} />
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
          a host to snapshot. */}
      <View
        style={{ position: 'absolute', left: -8000, top: 0, width: host.width, height: host.height }}
        pointerEvents="none"
      >
        <ShareStatsCard
          ref={captureHostRef}
          stats={stats}
          showPublicationNames={showNames}
          pixelRatio={pixelRatio}
        />
      </View>

      {isLoading ? (
        <Box className="flex-1 items-center justify-center">
          <Spinner size="large" />
          <Text size="sm" className="mt-3" style={ink('muted')}>
            {t('shareStats.preparing')}
          </Text>
        </Box>
      ) : !stats.hasAnyData ? (
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
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          {/* A transform does not change layout, so the box reserves the scaled
              height itself or the content below it renders under the card. */}
          <Box
            className="items-center"
            style={{ height: host.height * previewScale, marginTop: 16 }}
          >
            <View
              testID="share-stats-preview"
              style={{
                width: host.width,
                height: host.height,
                transform: [{ scale: previewScale }],
                transformOrigin: 'top center',
              }}
            >
              {card}
            </View>
          </Box>

          <VStack className="px-5 mt-5" space="md">
            <HStack className="items-center justify-between py-3 px-4 border border-gray-700 rounded-lg">
              <VStack className="flex-1 pr-3">
                <Text className="text-base text-white">
                  {t('shareStats.nameToggleLabel')}
                </Text>
                <Text size="sm" className="mt-0.5" style={ink('muted')}>
                  {t('shareStats.nameTogglePrivacy')}
                </Text>
              </VStack>
              <Switch
                testID="share-stats-names-switch"
                value={showNames}
                onToggle={onToggleNames}
                size="md"
              />
            </HStack>

            <Pressable
              testID="share-stats-share-button"
              onPress={onShare}
              disabled={pendingShare}
              accessibilityRole="button"
              accessibilityLabel={t('shareStats.shareAction')}
              className="py-4 rounded-lg border border-white items-center"
            >
              <HStack className="items-center" space="sm">
                {pendingShare ? <Spinner size="small" /> : null}
                <Text className="text-white font-semibold">
                  {t('shareStats.shareAction')}
                </Text>
              </HStack>
            </Pressable>

            {/* Inline, never a silent no-op: a feature hides or it says why. */}
            {message !== null && (
              <Text testID="share-stats-message" size="sm" className="text-center" style={ink('muted')}>
                {message === 'unavailable'
                  ? t('shareStats.sharingUnavailable')
                  : t('shareStats.shareFailed')}
              </Text>
            )}
          </VStack>
        </ScrollView>
      )}
    </Box>
  );
};

export default ShareStatsPreviewScreen;
