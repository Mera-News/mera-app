import ArticleCardBase from '@/components/custom/cards/ArticleCardBase';
import CardActionBar from '@/components/custom/cards/CardActionBar';
import { getCachedFacts, setCachedFacts } from '@/components/custom/cards/facts-cache';
import RelevanceChip from '@/components/custom/RelevanceChip';
import StreamingIndicator from '@/components/custom/chat/StreamingIndicator';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { getFactsForTopicTexts } from '@/lib/database/services/fact-service';
import {
  saveSuggestion,
  deleteSavedSuggestion,
  isSuggestionSaved,
} from '@/lib/database/services/saved-article-suggestion-service';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { useShareArticle } from '@/lib/hooks/useShareArticle';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { reasonBoxColors } from '@/lib/relevance-utils';
import type { Verdict } from '@/lib/stores/feed-order-store';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import React, { useEffect, useState } from 'react';

interface ArticleCardProps {
  suggestion: ForYouSuggestion;
  /**
   * Called with the row's suggestion when the card is pressed. Takes the
   * suggestion (not a zero-arg thunk) so callers can pass a single STABLE
   * handler for every row — that stable identity is what lets the `React.memo`
   * boundary below skip re-rendering unchanged rows (perf item A2).
   */
  onPress: (suggestion: ForYouSuggestion) => void;
  timestamp?: string;
  isNew?: boolean;
  /** Number of additional source publications collapsed into this story card. */
  moreSourcesCount?: number;
  // ── Action row (the small borderless CardActionBar) ────────────────────
  // The action row renders ONLY when `onVerdict` is provided. Surfaces that use
  // it (the For You feed + the fact feed) pass the flat trio below; surfaces that
  // don't (Saved) omit them and get a pixel-identical action-less card. Kept as
  // FLAT, memo-safe props so a row re-renders only when its own verdict flips.
  /** The card's currently-stored verdict (null when undecided). */
  verdict?: Verdict | null;
  /** A thumb was tapped — the host records the verdict + floats the sheet. */
  onVerdict?: (suggestion: ForYouSuggestion, verdict: Verdict) => void;
  /** The Mera icon was tapped — open the default article chat. */
  onAskMera?: (suggestion: ForYouSuggestion) => void;
  /** Dims the card (~0.55 opacity) — e.g. already-opened Earlier-zone rows. */
  dimmed?: boolean;
  /** Marks the card as read — green tick chip instead of dimming (Dashboard). */
  read?: boolean;
  /** Pass-through to `ArticleCardBase` — renders as the floating neumorphic
   *  card (Dashboard's list treatment) instead of the default Card chrome.
   *  Default false. */
  flat?: boolean;
}

export type { ArticleCardProps };

/**
 * The suggestion (personalized) full-size card. Owns the suggestion-specific
 * chrome moved out of `ArticleSuggestionContainer`'s card path — status gating,
 * the reason box, the fact chips (+ their LRU cache), and the __DEV__ relevance
 * readout — and delegates all layout to `ArticleCardBase`.
 *
 * Drop-in for the old `ArticleCard`: same props + memo/stable-handler contract.
 */
const ArticleSuggestionCardImpl: React.FC<ArticleCardProps> = ({
  suggestion,
  onPress,
  timestamp,
  isNew = false,
  moreSourcesCount,
  verdict = null,
  onVerdict,
  onAskMera,
  dimmed = false,
  read = false,
  flat = false,
}) => {
  const [facts, setFacts] = useState<Fact[]>([]);

  // Card-local saved state — restored across remounts (ported verbatim from
  // FeedArticleCard, which mirrored ArticleActionsRow). Only wired when the
  // action row is present (onVerdict provided).
  const savedId = suggestion._id;
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!onVerdict) return;
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
  }, [savedId, onVerdict]);

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

  const handleShare = useShareArticle({
    url: suggestion.article_url,
    titleEnglish: suggestion.title_en,
    titleOriginal: suggestion.title_original,
    sourceLanguage: suggestion.language_code,
  });

  const status = suggestion.status;
  const relevanceReady = !!status && status !== ArticleSuggestionStatus.Unscored;
  const reasonReady = status === ArticleSuggestionStatus.Complete;
  const relevance = suggestion.relevance ?? 0;
  const reason = relevanceReady ? suggestion.reason ?? '' : '';
  const reasonLoading = status === ArticleSuggestionStatus.ReasonPending && !reason;

  // Fact chips only render on a complete, reason-less suggestion — mirror that
  // exact gate here so facts are only queried when the chips can appear. The
  // module-level LRU cache lets cards sharing a topic set skip the query (A5).
  const canRenderFactChips = reasonReady && !reason;
  const topicIdsKey = (suggestion.userTopicIds ?? []).join(' ');
  useEffect(() => {
    const topicIds = suggestion.userTopicIds ?? [];
    if (!canRenderFactChips || topicIds.length === 0) {
      setFacts([]);
      return;
    }
    const cacheKey = [...topicIds].sort().join(' ');
    const cached = getCachedFacts(cacheKey);
    if (cached) {
      setFacts(cached);
      return;
    }
    let cancelled = false;
    getFactsForTopicTexts(topicIds)
      .then((f) => {
        if (cancelled) return;
        setCachedFacts(cacheKey, f);
        setFacts(f);
      })
      .catch(() => {
        if (!cancelled) setFacts([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRenderFactChips, topicIdsKey]);

  const factChipsEl = reasonReady && !reason && facts.length > 0 ? (
    <HStack className="flex-wrap justify-end" space="xs">
      {facts.map((fact) => (
        <Box
          key={fact.id}
          className="px-2.5 py-1 rounded-full mb-1"
          style={{ backgroundColor: reasonBoxColors.backgroundColor }}
        >
          <Text
            size="xs"
            style={{ color: reasonBoxColors.textColor, fontWeight: '600', fontSize: 11 }}
            numberOfLines={1}
          >
            {fact.statement}
          </Text>
        </Box>
      ))}
    </HStack>
  ) : null;

  const reasonBoxEl = relevanceReady && (reason || reasonLoading) ? (
    <Box
      className="rounded-lg p-3 flex-row items-center"
      style={{ backgroundColor: reasonBoxColors.backgroundColor }}
    >
      <RelevanceChip relevance={relevance} />
      {reason ? (
        <TranslatableDynamic
          text={reason}
          size="sm"
          italic
          bold
          className="ml-3 flex-1 text-right"
          style={{ color: reasonBoxColors.textColor }}
        />
      ) : (
        <Box className="ml-3 flex-1 items-end">
          <StreamingIndicator compact color={reasonBoxColors.textColor} />
        </Box>
      )}
    </Box>
  ) : null;

  const metaAccessory = __DEV__ && relevanceReady ? (
    <Box className="px-2 py-0.5 rounded bg-background-50">
      <Text size="xs" className="text-typography-400 font-mono">
        {relevance.toFixed(2)}
      </Text>
    </Box>
  ) : undefined;

  return (
    <ArticleCardBase
      imageUrl={suggestion.image_url}
      titleEnglish={suggestion.title_en}
      titleOriginal={suggestion.title_original ?? undefined}
      sourceLanguage={suggestion.language_code ?? undefined}
      pubDate={timestamp ?? suggestion.firstPubDate ?? suggestion.createdAt ?? ''}
      languageCode={suggestion.language_code}
      publicationName={suggestion.publication_name}
      countryCode={suggestion.country_code}
      isNew={isNew}
      moreSourcesCount={moreSourcesCount}
      recyclingKey={suggestion._id}
      dimmed={dimmed}
      read={read}
      flat={flat}
      onPress={() => onPress(suggestion)}
      metaAccessory={metaAccessory}
    >
      {factChipsEl}
      {reasonBoxEl}
      {onVerdict ? (
        // Action row as the last child inside ArticleCardBase — `horizontalPadding
        // = 0` because the base's `p-4` VStack already insets it (no double pad).
        // Share is offered only when the story has a URL to share.
        <CardActionBar
          verdict={verdict}
          saved={saved}
          onLike={() => onVerdict(suggestion, 'like')}
          onDislike={() => onVerdict(suggestion, 'dislike')}
          onAskMera={() => onAskMera?.(suggestion)}
          onToggleSave={handleToggleSave}
          onShare={suggestion.article_url ? () => void handleShare() : undefined}
          horizontalPadding={0}
        />
      ) : null}
    </ArticleCardBase>
  );
};

// Memoized (shallow compare) so a row only re-renders when its own props change
// — the feed sync keeps the same `suggestion` ref for untouched rows and
// `onPress` is stable, so shallow compare bails out unchanged rows (perf A2).
export const ArticleSuggestionCard = React.memo(ArticleSuggestionCardImpl);

export default ArticleSuggestionCard;
