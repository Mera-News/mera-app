import ArticleCompactCardBase from '@/components/custom/cards/ArticleCompactCardBase';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { extractDomain } from '@/lib/publisher-utils';
import React from 'react';

interface ArticleStandaloneCompactCardProps {
  article: NewsArticle;
  onPress: () => void;
  /**
   * Origin-aware overrides (surface, scopeKey, …). Currently INERT — the row no
   * longer opens an actions sheet, so there is no subject to merge them into.
   * Kept so the many call sites keep compiling; safe to delete in a cleanup pass.
   */
  subjectExtras?: Partial<FeedbackSubject>;
  /**
   * Optional secondary gesture, forwarded straight to the base row. The card
   * still draws NO affordance for it — this is the long-press escape hatch a
   * surface uses to offer a per-row action without re-adding the "…" button the
   * compact-card cleanup removed. RN resolves a gesture as either press or
   * long-press, never both, so this cannot fire alongside `onPress`.
   */
  onLongPress?: () => void;
  /** Root testID passthrough, so a surface adding a gesture can expose a stable
   *  driver target (skill invariant 10). No visual effect. */
  testID?: string;
}

/**
 * The standalone compact article row — publisher-name semantics
 * (source_uri → domain fallback, __DEV__ cluster-confidence chip) delegating all
 * layout to `ArticleCompactCardBase`. Tap-first: no "…" button and no actions
 * sheet (removed in the compact-card cleanup). A caller may add an invisible
 * long-press action via `onLongPress`.
 *
 * The row NEVER opens the publisher URL itself. `onPress` must navigate to a
 * detail screen (article-detail / suggestion-detail) — that is the only surface
 * carrying the translate affordance, and opening the URL from here skipped it.
 */
const ArticleStandaloneCompactCardImpl: React.FC<ArticleStandaloneCompactCardProps> = ({
  article,
  onPress,
  onLongPress,
  testID,
}) => {
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

  return (
    <ArticleCompactCardBase
      imageUrl={article.image_url}
      titleEnglish={titleEnglish}
      titleOriginal={article.title ?? undefined}
      sourceLanguage={article.original_language_code ?? undefined}
      pubDate={article.pubDate}
      languageCode={article.original_language_code}
      countryCode={article.publicationSource?.country_code}
      publicationName={publisherName}
      onPress={onPress}
      onLongPress={onLongPress}
      metaAccessory={metaAccessory}
      testID={testID}
    />
  );
};

export const ArticleStandaloneCompactCard = React.memo(ArticleStandaloneCompactCardImpl);

export default ArticleStandaloneCompactCard;
