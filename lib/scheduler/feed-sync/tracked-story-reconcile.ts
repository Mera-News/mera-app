// Tracked-Story Reconcile — piggybacks on every feed sync to grow followed
// stories from articles the sync JUST persisted, with zero extra network
// calls. One indexed local query (`article_suggestions.stable_cluster_id`)
// covers every actively-tracked story in a single pass; the 30-min
// `tracked-stories-poll-task` (lib/scheduler/tasks/tracked-stories-poll-task.ts)
// covers the gaps this can't see (server-side cluster growth this device
// hasn't hydrated yet, singleton→cluster promotion, archive fallback).
//
// Called fire-and-forget from the feed-sync persist step
// (feed-sync-steps.ts) — must never throw into that flow.

import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import {
  getActiveForReconcile,
  applyUpdates,
  stampChecked,
} from '@/lib/database/services/tracked-story-service';
import { notify } from '@/lib/database/services/notification-service';
import logger from '@/lib/logger';

/**
 * Reconciles every actively-tracked (stable-id-resolved) story against the
 * article_suggestions rows currently on-device: any suggestion whose
 * `stable_cluster_id` matches a tracked story and whose article id isn't
 * already a known member is a new member. Grows the story (`applyUpdates`)
 * and fires ONE quiet bell notification per story that gained members this
 * run. Every examined story is stamped `last_checked_at` (found or not) so
 * the 30-min poll task's staleness window skips stories this reconcile just
 * covered.
 */
export async function reconcileTrackedStories(): Promise<void> {
  const stories = await getActiveForReconcile();
  if (stories.length === 0) return;

  const stableIds = stories.map((s) => s.stableClusterId);
  const suggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
  const rows = await suggestionsCol
    .query(Q.where('stable_cluster_id', Q.oneOf(stableIds)))
    .fetch();

  const articleIdsByStableId = new Map<string, string[]>();
  for (const row of rows) {
    const sid = row.stableClusterId;
    if (!sid) continue; // JS guard for test mock (mirrors getActiveForReconcile)
    const bucket = articleIdsByStableId.get(sid) ?? [];
    bucket.push(row.id); // WMDB row id === server article _id
    articleIdsByStableId.set(sid, bucket);
  }

  for (const story of stories) {
    try {
      const candidateIds = articleIdsByStableId.get(story.stableClusterId) ?? [];
      const existing = new Set(story.memberArticleIds);
      const newMemberIds = candidateIds.filter((id) => !existing.has(id));

      if (newMemberIds.length > 0) {
        await applyUpdates(story.id, { newMemberIds });
        await notify({
          type: 'tracked_story_update',
          title: 'notifications.trackedStoryUpdateTitle',
          body: 'notifications.trackedStoryUpdateBody',
          icon: 'track-changes',
          context: { trackedStoryId: story.id, count: newMemberIds.length },
          source: 'tracked-stories',
        });
      }
    } catch (err) {
      // Isolate per-story failures — one bad row must not block the rest or
      // bubble into the feed-sync flow.
      logger.captureException(err, {
        tags: { component: 'tracked-story-reconcile', method: 'reconcileTrackedStories' },
        extra: { trackedStoryId: story.id },
      });
    } finally {
      await stampChecked(story.id);
    }
  }
}
