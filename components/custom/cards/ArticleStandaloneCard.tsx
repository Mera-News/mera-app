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
  /** Pass-through to `ArticleCardBase` — space kept clear at the meta row for a
   *  host-owned control floating over the card's top-right (Saved list). */
  metaRowRightReserve?: number;
  /** Pass-through to `ArticleCardBase` — renders the floating `rounded-2xl`
   *  surface the Feed and Dashboard article cards use, instead of the older
   *  `Card`-wrapped `rounded-md` chrome. Default false so nothing else moves;
   *  the Saved list opts in so its rows match the rest of the app.
   *
   *  It also corrects `metaRowRightReserve`: that reserve is quoted from the
   *  card's OUTER right edge and `ArticleCardBase` subtracts only the content
   *  VStack's own `px-4`, but the non-flat branch adds a further 16px via the
   *  `Card`'s `p-4` — so an un-flat card under-reserves by exactly that much. */
  flat?: boolean;
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
  metaRowRightReserve,
  flat = false,
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
    category: article.category ?? null,
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
      metaRowRightReserve={metaRowRightReserve}
      flat={flat}
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
