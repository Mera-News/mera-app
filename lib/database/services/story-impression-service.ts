// Story-Impression Service — WatermelonDB adapter for persona-v3
// `story_impressions` seen-state. Presentation/dedup ONLY: impressions never
// mutate topics/facts/locations. One row per article_id, upserted;
// `opened` upgrades in place and never downgrades. TTL 30d via
// `deleteOlderThan` (data-cleanup-task).
//
// OPENS-ONLY (r6 P2 — read = tapped): only `recordOpen` writes rows now (each
// with opened=true); there is no view/impression write path. The seen readers
// are opens-only by construction — `getOpenedSeenSet` (Dashboard read-ticks +
// P_SEEN scoring) and `getOpenedTitleNorms` (title-Jaccard dedup fallback).
// The old view-inclusive `getSeenSet` / `recordImpression` (which fed the Feed
// tab's viewed-elimination) were removed with that machinery; any legacy
// opened=false rows still on-device are inert and TTL out within 30d.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import logger from '../../logger';
import type StoryImpressionModel from '../models/StoryImpression';
import type { ImpressionSurface } from '../models/StoryImpression';

const impressionsCollection = database.get<StoryImpressionModel>('story_impressions');

const DAY_MS = 24 * 60 * 60 * 1000;

/** `@date` columns surface as `Date`, but the test mock hands back raw numbers
 *  (and a partially-written row can be null). Normalize to epoch ms or null. */
function toMs(v: Date | number | null | undefined): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Number(v);
  return Number.isFinite(t) ? t : null;
}

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

/** Records an open/read — upgrades `opened` in place. */
export async function recordOpen(input: RecordImpressionInput): Promise<void> {
  await upsertImpression(input, true);
}

/** All impressions (dedup/seen-set builds). */
export async function getAll(): Promise<StoryImpressionModel[]> {
  return impressionsCollection.query().fetch();
}

/**
 * OPENS-ONLY seen set (USER DECISION, master plan §41c + addendum A2.3): a story
 * counts as "seen" ONLY when it was explicitly OPENED/read (`opened=true`), NEVER
 * on a mere impression. This one set feeds BOTH:
 *   (a) swipe-deck exclusion — the deck drops any suggestion whose article_id OR
 *       stable_cluster_id is in here (the deck never drains from scrolling); and
 *   (b) the P_SEEN demotion — passed to `PersonaScoringContext.seenStoryIds`.
 * Both surfaces are opens-only by construction: there is no impression-keyed
 * path, so tab-1 scrolling can only demote (via P_SEEN if the article is later
 * opened) — it can never exclude a story from the deck.
 *
 * OPENS-ONLY consumers: Dashboard read-ticks + P_SEEN scoring. (The Feed tab no
 * longer excludes on views — read = tapped only, r6 P2 — so there is no
 * view-inclusive seen set anymore.)
 *
 * Returns article_ids ∪ non-null stable_cluster_ids of opened rows. The
 * `Q.where('opened', true)` is the production filter; the JS `r.opened === true`
 * guard keeps the set opens-only even under the predicate-ignoring test mock.
 */
export async function getOpenedSeenSet(): Promise<Set<string>> {
  const { articleIds, clusterIds } = await getOpenedSeenBreakdown();
  return new Set([...articleIds, ...clusterIds]);
}

/** Age buckets on `first_seen_at`, exclusive — they partition `rowCount`. */
export interface OpenedSeenAgeBuckets {
  le24h: number;
  d1to7: number;
  d7to30: number;
}

export interface OpenedSeenStats {
  rowCount: number;
  articleIdCount: number;
  clusterIdCount: number;
  /** Size of `articleIds ∪ clusterIds` — what `getOpenedSeenSet` returns. */
  unionSize: number;
  oldestFirstSeenAtMs: number | null;
  newestLastSeenAtMs: number | null;
  ageBuckets: OpenedSeenAgeBuckets;
}

export interface OpenedSeenBreakdown {
  articleIds: Set<string>;
  clusterIds: Set<string>;
  stats: OpenedSeenStats;
}

/**
 * The opened set, split by AXIS. `getOpenedSeenSet` merges the two, and once
 * merged they are indistinguishable — but the two behave very differently:
 * an article id identifies one story the user read, whereas a `stableClusterId`
 * identifies an ONGOING story and keeps matching brand-new articles in it for
 * the full 30-day impression TTL.
 *
 * The Feed's ingest gate deliberately uses `articleIds` only; the union still
 * feeds the Dashboard's read-ticks and the P_SEEN scoring demotion. The funnel
 * diagnostic uses the split + age buckets to show how much the cluster axis
 * would suppress.
 *
 * `getOpenedSeenSet` is a thin wrapper over this so the union can never drift
 * from the breakdown.
 */
export async function getOpenedSeenBreakdown(
  nowMs: number = Date.now(),
): Promise<OpenedSeenBreakdown> {
  const rows = await impressionsCollection
    .query(Q.where('opened', true))
    .fetch();

  const articleIds = new Set<string>();
  const clusterIds = new Set<string>();
  const ageBuckets: OpenedSeenAgeBuckets = { le24h: 0, d1to7: 0, d7to30: 0 };
  let rowCount = 0;
  let oldestFirstSeenAtMs: number | null = null;
  let newestLastSeenAtMs: number | null = null;

  for (const r of rows) {
    // The JS guard keeps the set opens-only even under the predicate-ignoring
    // test mock. It must live HERE, in the shared builder, and nowhere else.
    if (r.opened !== true) continue;
    rowCount++;
    if (r.articleId) articleIds.add(r.articleId);
    if (r.stableClusterId) clusterIds.add(r.stableClusterId);

    const first = toMs(r.firstSeenAt);
    if (first !== null) {
      oldestFirstSeenAtMs =
        oldestFirstSeenAtMs === null ? first : Math.min(oldestFirstSeenAtMs, first);
      const ageMs = nowMs - first;
      if (ageMs <= DAY_MS) ageBuckets.le24h++;
      else if (ageMs <= 7 * DAY_MS) ageBuckets.d1to7++;
      else ageBuckets.d7to30++;
    }
    const last = toMs(r.lastSeenAt);
    if (last !== null) {
      newestLastSeenAtMs =
        newestLastSeenAtMs === null ? last : Math.max(newestLastSeenAtMs, last);
    }
  }

  return {
    articleIds,
    clusterIds,
    stats: {
      rowCount,
      articleIdCount: articleIds.size,
      clusterIdCount: clusterIds.size,
      unionSize: new Set([...articleIds, ...clusterIds]).size,
      oldestFirstSeenAtMs,
      newestLastSeenAtMs,
      ageBuckets,
    },
  };
}

/**
 * Snapshotted normalized titles of OPENED rows only — the title-Jaccard dedup
 * fallback (addendum A2.2) for when a fresh suggestion has neither a matching
 * article_id nor a stable_cluster_id in `getOpenedSeenSet()`. The store compares
 * a candidate's normalized title against these via `titleJaccard ≥
 * TITLE_JACCARD_PROPAGATION_THRESHOLD` (0.55); fail-open (no match ⇒ not seen).
 * Opens-only for parity with `getOpenedSeenSet`.
 */
export async function getOpenedTitleNorms(): Promise<string[]> {
  const rows = await impressionsCollection
    .query(Q.where('opened', true))
    .fetch();
  const out: string[] = [];
  for (const r of rows) {
    if (r.opened !== true) continue;
    const t = (r.titleNorm ?? '').trim();
    if (t) out.push(t);
  }
  return out;
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
