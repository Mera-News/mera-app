import ArticleCompactCardBase from '@/components/custom/cards/ArticleCompactCardBase';
import CompactActionsSheet from '@/components/custom/cards/CompactActionsSheet';
import type { FeedbackSubject, FeedbackSurface } from '@/components/custom/cards/feedback-subject';
import RelevanceChip from '@/components/custom/RelevanceChip';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';

interface ArticleSuggestionCompactCardProps {
  suggestion: ForYouSuggestion;
  onPress: (suggestion: ForYouSuggestion) => void;
  hideSource?: boolean;
  surface?: FeedbackSurface;
}

/**
 * The compact suggestion variant — a personalized row for dense lists (the
 * upcoming triage screen). `metaAccessory` surfaces a 1-line reason snippet (or
 * the RelevanceChip when there's no reason yet); `trailingAccessory` is the "…"
 * button that opens the compact actions sheet (also reachable by long-press).
 */
const ArticleSuggestionCompactCardImpl: React.FC<ArticleSuggestionCompactCardProps> = ({
  suggestion,
  onPress,
  hideSource = false,
  surface = 'triage',
}) => {
  const [sheetOpen, setSheetOpen] = useState(false);

  const status = suggestion.status;
  const relevanceReady = !!status && status !== ArticleSuggestionStatus.Unscored;
  const reasonReady = status === ArticleSuggestionStatus.Complete;
  const relevance = suggestion.relevance ?? 0;
  const reason = reasonReady ? suggestion.reason ?? '' : '';

  const metaAccessory = reason ? (
    <Box style={{ maxWidth: 140 }}>
      <Text size="xs" numberOfLines={1} className="text-typography-400 italic">
        {reason}
      </Text>
    </Box>
  ) : relevanceReady ? (
    <RelevanceChip relevance={relevance} />
  ) : undefined;

  const trailingAccessory = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="More actions"
      hitSlop={8}
      onPress={() => setSheetOpen(true)}
      className="px-1"
    >
      <MaterialIcons name="more-horiz" size={20} color="#9CA3AF" />
    </Pressable>
  );

  const subject: FeedbackSubject = {
    origin: 'suggestion',
    surface,
    articleId: suggestion.articleId,
    suggestionId: suggestion._id,
    title: suggestion.title_en ?? '',
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
        publicationName={suggestion.publication_name}
        countryCode={suggestion.country_code}
        hideSource={hideSource}
        recyclingKey={suggestion._id}
        onPress={() => onPress(suggestion)}
        onLongPress={() => setSheetOpen(true)}
        metaAccessory={metaAccessory}
        trailingAccessory={trailingAccessory}
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
