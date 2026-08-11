// detail-feedback-context — how the article/suggestion DETAIL screens build the
// feedback context their like/dislike surface needs.
//
// This replaces the `feedbackContext` prop, a detail-screen-only shim that
// fabricated a partial `ForYouSuggestion` behind an `as unknown as` cast. Two
// screens render the same widget and only ONE of them filled the shim in, and
// because the cast erased the type there was nothing to notice the omission:
// `buildContextJson` persisted null on every article-detail verdict, which made
// the digest's publication / category / event / topic / relevance candidates a
// no-op for that whole surface, and `never_show` could not even propose a mute.
//
// The fix is the Feed's own derivation instead of a wider shim: resolve the
// LOCAL `article_suggestions` row by articleId (it carries matched topics,
// category, event type, cluster size and geo), and fall back to the article
// itself — whose GraphQL selection now carries category/entities/event_type/
// geo_tags — only when no such row exists (Explore, a tracked story, a shared
// link). Nothing is cast: the standalone path builds a REAL ForYouSuggestion.

import {
  feedbackSubjectFromSuggestion,
  type FeedbackSubject,
} from '@/components/custom/cards/feedback-subject';
import {
  geoTextFromTags,
  getSuggestionFeedbackContext,
  placeValueFromTags,
} from '@/lib/database/services/article-suggestion-service';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

export interface DetailFeedbackContext {
  /** The real suggestion the feedback surface renders against. */
  suggestion: ForYouSuggestion;
  /** Provenance snapshot persisted onto the verdict row's `context_json`. */
  subject: FeedbackSubject;
  /** Context the inline tree cannot derive from the suggestion itself. Empty on
   *  the suggestion path (the tree reads the local row directly); populated from
   *  the article on the standalone path. */
  contextFallback: Partial<LocalFeedbackContext>;
}

/** A REAL ForYouSuggestion for an article with no local suggestion row. Every
 *  field is present and honest — an unscored, unmatched, article-backed row. */
function suggestionFromArticle(
  articleId: string,
  title: string,
  article?: NewsArticle | null,
): ForYouSuggestion {
  const pubDate = article?.pubDate ? String(article.pubDate) : new Date().toISOString();
  return {
    _id: articleId,
    articleId,
    clusters: [],
    relevance: 0,
    reason: '',
    status: ArticleSuggestionStatus.Unscored,
    country_code: article?.publicationSource?.country_code ?? null,
    language_code: article?.original_language_code ?? null,
    publication_name: article?.publicationSource?.publication_name ?? null,
    title_en: title,
    title_original: article?.title ?? null,
    description_en: article?.description_en ?? article?.description ?? null,
    article_url: article?.article_url ?? null,
    image_url: article?.image_url ?? null,
    userTopicIds: [],
    createdAt: pubDate,
    firstPubDate: pubDate,
    rawScore: null,
    eventType: article?.event_type ?? null,
    // Carried for the same reason as `event_type`: both are story-grouping's
    // entity-edge inputs, and this row is a REAL suggestion that can end up in
    // a grouping pool.
    entities: article?.entities ?? [],
    headlineScope: null,
    // A standalone article matched no topic — the tree gates out the
    // topic-dependent nodes rather than inventing a target for them.
    matchedTopics: [],
    factIds: [],
    scoredAt: null,
  };
}

/**
 * Resolve the detail screen's feedback context. Prefers the local suggestion
 * row (resolvable by articleId alone); falls back to the article.
 */
export async function resolveDetailFeedbackSubject(opts: {
  articleId: string;
  suggestionId?: string;
  title: string;
  article?: NewsArticle | null;
}): Promise<DetailFeedbackContext> {
  try {
    const fb = await getSuggestionFeedbackContext({
      suggestionId: opts.suggestionId,
      articleId: opts.articleId,
    });
    if (fb) {
      return {
        suggestion: fb.suggestion,
        // `category` is on the ROW, not on the projected suggestion — pass it
        // explicitly or the persisted snapshot silently drops it.
        subject: feedbackSubjectFromSuggestion(fb.suggestion, 'detail', {
          category: fb.category,
        }),
        contextFallback: {},
      };
    }
  } catch (err) {
    logger.captureException(err, {
      tags: { component: 'detail-feedback-context', method: 'suggestionRow' },
    });
  }

  const article = opts.article ?? null;
  const suggestion = suggestionFromArticle(opts.articleId, opts.title, article);
  const category = article?.category ?? null;
  const geoText = geoTextFromTags(article?.geo_tags ?? []);
  // The verbatim tag field behind `geoText`, for the `place` FILTER (the prose
  // form resolves a supranational code and would match nothing). The standalone
  // suggestion carries `entities` but no `geoTags`, so unlike the entity this
  // one cannot be derived from the row and has to travel in the fallback.
  const placeValue = placeValueFromTags(article?.geo_tags ?? []);
  return {
    suggestion,
    subject: {
      origin: 'article',
      surface: 'detail',
      articleId: opts.articleId,
      title: opts.title,
      pubDate: article?.pubDate ? String(article.pubDate) : null,
      publicationName: suggestion.publication_name,
      countryCode: suggestion.country_code,
      category,
      eventType: article?.event_type ?? undefined,
      matchedTopics: [],
    },
    contextFallback: {
      ...(category ? { category } : {}),
      ...(geoText ? { geoText } : {}),
      ...(placeValue ? { placeValue } : {}),
    },
  };
}
