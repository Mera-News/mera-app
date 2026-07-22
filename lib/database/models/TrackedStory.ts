import { Model } from '@nozbe/watermelondb';
import { field, date, json } from '@nozbe/watermelondb/decorators';

export type TrackedStoryStatus = 'active' | 'ended';

/**
 * A lean, card-renderable snapshot of one member article, remembered so the
 * timeline can render locally-discovered members without a server round trip.
 * `pubDateMs` drives the strict newest-first ordering; the rest degrade
 * gracefully when absent.
 */
export interface TrackedStoryMemberSnapshot {
  articleId: string;
  title: string;
  pubDateMs: number;
  imageUrl?: string;
  publicationName?: string;
}

/** Coerce the persisted JSON column into a clean string[] (defensive). */
const sanitizeIds = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];

/** Coerce the persisted member-snapshot JSON column into a clean array. */
const sanitizeSnapshots = (raw: unknown): TrackedStoryMemberSnapshot[] =>
  Array.isArray(raw)
    ? raw
        .filter((x): x is TrackedStoryMemberSnapshot => !!x && typeof x === 'object')
        .map((x) => ({
          articleId: String((x as any).articleId ?? ''),
          title: typeof (x as any).title === 'string' ? (x as any).title : '',
          pubDateMs: Number((x as any).pubDateMs) || 0,
          imageUrl:
            typeof (x as any).imageUrl === 'string' ? (x as any).imageUrl : undefined,
          publicationName:
            typeof (x as any).publicationName === 'string'
              ? (x as any).publicationName
              : undefined,
        }))
        .filter((x) => x.articleId.length > 0)
    : [];

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
  // ── Topic-linked tracking (schema v40) ──────────────────────────────
  // The minted `topics` row this story follows. When set, the reconcile
  // matches suggestions by `topic_id` (not cluster id) and the story never
  // auto-ends via cluster misses — the topic keeps linking server-side.
  @field('topic_id') topicId!: string | null;
  @field('topic_text') topicText!: string | null;
  @json('member_snapshots_json', sanitizeSnapshots)
  memberSnapshots!: TrackedStoryMemberSnapshot[];
  // ── Watermark-gated "new" badge (schema v44) ─────────────────────────
  // Epoch ms of the newest member pubDate the user has SEEN (stamped by the
  // timeline screen after a successful load). The reconcile counts only
  // members published strictly after this toward `unseen_count`, so backfilled
  // OLD articles don't inflate the badge. Null ⇒ never opened ⇒ legacy count.
  @field('seen_pub_watermark_ms') seenPubWatermarkMs!: number | null;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;
}
