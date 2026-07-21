// SwipeArticleCard — one tall, button-less card in the Feed swipe deck. Sized
// to fill the deck area (the parent sets width = screen − 32 and the stack
// height). Hero image on top ~50%, then meta row + 3-line title + reason box +
// an optional "+N sources" chip. Two stamp overlays (LIKE / NOPE) are driven by
// shared-value opacities the deck feeds from the drag position.
//
// Tapping the card body opens the story (surface 'swipe'); the labeled verdict
// controls live OUTSIDE the card (VerdictBar) — the card itself carries no
// buttons.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
import RelevanceChip from '@/components/custom/RelevanceChip';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import { reasonBoxColors } from '@/lib/relevance-utils';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

const PLACEHOLDER = require('@/assets/images/news_card_placeholder_image.jpg');

interface SwipeArticleCardProps {
  suggestion: ForYouSuggestion;
  /** Members collapsed into this story (rep included). `> 1` ⇒ "+N sources". */
  memberCount: number;
  /** Drag-driven LIKE stamp opacity (0–1). Static cards pass a constant 0. */
  likeOpacity: SharedValue<number>;
  /** Drag-driven NOPE stamp opacity (0–1). */
  nopeOpacity: SharedValue<number>;
  /** Whether tapping opens the story. Off for the behind-cards (top card only). */
  interactive?: boolean;
}

const SwipeArticleCard: React.FC<SwipeArticleCardProps> = ({
  suggestion,
  memberCount,
  likeOpacity,
  nopeOpacity,
  interactive = true,
}) => {
  const { t } = useTranslation();
  const open = useOpenSuggestion('swipe');

  const [imageFailed, setImageFailed] = React.useState(false);
  const imageSource =
    imageFailed || !suggestion.image_url ? PLACEHOLDER : { uri: suggestion.image_url };

  const status = suggestion.status;
  const relevanceReady = !!status && status !== ArticleSuggestionStatus.Unscored;
  const relevance = suggestion.relevance ?? 0;
  const reason = relevanceReady ? suggestion.reason ?? '' : '';
  const extraSources = memberCount > 1 ? memberCount - 1 : 0;

  const likeStampStyle = useAnimatedStyle(() => ({ opacity: likeOpacity.value }));
  const nopeStampStyle = useAnimatedStyle(() => ({ opacity: nopeOpacity.value }));

  return (
    <Pressable
      onPress={interactive ? () => open(suggestion) : undefined}
      disabled={!interactive}
      className="flex-1 overflow-hidden rounded-2xl bg-background-50 border border-outline-100"
    >
      {/* Hero image (top ~50%). */}
      <Box className="w-full overflow-hidden" style={{ height: '50%' }}>
        <Image
          source={imageSource}
          alt={suggestion.title_en ?? ''}
          size="none"
          resizeMode="cover"
          recyclingKey={suggestion._id}
          className="w-full h-full rounded-none"
          onError={() => setImageFailed(true)}
        />

        {/* LIKE stamp (top-left, rotated). */}
        <Animated.View
          pointerEvents="none"
          style={[styles.stamp, styles.likeStamp, likeStampStyle]}
        >
          <Text style={[styles.stampText, styles.likeText]}>{t('swipeFeed.likeStamp')}</Text>
        </Animated.View>

        {/* NOPE stamp (top-right, rotated). */}
        <Animated.View
          pointerEvents="none"
          style={[styles.stamp, styles.nopeStamp, nopeStampStyle]}
        >
          <Text style={[styles.stampText, styles.nopeText]}>{t('swipeFeed.nopeStamp')}</Text>
        </Animated.View>

        {extraSources > 0 ? (
          <Box className="absolute left-3 bottom-3 rounded-full bg-black/70 px-2.5 py-1">
            <HStack className="items-center" space="xs">
              <MaterialIcons name="layers" size={13} color="#EDA77E" />
              <Text size="xs" style={{ color: '#EDA77E', fontWeight: '600' }}>
                {t('feed.moreSources', { count: extraSources })}
              </Text>
            </HStack>
          </Box>
        ) : null}
      </Box>

      {/* Body: meta → title → reason. */}
      <VStack className="flex-1 px-4 pt-3" space="sm">
        <ArticleMetaRow
          pubDate={suggestion.firstPubDate ?? suggestion.createdAt}
          languageCode={suggestion.language_code}
          publicationName={suggestion.publication_name}
          countryCode={suggestion.country_code}
          variant="card"
        />
        <TranslatableDynamic
          text={suggestion.title_en ?? t('feed.newsCluster')}
          originalText={suggestion.title_original ?? undefined}
          originalLanguage={suggestion.language_code}
          as="heading"
          size="xl"
          numberOfLines={3}
          className="text-white leading-7"
        />
        {relevanceReady && reason ? (
          <Box
            className="rounded-lg p-3 flex-row items-center"
            style={{ backgroundColor: reasonBoxColors.backgroundColor }}
          >
            <RelevanceChip relevance={relevance} />
            <TranslatableDynamic
              text={reason}
              size="sm"
              italic
              bold
              className="ml-3 flex-1 text-right"
              style={{ color: reasonBoxColors.textColor }}
            />
          </Box>
        ) : null}
      </VStack>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  stamp: {
    position: 'absolute',
    top: 20,
    borderWidth: 4,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  likeStamp: {
    left: 18,
    borderColor: '#22C55E',
    transform: [{ rotate: '-18deg' }],
  },
  nopeStamp: {
    right: 18,
    borderColor: '#EF4444',
    transform: [{ rotate: '18deg' }],
  },
  stampText: {
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 2,
  },
  likeText: { color: '#22C55E' },
  nopeText: { color: '#EF4444' },
});

export default SwipeArticleCard;
