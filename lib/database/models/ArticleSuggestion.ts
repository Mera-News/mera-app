import { Model } from '@nozbe/watermelondb';
import { field, date, children } from '@nozbe/watermelondb/decorators';
import type { Query } from '@nozbe/watermelondb';
import type ArticleSuggestionFact from './ArticleSuggestionFact';

/**
 * The WatermelonDB `id` field IS the MongoDB `_id` of the server-side
 * ArticleSuggestion. Seeded via `_raw.id = a._id` at prepareCreate time, so
 * there is no separate `server_id` column.
 *
 * `clusterIdsJson` is the latest list of clusters this article belongs to,
 * refreshed every sync (overwritten unconditionally, including when empty).
 * An article can be in multiple clusters via the server's
 * `cluster-article-link` model. The For-You feed groups suggestions whose
 * cluster sets overlap into a stacked card. The detail screen's "related
 * articles" panel still calls `relatedArticles(articleId)` to get the
 * authoritative live cluster siblings.
 */
export default class ArticleSuggestion extends Model {
  static table = 'article_suggestions';

  static associations = {
    article_suggestion_facts: { type: 'has_many' as const, foreignKey: 'article_suggestion_id' },
  } as const;

  @field('article_id') articleId!: string;
  @field('cluster_ids_json') clusterIdsJson!: string | null;
  @field('relevance') relevance!: number;
  @field('reason') reason!: string;
  @field('relevance_generation_completed') relevanceGenerationCompleted!: boolean;
  @field('reason_generation_completed') reasonGenerationCompleted!: boolean;
  @field('country_code') countryCode!: string | null;
  @field('language_code') languageCode!: string | null;
  @field('publication_name') publicationName!: string | null;
  @field('title_en') titleEn!: string | null;
  @field('description_en') descriptionEn!: string | null;
  @field('article_url') articleUrl!: string | null;
  @field('image_url') imageUrl!: string | null;
  @field('user_topic_ids_json') userTopicIdsJson!: string | null;
  @date('created_at') createdAt!: Date;
  @date('first_pub_date') firstPubDate!: Date;

  @children('article_suggestion_facts') factLinks!: Query<ArticleSuggestionFact>;
}
