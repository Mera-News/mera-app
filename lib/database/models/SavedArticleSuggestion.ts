import { Model } from '@nozbe/watermelondb';
import { field, date } from '@nozbe/watermelondb/decorators';

/**
 * A user-saved article suggestion — a device-local "save for later" snapshot.
 *
 * Unlike `article_suggestions` (an ephemeral 48h feed cache), this table is
 * long-lived, user-owned state with a 30-day TTL (see data-cleanup-task). Every
 * card-renderable field is copied off the source `ForYouSuggestion` at save time
 * so the row stays fully renderable even after the source feed row is pruned.
 *
 * The WatermelonDB `id` is set to the original ArticleSuggestion server `_id`
 * (via `_raw.id = s._id`) so navigation (`articleSuggestionId`) and de-dup work
 * unchanged.
 */
export default class SavedArticleSuggestion extends Model {
  static table = 'saved_article_suggestions';

  @field('article_id') articleId!: string;
  @field('cluster_memberships_json') clusterMembershipsJson!: string | null;
  @field('relevance') relevance!: number;
  @field('reason') reason!: string;
  @field('relevance_generation_completed') relevanceGenerationCompleted!: boolean;
  @field('reason_generation_completed') reasonGenerationCompleted!: boolean;
  @field('country_code') countryCode!: string | null;
  @field('language_code') languageCode!: string | null;
  @field('publication_name') publicationName!: string | null;
  @field('title_en') titleEn!: string | null;
  @field('title_original') titleOriginal!: string | null;
  @field('description_en') descriptionEn!: string | null;
  @field('article_url') articleUrl!: string | null;
  @field('image_url') imageUrl!: string | null;
  @field('matched_topic_texts_json') matchedTopicTextsJson!: string | null;
  @date('created_at') createdAt!: Date;
  @date('first_pub_date') firstPubDate!: Date;
  @date('saved_at') savedAt!: Date;
}
