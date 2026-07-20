// TriageCard — the single centered card under review in triage mode.
//
// Adapted from the (DEPRECATED) SwipeCard visual: image (top ~55%) with an
// overlay chip row (relevance tier, event-type icon, a "+N sources" pill that
// opens the cluster), a title, and an optional reason snippet. Unlike SwipeCard
// there is NO inline feedback row — the verdicts live in TriageActionBar below
// the card. Tapping the card BODY performs the Read verdict via `onPressBody`.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import RelevanceChip from '@/components/custom/RelevanceChip';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions } from 'react-native';

const ACCENT = '#EDA77E';
const H_MARGIN = 16;
/** Fraction of the card height taken by the image. */
const IMAGE_FRACTION = 0.55;
const PLACEHOLDER = require('@/assets/images/news_card_placeholder_image.jpg');

interface TriageCardProps {
  suggestion: ForYouSuggestion;
  /** Card-body tap → the Read verdict (recordOpen + open detail). */
  onPressBody: () => void;
}

/** Controlled event-type → MaterialIcons glyph. Unmapped/absent → no icon. */
function eventTypeIcon(
  eventType: string | null,
): keyof typeof MaterialIcons.glyphMap | null {
  switch (eventType) {
    case 'election':
      return 'how-to-vote';
    case 'weather':
      return 'cloud';
    case 'disaster':
      return 'warning';
    case 'sports':
      return 'sports-soccer';
    case 'business':
      return 'trending-up';
    case 'health':
      return 'medical-services';
    case 'crime':
      return 'gavel';
    default:
      return null;
  }
}

const TriageCard: React.FC<TriageCardProps> = ({ suggestion, onPressBody }) => {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();

  const size = Math.max(0, width - 2 * H_MARGIN);
  const imageHeight = Math.round(size * IMAGE_FRACTION);

  const [imgError, setImgError] = useState(false);

  const eventIcon = eventTypeIcon(suggestion.eventType);
  const primaryClusterId = suggestion.clusters[0]?.clusterId ?? null;
  const sourcesCount = suggestion.clusters.length;
  const showSourcesPill = !!primaryClusterId && sourcesCount > 0;

  const onSourcesPress = useCallback(() => {
    if (!primaryClusterId) return;
    router.push({
      pathname: '/logged-in/news-cluster',
      params: { clusterId: primaryClusterId },
    });
  }, [primaryClusterId]);

  const imageSource =
    imgError || !suggestion.image_url
      ? PLACEHOLDER
      : { uri: suggestion.image_url };

  return (
    <Box
      className="self-center overflow-hidden rounded-2xl bg-background-50 border border-outline-100"
      style={{ width: size, height: size }}
    >
      {/* Card BODY → Read verdict. Nested pressables (sources pill) capture
          their own taps, so they don't trigger onPressBody. */}
      <Pressable onPress={onPressBody} className="flex-1">
        <Box style={{ height: imageHeight }} className="w-full">
          <Image
            source={imageSource}
            size="none"
            resizeMode="cover"
            className="w-full h-full rounded-none"
            alt={suggestion.title_en ?? ''}
            onError={() => setImgError(true)}
          />

          {/* Overlay chip row */}
          <HStack
            className="absolute left-2 top-2 right-2 items-center"
            space="xs"
          >
            <RelevanceChip relevance={suggestion.relevance} />
            {eventIcon ? (
              <Box className="rounded-full bg-black/60 p-1">
                <MaterialIcons name={eventIcon} size={14} color={ACCENT} />
              </Box>
            ) : null}
            {showSourcesPill ? (
              <Pressable
                onPress={onSourcesPress}
                accessibilityRole="button"
                accessibilityLabel={t('feed.moreSources', { count: sourcesCount })}
                className="rounded-full bg-black/60 px-2 py-1"
              >
                <HStack className="items-center" space="xs">
                  <MaterialIcons name="layers" size={12} color={ACCENT} />
                  <Text size="xs" style={{ color: ACCENT, fontWeight: '600' }}>
                    {t('feed.moreSources', { count: sourcesCount })}
                  </Text>
                </HStack>
              </Pressable>
            ) : null}
          </HStack>
        </Box>

        <VStack className="flex-1 px-3 pt-2" space="xs">
          <TranslatableDynamic
            text={suggestion.title_en ?? ''}
            originalText={suggestion.title_original ?? undefined}
            originalLanguage={suggestion.language_code}
            as="heading"
            size="lg"
            numberOfLines={3}
          />
          {suggestion.reason ? (
            <Text size="sm" className="text-typography-400" numberOfLines={3}>
              {suggestion.reason}
            </Text>
          ) : null}
        </VStack>
      </Pressable>
    </Box>
  );
};

export default TriageCard;
