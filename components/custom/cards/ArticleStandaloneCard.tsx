import ArticleCardBase from '@/components/custom/cards/ArticleCardBase';
import ArticleActionsRow from '@/components/custom/cards/ArticleActionsRow';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import React from 'react';

interface ArticleStandaloneCardProps {
  article: NewsArticle;
  onPress: () => void;
  isNew?: boolean;
  /** Origin-aware overrides (surface, scopeKey, …) merged into the subject. */
  subjectExtras?: Partial<FeedbackSubject>;
}

/**
 * The standalone (non-personalized) full-size card. Maps a raw `NewsArticle`
 * onto `ArticleCardBase` — NO reason box, relevance chip, or fact chips — and
 * renders the universal actions row inline. Used where an article is shown
 * without any personalization context.
 */
const ArticleStandaloneCardImpl: React.FC<ArticleStandaloneCardProps> = ({
  article,
  onPress,
  isNew = false,
  subjectExtras,
}) => {
  const titleEnglish =
    article.title_en_internal_only ?? article.title_en ?? article.title ?? null;

  const subject: FeedbackSubject = {
    origin: 'article',
    surface: 'detail',
    articleId: article._id,
    title: titleEnglish ?? article.title ?? '',
    pubDate: article.pubDate ?? null,
    publicationName: article.publicationSource?.publication_name ?? null,
    countryCode: article.publicationSource?.country_code ?? null,
    ...subjectExtras,
  };

  return (
    <ArticleCardBase
      imageUrl={article.image_url}
      titleEnglish={titleEnglish}
      titleOriginal={article.title ?? undefined}
      sourceLanguage={article.original_language_code ?? undefined}
      pubDate={article.pubDate}
      languageCode={article.original_language_code}
      publicationName={article.publicationSource?.publication_name}
      countryCode={article.publicationSource?.country_code}
      isNew={isNew}
      recyclingKey={article._id}
      onPress={onPress}
    >
      <ArticleActionsRow
        subject={subject}
        article={article}
        share={{
          url: article.article_url ?? article.source_uri,
          titleEnglish,
          titleOriginal: article.title,
          sourceLanguage: article.original_language_code,
        }}
      />
    </ArticleCardBase>
  );
};

export const ArticleStandaloneCard = React.memo(ArticleStandaloneCardImpl);

export default ArticleStandaloneCard;
