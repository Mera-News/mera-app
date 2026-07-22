// FeedArticleCard — one card in the Instagram-style vertical Feed. An optional
// full-bleed hero image (omitted entirely when the article has no image or it
// fails to load — no placeholder), then the body (meta → 3-line title → compact
// reason box), and the small borderless CardActionBar beneath the body. Tapping
// the BODY opens the story detail; the action bar carries like/dislike/Mera/save.
// No read button on the face — that lives on the detail screen. Save state is
// card-local (restored via isSuggestionSaved on mount), matching ArticleActionsRow.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
import RelevanceChip from '@/components/custom/RelevanceChip';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import CardActionBar from './CardActionBar';
import {
  saveSuggestion,
  deleteSavedSuggestion,
  isSuggestionSaved,
} from '@/lib/database/services/saved-article-suggestion-service';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { reasonBoxColors } from '@/lib/relevance-utils';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { Verdict } from '@/lib/stores/feed-session-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dimensions } from 'react-native';

const HERO_HEIGHT = Math.min(Dimensions.get('window').width * 0.66, 300);

interface FeedArticleCardProps {
  item: FeedListItem;
  /** The card's currently-stored verdict (null when undecided). */
  verdict: Verdict | null;
  /** Body tap → open the story detail. */
  onPress: (suggestion: ForYouSuggestion) => void;
  /** A thumb was tapped — the screen records + opens the feedback sheet. */
  onVerdict: (item: FeedListItem, verdict: Verdict) => void;
  /** The Mera icon was tapped — open the default article chat. */
  onAskMera: (item: FeedListItem) => void;
}

const FeedArticleCard: React.FC<FeedArticleCardProps> = ({
  item,
  verdict,
  onPress,
  onVerdict,
  onAskMera,
}) => {
  const { t } = useTranslation();
  const suggestion = item.suggestion;

  // No placeholder — a missing or broken image collapses the hero entirely.
  const [imageFailed, setImageFailed] = useState(false);
  const showHero = !!suggestion.image_url && !imageFailed;

  // Card-local saved state — restored across remounts (ArticleActionsRow pattern).
  const savedId = suggestion._id;
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    isSuggestionSaved(savedId)
      .then((v) => {
        if (!cancelled && v) setSaved(true);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [savedId]);

  const handleToggleSave = () => {
    if (saved) {
      hapticLight();
      setSaved(false);
      void deleteSavedSuggestion(savedId);
    } else {
      hapticSuccess();
      setSaved(true);
      void saveSuggestion(suggestion);
    }
  };

  const status = suggestion.status;
  const relevanceReady = !!status && status !== ArticleSuggestionStatus.Unscored;
  const relevance = suggestion.relevance ?? 0;
  const reason = relevanceReady ? suggestion.reason ?? '' : '';
  const extraSources = item.memberCount > 1 ? item.memberCount - 1 : 0;
  const dimmed = verdict != null;

  return (
    <Box
      className="overflow-hidden rounded-2xl bg-background-50 border border-outline-100"
      style={{ marginBottom: 16 }}
    >
      {/* Hero image (full-bleed, fixed height) — rendered ONLY when the article
          has an image that loads. A missing or broken image collapses it so the
          card is just its clean rounded box. Stays full opacity even when the
          card is verdicted — only the body dims. */}
      {showHero ? (
        <Box className="w-full overflow-hidden" style={{ height: HERO_HEIGHT }}>
          <Image
            source={{ uri: suggestion.image_url! }}
            alt={suggestion.title_en ?? ''}
            size="none"
            resizeMode="cover"
            recyclingKey={suggestion._id}
            className="w-full h-full rounded-none"
            onError={() => setImageFailed(true)}
          />
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
      ) : null}

      {/* Body — tap to open the story detail. Dims when verdicted. */}
      <Pressable onPress={() => onPress(suggestion)} style={{ opacity: dimmed ? 0.7 : 1 }}>
        <VStack className="px-4 pt-4" space="sm">
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
            size="lg"
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
                className="ml-3 flex-1 text-right text-white"
                style={{ color: reasonBoxColors.textColor }}
              />
            </Box>
          ) : null}
        </VStack>
      </Pressable>

      {/* Action bar after the reason box, at the foot of the card. Its own
          vertical padding provides the card's bottom spacing. */}
      <CardActionBar
        verdict={verdict}
        saved={saved}
        onLike={() => onVerdict(item, 'like')}
        onDislike={() => onVerdict(item, 'dislike')}
        onAskMera={() => onAskMera(item)}
        onToggleSave={handleToggleSave}
      />
    </Box>
  );
};

export default React.memo(FeedArticleCard);
