// Tracked-Story Reconcile — piggybacks on every feed sync to grow followed
// stories from articles the sync JUST persisted, with zero extra network
// calls. Two passes:
//
//   1. TOPIC pass (v40): the current model. A tracked story is a user-owned
//      topic linked server-side every cycle. We match freshly-persisted
//      suggestions whose `matched_topics` carry the story's `topic_id`, grow
//      the story, and remember a lean card snapshot per new member so the
//      timeline renders it without a server round trip. Topic-linked stories
//      NEVER auto-end from a quiet run — the topic keeps linking server-side,
//      so quiet ≠ dead (we deliberately do NOT recordMiss/end them here).
//
//   2. CLUSTER pass (legacy): stories tracked before v40 have no topic_id and
//      still reconcile by stable_cluster_id via one indexed local query.
//
// Both stamp `last_checked_at` so the 30-min poll task's staleness window skips
// stories this reconcile just covered. Called fire-and-forget from the
// feed-sync persist step — must never throw into that flow.

import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import type { TrackedStoryMemberSnapshot } from '@/lib/database/models/TrackedStory';
import {
  getActiveForReconcile,
  getActiveForTopicReconcile,
  applyUpdates,
  stampChecked,
} from '@/lib/database/services/tracked-story-service';
import logger from '@/lib/logger';

/** Safe pubDate → ms for a suggestion row (Date column or number). */
function pubDateMs(row: ArticleSuggestionModel): number {
  const d = row.firstPubDate as unknown;
  if (d instanceof Date) return d.getTime();
  const n = Number(d);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

/** Build the lean member snapshot the timeline renders from a suggestion row. */
function snapshotFromSuggestion(row: ArticleSuggestionModel): TrackedStoryMemberSnapshot {
  return {
    articleId: row.id, // WMDB row id === server article _id
    title: row.titleEn ?? '',
    pubDateMs: pubDateMs(row),
    imageUrl: row.imageUrl ?? undefined,
    publicationName: row.publicationName ?? undefined,
  };
}

/** Parse `matched_topics_json` → the set of topic ids the article matched. */
function matchedTopicIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((m) => (m && typeof m.topicId === 'string' ? m.topicId : null))
      .filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

/**
 * TOPIC pass — grow every active topic-linked story from suggestions whose
 * matched topics carry its topic id. Appends member ids AND snapshots, fires
 * one quiet notify per grown story, and stamps every examined story checked.
 * Never ends a story (the topic keeps linking server-side).
 */
async function reconcileByTopic(): Promise<void> {
  const stories = await getActiveForTopicReconcile();
  if (stories.length === 0) return;

  const suggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
  const rows = await suggestionsCol
    .query(Q.where('matched_topics_json', Q.notEq(null)))
    .fetch();

  // Invert: topicId → suggestion rows that matched it.
  const rowsByTopicId = new Map<string, ArticleSuggestionModel[]>();
  for (const row of rows) {
    for (const topicId of matchedTopicIds(row.matchedTopicsJson)) {
      const bucket = rowsByTopicId.get(topicId) ?? [];
      bucket.push(row);
      rowsByTopicId.set(topicId, bucket);
    }
  }

  for (const story of stories) {
    try {
      const candidates = rowsByTopicId.get(story.topicId) ?? [];
      const existing = new Set(story.memberArticleIds);
      const fresh = candidates.filter((r) => !existing.has(r.id));

      if (fresh.length > 0) {
        await applyUpdates(story.id, {
          newMemberIds: fresh.map((r) => r.id),
          newSnapshots: fresh.map(snapshotFromSuggestion),
        });
      }
    } catch (err) {
      logger.captureException(err, {
        tags: { component: 'tracked-story-reconcile', method: 'reconcileByTopic' },
        extra: { trackedStoryId: story.id },
      });
    } finally {
      await stampChecked(story.id);
    }
  }
}

/**
 * CLUSTER pass (legacy) — grow every active pre-v40 story (no topic_id) from
 * suggestions sharing its stable_cluster_id, via one indexed local query.
 */
async function reconcileByCluster(): Promise<void> {
  const stories = await getActiveForReconcile();
  if (stories.length === 0) return;

  const stableIds = stories.map((s) => s.stableClusterId);
  const suggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
  const rows = await suggestionsCol
    .query(Q.where('stable_cluster_id', Q.oneOf(stableIds)))
    .fetch();

  // Bucket the FULL suggestion rows (not just ids) per stable cluster id so the
  // cluster pass can hand `applyUpdates` a lean snapshot per new member — this
  // gives cluster-path stories watermark-accurate badges (v44) and locally
  // renderable timeline cards, exactly like the topic pass above.
  const rowsByStableId = new Map<string, ArticleSuggestionModel[]>();
  for (const row of rows) {
    const sid = row.stableClusterId;
    if (!sid) continue; // JS guard for test mock (mirrors getActiveForReconcile)
    const bucket = rowsByStableId.get(sid) ?? [];
    bucket.push(row);
    rowsByStableId.set(sid, bucket);
  }

  for (const story of stories) {
    try {
      const candidates = rowsByStableId.get(story.stableClusterId) ?? [];
      const existing = new Set(story.memberArticleIds);
      const fresh = candidates.filter((r) => !existing.has(r.id)); // WMDB row id === server article _id

      if (fresh.length > 0) {
        await applyUpdates(story.id, {
          newMemberIds: fresh.map((r) => r.id),
          newSnapshots: fresh.map(snapshotFromSuggestion),
        });
      }
    } catch (err) {
      // Isolate per-story failures — one bad row must not block the rest or
      // bubble into the feed-sync flow.
      logger.captureException(err, {
        tags: { component: 'tracked-story-reconcile', method: 'reconcileByCluster' },
        extra: { trackedStoryId: story.id },
      });
    } finally {
      await stampChecked(story.id);
    }
  }
}

/**
 * Reconciles every actively-tracked story against the article_suggestions rows
 * currently on-device. Topic-linked stories (v40) match by `topic_id`; legacy
 * stories match by `stable_cluster_id`. Each pass is isolated so one failing
 * pass never blocks the other.
 */
export async function reconcileTrackedStories(): Promise<void> {
  await reconcileByTopic();
  await reconcileByCluster();
}
