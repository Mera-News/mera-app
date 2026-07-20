import { Model } from '@nozbe/watermelondb';
import { field, date, json } from '@nozbe/watermelondb/decorators';

export type TrackedStoryStatus = 'active' | 'ended';

/** Coerce the persisted JSON column into a clean string[] (defensive). */
const sanitizeIds = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];

/**
 * A user-followed ("tracked") news story (schema v39). Long-lived, user-owned
 * state — migrated, never wiped.
 *
 * Once `stableClusterId` is resolved, the reconcile poll matches new server
 * cluster members against `memberArticleIds` and calls `applyUpdates` to grow
 * the story + bump `unseenCount`. `llmHeadline` is the generated English
 * one-liner (rendered downstream via TranslatableDynamic); `fallbackTitle` is
 * captured at track time and always renders until a headline exists.
 * The follow UI and reconcile poll land in later waves; this wave only stands
 * up the table, model, and CRUD service.
 */
export default class TrackedStory extends Model {
  static table = 'tracked_stories';

  @field('stable_cluster_id') stableClusterId!: string | null;
  @json('member_article_ids_json', sanitizeIds) memberArticleIds!: string[];
  @field('llm_headline') llmHeadline!: string | null;
  @field('fallback_title') fallbackTitle!: string;
  @field('latest_article_id') latestArticleId!: string | null;
  @field('latest_title') latestTitle!: string | null;
  @field('origin_surface') originSurface!: string | null;
  @date('last_update_at') lastUpdateAt!: Date | null;
  @field('unseen_count') unseenCount!: number;
  @date('last_checked_at') lastCheckedAt!: Date | null;
  @field('miss_count') missCount!: number;
  @field('status') status!: TrackedStoryStatus;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;
}
