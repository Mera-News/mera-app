import ArticleCompactCardBase from '@/components/custom/cards/ArticleCompactCardBase';
import CompactActionsSheet from '@/components/custom/cards/CompactActionsSheet';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';

interface ArticleStandaloneCompactCardProps {
  article: NewsArticle;
  onPress: () => void;
  hideSource?: boolean;
  /** Origin-aware overrides (surface, scopeKey, …) merged into the subject. */
  subjectExtras?: Partial<FeedbackSubject>;
  // ── Additive, optional ─────────────────────────────────────────────────
  // The "…" actions button + long-press sheet are OFF by default so every
  // existing surface (Explore, config-panel, news-detail) stays pixel-identical
  // to the old CompactPublisherNewsCard. Future surfaces (triage) opt in.
  showActions?: boolean;
}

// Extract a readable domain from a source_uri as a publisher-name fallback —
// preserved verbatim from CompactPublisherNewsCard.
function extractDomain(url: string): string {
  try {
    const match = url.match(/^https?:\/\/(?:www\.)?([^/]+)/);
    if (match && match[1]) {
      return match[1].replace(/\.(com|org|net|edu|gov|co\.uk|co|io|ai)$/i, '');
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * The standalone compact article row — CompactPublisherNewsCard semantics
 * (source_uri → domain fallback, __DEV__ cluster-confidence chip) delegating all
 * layout to `ArticleCompactCardBase`. Optionally exposes the universal compact
 * actions sheet via a "…" trailing button + long-press.
 */
const ArticleStandaloneCompactCardImpl: React.FC<ArticleStandaloneCompactCardProps> = ({
  article,
  onPress,
  hideSource = false,
  subjectExtras,
  showActions = false,
}) => {
  const [sheetOpen, setSheetOpen] = useState(false);

  const publisherName =
    article.publicationSource?.publication_name ||
    (article.source_uri ? extractDomain(article.source_uri) : 'Source');
  const titleEnglish = article.title_en_internal_only ?? undefined;

  const metaAccessory =
    __DEV__ && typeof article.clusterConfidence === 'number' ? (
      <Box className="bg-amber-900/40 px-1.5 rounded">
        <Text size="xs" className="text-amber-300 font-mono">
          {article.clusterConfidence.toFixed(2)}
        </Text>
      </Box>
    ) : undefined;

  const trailingAccessory = showActions ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="More actions"
      hitSlop={8}
      onPress={() => setSheetOpen(true)}
      className="px-1"
    >
      <MaterialIcons name="more-horiz" size={20} color="#9CA3AF" />
    </Pressable>
  ) : undefined;

  const subject: FeedbackSubject = {
    origin: 'article',
    surface: 'detail',
    articleId: article._id,
    title: titleEnglish ?? article.title ?? '',
    publicationName: article.publicationSource?.publication_name ?? publisherName,
    countryCode: article.publicationSource?.country_code ?? null,
    ...subjectExtras,
  };

  return (
    <>
      <ArticleCompactCardBase
        imageUrl={article.image_url}
        titleEnglish={titleEnglish}
        titleOriginal={article.title ?? undefined}
        sourceLanguage={article.original_language_code ?? undefined}
        pubDate={article.pubDate}
        languageCode={article.original_language_code}
        publicationName={publisherName}
        countryCode={article.publicationSource?.country_code}
        hideSource={hideSource}
        onPress={onPress}
        onLongPress={showActions ? () => setSheetOpen(true) : undefined}
        metaAccessory={metaAccessory}
        trailingAccessory={trailingAccessory}
      />
      {showActions ? (
        <CompactActionsSheet
          visible={sheetOpen}
          onClose={() => setSheetOpen(false)}
          subject={subject}
          article={article}
          share={{
            url: article.article_url ?? article.source_uri,
            titleEnglish: titleEnglish ?? null,
            titleOriginal: article.title,
            sourceLanguage: article.original_language_code,
          }}
        />
      ) : null}
    </>
  );
};

export const ArticleStandaloneCompactCard = React.memo(ArticleStandaloneCompactCardImpl);

export default ArticleStandaloneCompactCard;
