// Tracked-Story Service — WatermelonDB adapter for `tracked_stories` (schema
// v39). Long-lived, user-owned "follow this story" state. Pure CRUD: this wave
// owns creation/mutation only — the follow UI, reconcile poll, and headline
// enrichment call these from later waves. English-canonical (headline/title
// rendered downstream via TranslatableDynamic).

import { Q } from '@nozbe/watermelondb';
import { map } from 'rxjs';
import database from '../index';
import type TrackedStoryModel from '../models/TrackedStory';
import logger from '../../logger';

const collection = database.get<TrackedStoryModel>('tracked_stories');

/** Newest-first cap on a story's remembered member article ids. */
const MAX_MEMBER_IDS = 30;

/**
 * Consecutive reconcile misses before a story auto-ends. The reconcile poll
 * runs at least twice a day, so 14 misses ≈ 7 days of no new members — after
 * which we stop tracking (the user can always re-follow).
 */
export const MISSES_TO_END = 14;

export interface TrackStoryInput {
  stableClusterId?: string | null;
  articleId: string;
  title: string;
  originSurface: string;
}

export interface ApplyUpdatesInput {
  newMemberIds: string[];
  latestArticleId?: string | null;
  latestTitle?: string | null;
}

/** Lean projection for the reconcile poll (avoids passing live models around). */
export interface TrackedStoryReconcileRow {
  id: string;
  stableClusterId: string;
  memberArticleIds: string[];
  latestArticleId: string | null;
}

/**
 * Sort active stories for display: those with unseen updates first, then
 * newest activity first. WatermelonDB can't express this compound order in a
 * query, so callers observe the raw active set and run it through here.
 */
export function sortTrackedStories(rows: TrackedStoryModel[]): TrackedStoryModel[] {
  const time = (r: TrackedStoryModel): number => {
    const t = r.lastUpdateAt ?? r.createdAt;
    return t instanceof Date ? t.getTime() : Number(t ?? 0);
  };
  return [...rows].sort((a, b) => {
    const aUnseen = (a.unseenCount ?? 0) > 0 ? 1 : 0;
    const bUnseen = (b.unseenCount ?? 0) > 0 ? 1 : 0;
    if (aUnseen !== bUnseen) return bUnseen - aUnseen; // unseen first
    return time(b) - time(a); // newest activity first
  });
}

/**
 * Follow a story. Pure create — enrichment (headline, extra members) happens
 * later via the reconcile poll + headline job. `member_article_ids` seeds with
 * the tapped article; `fallback_title` always renders until a headline exists.
 */
export async function trackStory(input: TrackStoryInput): Promise<TrackedStoryModel> {
  const articleId = (input.articleId ?? '').trim();
  const title = (input.title ?? '').trim();
  const stableClusterId = input.stableClusterId?.trim() || null;
  const originSurface = input.originSurface?.trim() || null;

  let created!: TrackedStoryModel;
  await database.write(async () => {
    created = await collection.create((m) => {
      m.stableClusterId = stableClusterId;
      m.memberArticleIds = articleId ? [articleId] : [];
      m.llmHeadline = null;
      m.fallbackTitle = title;
      m.latestArticleId = articleId || null;
      m.latestTitle = title || null;
      m.originSurface = originSurface;
      m.lastUpdateAt = null;
      m.unseenCount = 0;
      m.lastCheckedAt = null;
      m.missCount = 0;
      m.status = 'active';
    });
  });
  return created;
}

/** Unfollow a story (hard delete). Never throws. */
export async function untrackStory(id: string): Promise<void> {
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      await record.destroyPermanently();
    });
  } catch (err) {
    logger.warn('[tracked-story] untrackStory failed', { id, error: String(err) });
  }
}

/**
 * Is a story already followed? Matches on either the resolved stable cluster id
 * or membership of the given article id. At least one key must be supplied.
 * Only ACTIVE stories count (an ended story is not "tracked").
 */
export async function isTracked(query: {
  stableClusterId?: string | null;
  articleId?: string | null;
}): Promise<boolean> {
  const stableClusterId = query.stableClusterId?.trim() || null;
  const articleId = query.articleId?.trim() || null;
  if (!stableClusterId && !articleId) return false;

  const rows = await collection.query(Q.where('status', 'active')).fetch();
  return rows.some((r) => {
    if (r.status !== 'active') return false; // JS guard (test mock ignores predicate)
    if (stableClusterId && r.stableClusterId === stableClusterId) return true;
    if (articleId && (r.memberArticleIds ?? []).includes(articleId)) return true;
    return false;
  });
}

/**
 * Reactive active-story set. Re-emits when the columns that affect ordering /
 * the badge change. Sorted via `sortTrackedStories` (unseen first, newest next).
 */
export function observeActive() {
  return collection
    .query(Q.where('status', 'active'))
    .observeWithColumns(['unseen_count', 'last_update_at', 'llm_headline'])
    .pipe(map((rows) => sortTrackedStories(rows)));
}

/** Reactive total unseen count across active stories — drives the tab badge. */
export function observeUnseenTotal() {
  return collection
    .query(Q.where('status', 'active'))
    .observeWithColumns(['unseen_count'])
    .pipe(
      map((rows) =>
        rows
          .filter((r) => r.status === 'active')
          .reduce((sum, r) => sum + (r.unseenCount ?? 0), 0),
      ),
    );
}

/** Clear a story's unseen badge (user viewed its updates). Never throws. */
export async function markSeen(id: string): Promise<void> {
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      await record.update((m) => {
        m.unseenCount = 0;
      });
    });
  } catch (err) {
    logger.warn('[tracked-story] markSeen failed', { id, error: String(err) });
  }
}

/**
 * Grow a story with newly-found member articles: prepend the new ids
 * (newest-first, capped at 30), bump `unseen_count` by the number added, stamp
 * `last_update_at`, and reset the miss streak. Optionally refresh the "latest"
 * pointer. Never throws.
 */
export async function applyUpdates(id: string, updates: ApplyUpdatesInput): Promise<void> {
  const newIds = (updates.newMemberIds ?? []).filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      await record.update((m) => {
        const existing = m.memberArticleIds ?? [];
        m.memberArticleIds = [...newIds, ...existing].slice(0, MAX_MEMBER_IDS);
        m.unseenCount = (m.unseenCount ?? 0) + newIds.length;
        m.lastUpdateAt = new Date();
        m.missCount = 0;
        if (updates.latestArticleId) m.latestArticleId = updates.latestArticleId;
        if (updates.latestTitle) m.latestTitle = updates.latestTitle;
      });
    });
  } catch (err) {
    logger.warn('[tracked-story] applyUpdates failed', { id, error: String(err) });
  }
}

/** Bind a resolved server stable_cluster_id to a story. Never throws. */
export async function resolveStableId(id: string, stableClusterId: string): Promise<void> {
  const sid = (stableClusterId ?? '').trim();
  if (!sid) return;
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      await record.update((m) => {
        m.stableClusterId = sid;
      });
    });
  } catch (err) {
    logger.warn('[tracked-story] resolveStableId failed', { id, error: String(err) });
  }
}

/** Write the generated English headline for a story. No-op on blank. Never throws. */
export async function setLlmHeadline(id: string, headline: string): Promise<void> {
  const h = (headline ?? '').trim();
  if (!h) return;
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      await record.update((m) => {
        m.llmHeadline = h;
      });
    });
  } catch (err) {
    logger.warn('[tracked-story] setLlmHeadline failed', { id, error: String(err) });
  }
}

/**
 * Record a reconcile miss (poll found no new members). Increments the streak,
 * stamps `last_checked_at`, and auto-ends the story once the streak hits
 * `MISSES_TO_END`. Never throws.
 */
export async function recordMiss(id: string): Promise<void> {
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      await record.update((m) => {
        const next = (m.missCount ?? 0) + 1;
        m.missCount = next;
        m.lastCheckedAt = new Date();
        if (next >= MISSES_TO_END) m.status = 'ended';
      });
    });
  } catch (err) {
    logger.warn('[tracked-story] recordMiss failed', { id, error: String(err) });
  }
}

/**
 * Active stories that have a resolved stable id — the reconcile poll's work
 * list. Returns a lean projection so the poll never holds live models.
 */
export async function getActiveForReconcile(): Promise<TrackedStoryReconcileRow[]> {
  const rows = await collection
    .query(Q.where('status', 'active'), Q.where('stable_cluster_id', Q.notEq(null)))
    .fetch();
  return rows
    .filter((r) => r.status === 'active' && !!r.stableClusterId) // JS guard for test mock
    .map((r) => ({
      id: r.id,
      stableClusterId: r.stableClusterId as string,
      memberArticleIds: r.memberArticleIds ?? [],
      latestArticleId: r.latestArticleId ?? null,
    }));
}
