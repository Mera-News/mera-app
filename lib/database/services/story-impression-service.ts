// Story-Impression Service — WatermelonDB adapter for persona-v3
// `story_impressions` seen-state. Presentation/dedup ONLY: impressions never
// mutate topics/facts/locations. One row per article_id, upserted;
// `opened` upgrades in place and never downgrades. TTL 30d via
// `deleteOlderThan` (data-cleanup-task).

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import logger from '../../logger';
import type StoryImpressionModel from '../models/StoryImpression';
import type { ImpressionSurface } from '../models/StoryImpression';

const impressionsCollection = database.get<StoryImpressionModel>('story_impressions');

export interface RecordImpressionInput {
  articleId: string;
  stableClusterId?: string | null;
  suggestionId?: string | null;
  /** Normalized title snapshot for the title-Jaccard dedup fallback. */
  titleNorm?: string | null;
  surface: ImpressionSurface;
}

async function upsertImpression(
  input: RecordImpressionInput,
  opened: boolean,
): Promise<void> {
  const articleId = (input.articleId ?? '').trim();
  if (!articleId) return;

  try {
    await database.write(async () => {
      // Query inside the write so check-then-mutate is atomic (WMDB
      // serializes writes — same pattern as setting-service).
      const existing = await impressionsCollection
        .query(Q.where('article_id', articleId))
        .fetch();
      const now = new Date();
      if (existing.length > 0) {
        await existing[0].update((r) => {
          r.lastSeenAt = now;
          r.seenCount = (r.seenCount ?? 0) + 1;
          if (opened) r.opened = true;
          // stable_cluster_id / title_norm are snapshotted at first impression;
          // backfill only if they were unknown then.
          if (r.stableClusterId == null && input.stableClusterId) {
            r.stableClusterId = input.stableClusterId;
          }
          if (r.titleNorm == null && input.titleNorm) {
            r.titleNorm = input.titleNorm;
          }
        });
      } else {
        await impressionsCollection.create((r) => {
          r.articleId = articleId;
          r.stableClusterId = input.stableClusterId ?? null;
          r.suggestionId = input.suggestionId ?? null;
          r.titleNorm = input.titleNorm ?? null;
          r.surface = input.surface;
          r.opened = opened;
          r.firstSeenAt = now;
          r.lastSeenAt = now;
          r.seenCount = 1;
        });
      }
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'story-impression', method: opened ? 'recordOpen' : 'recordImpression' },
    });
  }
}

/** Records a card-displayed impression (opened stays false if new). */
export async function recordImpression(input: RecordImpressionInput): Promise<void> {
  await upsertImpression(input, false);
}

/** Records an open/read — upgrades `opened` in place. */
export async function recordOpen(input: RecordImpressionInput): Promise<void> {
  await upsertImpression(input, true);
}

/** All impressions (dedup/seen-set builds). */
export async function getAll(): Promise<StoryImpressionModel[]> {
  return impressionsCollection.query().fetch();
}

/** Deletes impressions first seen before the cutoff. Returns deleted count. */
export async function deleteOlderThan(cutoffMs: number): Promise<number> {
  const old = await impressionsCollection
    .query(Q.where('first_seen_at', Q.lt(cutoffMs)))
    .fetch();
  if (old.length === 0) return 0;
  await database.write(async () => {
    await database.batch(old.map((r) => r.prepareDestroyPermanently()));
  });
  return old.length;
}
