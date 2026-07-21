// FeedbackSubject — the origin-aware descriptor every card action row is given.
//
// A single value type that tells the universal actions row (ArticleActionsRow /
// CompactActionsSheet) WHAT it is acting on and WHERE the action was taken, so
// like/dislike/save/share can be persisted with provenance (origin + surface +
// a context snapshot) regardless of whether the underlying content is a
// personalized ForYouSuggestion or a standalone NewsArticle.

import type { ForYouSuggestion, MatchedTopicRef } from '@/lib/stores/for-you-store';

export type { MatchedTopicRef };

/** The on-screen surface the action was taken on. Open string union so future
 *  surfaces (e.g. a new tab) can pass their own key without a type change. */
export type FeedbackSurface =
  | 'for_you'
  | 'explore'
  | 'triage'
  | 'detail'
  | 'saved'
  | (string & {});

export interface FeedbackSubject {
  /** 'suggestion' = a personalized ForYouSuggestion; 'article' = a standalone
   *  NewsArticle (no relevance/reason/fact chrome). */
  origin: 'suggestion' | 'article';
  /** Where on screen the feedback was given. */
  surface: FeedbackSurface;
  /** The underlying article's id (always present). */
  articleId: string;
  /** The ArticleSuggestion server `_id`, when acting on a suggestion. */
  suggestionId?: string;
  /** Title used for chat handoff, share, and the feedback-tree context strip. */
  title: string;
  /** The article's real publication date (ISO string), when known. Threaded into
   *  the tracked-story seed snapshot so the timeline shows the true pubDate
   *  instead of the track moment (Part E timeline fix). */
  pubDate?: string | null;
  publicationName?: string | null;
  countryCode?: string | null;
  /** Explore scope key (city/region/country) — wired by the Explore wave. */
  scopeKey?: string;
  /** Cross-run stable story id, when known. */
  stableClusterId?: string;
  /** Controlled event-type value, when known. */
  eventType?: string;
  /** Topics the suggestion matched — feeds the dislike → feedback-tree overlay.
   *  Empty/absent for standalone articles. */
  matchedTopics?: MatchedTopicRef[];
  /** Relevance score (suggestions only), for the persisted context snapshot. */
  relevance?: number;
}

/**
 * Snapshot the subject's contextual extras for the persisted feedback row's
 * `context_json`. Shared by every actions surface (ArticleActionsRow /
 * CompactActionsSheet / the swipe feed) so the stored provenance shape is
 * identical everywhere.
 */
export function buildContextJson(subject: FeedbackSubject): string | null {
  const snapshot: Record<string, unknown> = {};
  if (subject.scopeKey) snapshot.scopeKey = subject.scopeKey;
  if (subject.stableClusterId) snapshot.stableClusterId = subject.stableClusterId;
  if (subject.eventType) snapshot.eventType = subject.eventType;
  if (typeof subject.relevance === 'number') snapshot.relevance = subject.relevance;
  if (subject.matchedTopics && subject.matchedTopics.length > 0) {
    snapshot.matchedTopics = subject.matchedTopics;
  }
  return Object.keys(snapshot).length > 0 ? JSON.stringify(snapshot) : null;
}

/**
 * Builds a suggestion-origin {@link FeedbackSubject} from a ForYouSuggestion.
 * Mirrors the descriptor ArticleSuggestionCard assembles so the feed's
 * verdict/tree persistence carries identical provenance.
 */
export function feedbackSubjectFromSuggestion(
  suggestion: ForYouSuggestion,
  surface: FeedbackSurface,
): FeedbackSubject {
  return {
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
}
