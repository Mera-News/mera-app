import { Model } from '@nozbe/watermelondb';
import { field, date, children } from '@nozbe/watermelondb/decorators';
import type { Query } from '@nozbe/watermelondb';
import type ArticleSuggestionFact from './ArticleSuggestionFact';
import type { ArticleSuggestionStatus } from '../article-suggestion-status';

/**
 * The WatermelonDB `id` field IS the MongoDB `_id` of the server-side
 * ArticleSuggestion. Seeded via `_raw.id = a._id` at prepareCreate time, so
 * there is no separate `server_id` column.
 *
 * `clusterMembershipsJson` is the latest list of clusters this article belongs
 * to, each with its HDBSCAN membership confidence — refreshed every sync
 * (overwritten unconditionally, including when empty). An article can be in
 * multiple clusters via the server's `cluster-article-link` model. The For-You
 * feed collapses suggestions whose dense (high-confidence) cluster cores
 * overlap into a single representative card. The detail screen's "related
 * articles" panel still calls `relatedArticles(articleId)` to get the
 * authoritative live cluster siblings.
 */
export default class ArticleSuggestion extends Model {
  static table = 'article_suggestions';

  static associations = {
    article_suggestion_facts: { type: 'has_many' as const, foreignKey: 'article_suggestion_id' },
  } as const;

  @field('article_id') articleId!: string;
  @field('cluster_memberships_json') clusterMembershipsJson!: string | null;
  @field('relevance') relevance!: number;
  @field('reason') reason!: string;
  @field('status') status!: ArticleSuggestionStatus;
  @field('country_code') countryCode!: string | null;
  @field('language_code') languageCode!: string | null;
  @field('publication_name') publicationName!: string | null;
  @field('title_en') titleEn!: string | null;
  @field('title_original') titleOriginal!: string | null;
  @field('description_en') descriptionEn!: string | null;
  @field('article_url') articleUrl!: string | null;
  @field('image_url') imageUrl!: string | null;
  @field('matched_topic_texts_json') matchedTopicTextsJson!: string | null;
  // ── Persona v3 (schema v37) scorer inputs + audit ──────────────
  // Hydration-carried article metadata (nullable until the server tagging
  // pipeline backfills; absence routes the engine to the backstop path).
  @field('geo_tags_json') geoTagsJson!: string | null;
  @field('entities_json') entitiesJson!: string | null;
  @field('event_type') eventType!: string | null;
  @field('category') category!: string | null;
  @field('max_cluster_size') maxClusterSize!: number | null;
  @field('stable_cluster_id') stableClusterId!: string | null;
  // null = topic-retrieved; 'CITY'|'COUNTRY'|'GLOBAL' for top-headline injection.
  @field('headline_scope') headlineScope!: string | null;
  // [{ topicId, text, vectorScore? }] — inverted per-topic matchMeta.
  @field('matched_topics_json') matchedTopicsJson!: string | null;
  // Deterministic engine raw score (pre-judge) — the fail-open source of truth.
  @field('computed_score') computedScore!: number | null;
  // Final post-judge raw score (for within-section ordering / audit).
  @field('raw_score') rawScore!: number | null;
  // Full RelevanceComponents breakdown (audit + judge context).
  @field('score_components_json') scoreComponentsJson!: string | null;
  // Round-3 (schema v41): epoch ms the row was scored (math persisted). Null
  // while unscored. Feeds the fact-rows selector's "added" ordering.
  @field('scored_at') scoredAt!: number | null;
  @date('created_at') createdAt!: Date;
  @date('first_pub_date') firstPubDate!: Date;

  @children('article_suggestion_facts') factLinks!: Query<ArticleSuggestionFact>;
}
