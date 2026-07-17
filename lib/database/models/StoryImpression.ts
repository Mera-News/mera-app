import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

/**
 * Persona v3 seen-state. Presentation/dedup ONLY — impressions never mutate
 * topics/facts/locations. One row per `article_id`, with `stable_cluster_id`
 * snapshotted at first impression and `opened` upgraded in place. TTL 30d,
 * pruned by data-cleanup-task.
 */
export type ImpressionSurface = 'sectioned' | 'swipe' | 'headlines' | 'detail';

export default class StoryImpression extends Model {
  static table = 'story_impressions';

  @field('article_id') articleId!: string;
  @field('stable_cluster_id') stableClusterId!: string | null;
  @field('suggestion_id') suggestionId!: string | null;
  @text('title_norm') titleNorm!: string | null;
  @field('surface') surface!: ImpressionSurface;
  @field('opened') opened!: boolean;
  @date('first_seen_at') firstSeenAt!: Date;
  @date('last_seen_at') lastSeenAt!: Date;
  @field('seen_count') seenCount!: number;
}
