// FeedbackSubject — the origin-aware descriptor every card action row is given.
//
// A single value type that tells the universal actions row (ArticleActionsRow /
// CompactActionsSheet) WHAT it is acting on and WHERE the action was taken, so
// like/dislike/save/share can be persisted with provenance (origin + surface +
// a context snapshot) regardless of whether the underlying content is a
// personalized ForYouSuggestion or a standalone NewsArticle.

import type { MatchedTopicRef } from '@/lib/stores/for-you-store';

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
