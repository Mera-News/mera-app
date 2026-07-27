import ArticleCompactCardBase from '@/components/custom/cards/ArticleCompactCardBase';
import CompactActionsSheet from '@/components/custom/cards/CompactActionsSheet';
import type { FeedbackSubject, FeedbackSurface } from '@/components/custom/cards/feedback-subject';
import RelevanceChip from '@/components/custom/RelevanceChip';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import React, { useState } from 'react';

interface ArticleSuggestionCompactCardProps {
  suggestion: ForYouSuggestion;
  onPress: (suggestion: ForYouSuggestion) => void;
  surface?: FeedbackSurface;
  /** Dims the row (~0.55 opacity) — e.g. already-opened Earlier-zone rows. */
  dimmed?: boolean;
  /** Marks the row as read — green tick chip instead of dimming (Dashboard). */
  read?: boolean;
  /** Renders the green "NEW" pill in the meta row (Dashboard section cards). */
  isNew?: boolean;
}

/**
 * The compact suggestion variant — a personalized row for dense lists (the
 * upcoming triage screen). `metaAccessory` is the compact RelevanceChip (once
 * relevance is ready). The compact actions sheet is reached by long-pressing
 * the row.
 */
const ArticleSuggestionCompactCardImpl: React.FC<ArticleSuggestionCompactCardProps> = ({
  suggestion,
  onPress,
  surface = 'triage',
  dimmed = false,
  read = false,
  isNew = false,
}) => {
  const [sheetOpen, setSheetOpen] = useState(false);

  const status = suggestion.status;
  const relevanceReady = !!status && status !== ArticleSuggestionStatus.Unscored;
  const relevance = suggestion.relevance ?? 0;

  // Compact cards never show reason text — the footer carries the fixed-size
  // RelevanceChip (once relevance is ready), right-aligned opposite the source.
  const footerAccessory = relevanceReady ? (
    <RelevanceChip relevance={relevance} />
  ) : undefined;

  const subject: FeedbackSubject = {
    origin: 'suggestion',
    surface,
    articleId: suggestion.articleId,
    suggestionId: suggestion._id,
    title: suggestion.title_en ?? '',
    pubDate: suggestion.firstPubDate ?? null,
    publicationName: suggestion.publication_name,
    countryCode: suggestion.country_code,
    stableClusterId:
      suggestion.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? undefined,
    eventType: suggestion.eventType ?? undefined,
    matchedTopics: suggestion.matchedTopics,
    relevance: suggestion.relevance,
  };

  return (
    <>
      <ArticleCompactCardBase
        imageUrl={suggestion.image_url}
        titleEnglish={suggestion.title_en}
        titleOriginal={suggestion.title_original ?? undefined}
        sourceLanguage={suggestion.language_code ?? undefined}
        pubDate={suggestion.firstPubDate ?? suggestion.createdAt}
        languageCode={suggestion.language_code}
        countryCode={suggestion.country_code}
        publicationName={suggestion.publication_name}
        recyclingKey={suggestion._id}
        dimmed={dimmed}
        read={read}
        isNew={isNew}
        onPress={() => onPress(suggestion)}
        onLongPress={() => setSheetOpen(true)}
        footerAccessory={footerAccessory}
      />
      <CompactActionsSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        subject={subject}
        suggestion={suggestion}
        share={{
          url: suggestion.article_url,
          titleEnglish: suggestion.title_en,
          titleOriginal: suggestion.title_original,
          sourceLanguage: suggestion.language_code,
        }}
      />
    </>
  );
};

export const ArticleSuggestionCompactCard = React.memo(ArticleSuggestionCompactCardImpl);

export default ArticleSuggestionCompactCard;
