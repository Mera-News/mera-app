// Tracked-Story Reconcile — piggybacks on every feed sync to grow followed
// stories from articles the sync JUST persisted, with zero extra network calls.
//
// A followed story is a user-owned TOPIC, linked server-side every cycle by the
// persona query. We match freshly-persisted suggestions whose `matched_topics`
// carry the story's `topic_id`, grow the story, and remember a lean card
// snapshot per new member so the timeline renders it without a server round
// trip. Topic-linked stories NEVER auto-end from a quiet run — the topic keeps
// linking server-side, so quiet ≠ dead (we deliberately do NOT end them here).
//
// (Legacy stable-cluster-id stories are converted to this topic model on app
// open by migrateLegacyTrackedStories, so there is no cluster pass anymore.)
//
// Called fire-and-forget from the feed-sync persist step — must never throw
// into that flow.

import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import type { TrackedStoryMemberSnapshot } from '@/lib/database/models/TrackedStory';
import {
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
 * Reconciles every actively-tracked story against the article_suggestions rows
 * currently on-device. A followed story is a topic, so growth matches by
 * `topic_id`.
 */
export async function reconcileTrackedStories(): Promise<void> {
  await reconcileByTopic();
}
