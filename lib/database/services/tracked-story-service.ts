// Tracked-Story Service — WatermelonDB adapter for `tracked_stories` (schema
// v39). Long-lived, user-owned "follow this story" state. Pure CRUD: this wave
// owns creation/mutation only — the follow UI, reconcile poll, and headline
// enrichment call these from later waves. English-canonical (headline/title
// rendered downstream via TranslatableDynamic).

import { Q } from '@nozbe/watermelondb';
import { map } from 'rxjs';
import database from '../index';
import type TrackedStoryModel from '../models/TrackedStory';
import type { TrackedStoryMemberSnapshot } from '../models/TrackedStory';
import logger from '../../logger';

export type { TrackedStoryMemberSnapshot } from '../models/TrackedStory';

const collection = database.get<TrackedStoryModel>('tracked_stories');

/** Newest-first cap on a story's remembered member article ids. */
const MAX_MEMBER_IDS = 30;

/** Newest-first (by pubDate) cap on a story's remembered member snapshots. */
const MAX_MEMBER_SNAPSHOTS = 50;

/**
 * Merge new member snapshots into an existing set: new snapshots win on id
 * collision, the result is sorted strictly newest-first by `pubDateMs`, and
 * capped at {@link MAX_MEMBER_SNAPSHOTS}. Pure — shared by seed + applyUpdates.
 */
export function mergeMemberSnapshots(
  existing: TrackedStoryMemberSnapshot[],
  incoming: TrackedStoryMemberSnapshot[],
): TrackedStoryMemberSnapshot[] {
  const byId = new Map<string, TrackedStoryMemberSnapshot>();
  for (const s of existing) {
    if (s && typeof s.articleId === 'string' && s.articleId) byId.set(s.articleId, s);
  }
  // Incoming overwrites existing on the same article id (freshest fields win).
  for (const s of incoming) {
    if (s && typeof s.articleId === 'string' && s.articleId) byId.set(s.articleId, s);
  }
  return [...byId.values()]
    .sort((a, b) => (b.pubDateMs ?? 0) - (a.pubDateMs ?? 0))
    .slice(0, MAX_MEMBER_SNAPSHOTS);
}

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
  // ── Topic-linked tracking (v40) ──
  /** The minted `topics` row this story follows (topic-linked stories). */
  topicId?: string | null;
  /** The accepted proposal text (the topic's text). */
  topicText?: string | null;
  /** When set, the headline is written directly (topic-linked stories skip the
   *  separate story_headline job — the accepted proposal IS the headline). */
  llmHeadline?: string | null;
  /** Snapshot of the originating article, seeded into member_snapshots_json. */
  initialSnapshot?: TrackedStoryMemberSnapshot | null;
}

export interface ApplyUpdatesInput {
  newMemberIds: string[];
  latestArticleId?: string | null;
  latestTitle?: string | null;
  /** Lean card snapshots for the new members (merged newest-first, capped 50). */
  newSnapshots?: TrackedStoryMemberSnapshot[];
}

/** Lean projection for the reconcile poll (avoids passing live models around). */
export interface TrackedStoryReconcileRow {
  id: string;
  stableClusterId: string;
  memberArticleIds: string[];
  latestArticleId: string | null;
}

/** Lean projection for the topic-linked reconcile path (v40). */
export interface TrackedStoryTopicReconcileRow {
  id: string;
  topicId: string;
  memberArticleIds: string[];
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

  const topicId = input.topicId?.trim() || null;
  const topicText = input.topicText?.trim() || null;
  const llmHeadline = input.llmHeadline?.trim() || null;
  const initialSnapshot =
    input.initialSnapshot && input.initialSnapshot.articleId
      ? [input.initialSnapshot]
      : [];

  let created!: TrackedStoryModel;
  await database.write(async () => {
    created = await collection.create((m) => {
      m.stableClusterId = stableClusterId;
      m.memberArticleIds = articleId ? [articleId] : [];
      m.llmHeadline = llmHeadline;
      m.fallbackTitle = title;
      m.latestArticleId = articleId || null;
      m.latestTitle = title || null;
      m.originSurface = originSurface;
      m.lastUpdateAt = null;
      m.unseenCount = 0;
      m.lastCheckedAt = null;
      m.missCount = 0;
      m.status = 'active';
      m.topicId = topicId;
      m.topicText = topicText;
      m.memberSnapshots = initialSnapshot;
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
        if (updates.newSnapshots && updates.newSnapshots.length > 0) {
          m.memberSnapshots = mergeMemberSnapshots(
            m.memberSnapshots ?? [],
            updates.newSnapshots,
          );
        }
        if (updates.latestArticleId) m.latestArticleId = updates.latestArticleId;
        if (updates.latestTitle) m.latestTitle = updates.latestTitle;
      });
    });
  } catch (err) {
    logger.warn('[tracked-story] applyUpdates failed', { id, error: String(err) });
  }
}

/**
 * Seed a freshly-tracked story with the member articles discovered at track
 * time (from the server archive or the live cluster). UNLIKE {@link applyUpdates}
 * this does NOT bump `unseen_count` or stamp `last_update_at` — the user is
 * actively following the story right now, so its initial coverage is "seen".
 * Merges the seeds after any ids already present (the tapped article stays
 * first), de-dupes, and caps newest-first at 30. Optionally refreshes the
 * "latest" pointer. Never throws.
 */
export async function seedMembers(
  id: string,
  memberIds: string[],
  latest?: { latestArticleId?: string | null; latestTitle?: string | null },
): Promise<void> {
  const seeds = (memberIds ?? []).filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      await record.update((m) => {
        const existing = m.memberArticleIds ?? [];
        const merged: string[] = [];
        const seen = new Set<string>();
        for (const idv of [...existing, ...seeds]) {
          if (seen.has(idv)) continue;
          seen.add(idv);
          merged.push(idv);
        }
        m.memberArticleIds = merged.slice(0, MAX_MEMBER_IDS);
        if (latest?.latestArticleId) m.latestArticleId = latest.latestArticleId;
        if (latest?.latestTitle) m.latestTitle = latest.latestTitle;
      });
    });
  } catch (err) {
    logger.warn('[tracked-story] seedMembers failed', { id, error: String(err) });
  }
}

/**
 * Resolve the row id of the ACTIVE story matching a subject (by stable cluster
 * id or member article id) — the seam the follow UI uses to untrack from a card
 * subject. Returns null when nothing matches. Mirrors {@link isTracked}'s match
 * rules. Never throws.
 */
export async function findActiveTrackedId(query: {
  stableClusterId?: string | null;
  articleId?: string | null;
}): Promise<string | null> {
  const stableClusterId = query.stableClusterId?.trim() || null;
  const articleId = query.articleId?.trim() || null;
  if (!stableClusterId && !articleId) return null;
  try {
    const rows = await collection.query(Q.where('status', 'active')).fetch();
    const match = rows.find((r) => {
      if (r.status !== 'active') return false; // JS guard (test mock ignores predicate)
      if (stableClusterId && r.stableClusterId === stableClusterId) return true;
      if (articleId && (r.memberArticleIds ?? []).includes(articleId)) return true;
      return false;
    });
    return match?.id ?? null;
  } catch (err) {
    logger.warn('[tracked-story] findActiveTrackedId failed', { error: String(err) });
    return null;
  }
}

/** One-shot read of a single story row by id (any status). Null when missing. */
export async function getTrackedStoryById(id: string): Promise<TrackedStoryModel | null> {
  try {
    return await collection.find(id);
  } catch {
    return null;
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
    // Legacy (cluster-id) path only: topic-linked stories (v40) reconcile via
    // `getActiveForTopicReconcile` instead — excluded here so they aren't
    // double-processed / double-notified.
    .filter((r) => r.status === 'active' && !!r.stableClusterId && !r.topicId)
    .map((r) => ({
      id: r.id,
      stableClusterId: r.stableClusterId as string,
      memberArticleIds: r.memberArticleIds ?? [],
      latestArticleId: r.latestArticleId ?? null,
    }));
}

/**
 * Active TOPIC-linked stories (v40) — the topic reconcile path's work list.
 * A story is topic-linked once it carries a `topic_id`; the reconcile matches
 * fresh suggestions whose `matched_topics` contain that id. Returns a lean
 * projection so the reconcile never holds live models.
 */
export async function getActiveForTopicReconcile(): Promise<TrackedStoryTopicReconcileRow[]> {
  const rows = await collection.query(Q.where('status', 'active')).fetch();
  return rows
    .filter((r) => r.status === 'active' && !!r.topicId) // JS guard for test mock
    .map((r) => ({
      id: r.id,
      topicId: r.topicId as string,
      memberArticleIds: r.memberArticleIds ?? [],
    }));
}

/** Lean projection for the 30-min tracked-stories-poll-task. Unlike
 *  `getActiveForReconcile`, includes stories with no resolved stable id yet
 *  (singletons) — the poll task promotes those via `getNewsClusterForArticle`
 *  + `resolveStableId`. */
export interface TrackedStoryPollRow {
  id: string;
  stableClusterId: string | null;
  memberArticleIds: string[];
  latestArticleId: string | null;
}

// --- Coordination note (feed-sync/reconcile wave, 2026-07-20) ---
// `getActiveForPoll` and `stampChecked` below are additive: a lean read
// projection + a single-field setter, following the exact shape of the
// existing `getActiveForReconcile` / `recordMiss` functions above. Added so
// `lib/scheduler/tasks/tracked-stories-poll-task.ts` can select due stories
// and stamp `last_checked_at` without reaching into the WatermelonDB
// collection directly (this service owns that collection). No existing
// exports were changed.

/**
 * Active stories due for a poll check: `last_checked_at` is null (never
 * checked) or older than `staleBeforeMs`, oldest-checked-first, capped at
 * `limit`. Never throws (falls back to an empty list).
 */
export async function getActiveForPoll(
  staleBeforeMs: number,
  limit: number,
): Promise<TrackedStoryPollRow[]> {
  try {
    const rows = await collection.query(Q.where('status', 'active')).fetch();
    const time = (r: TrackedStoryModel): number =>
      r.lastCheckedAt instanceof Date ? r.lastCheckedAt.getTime() : 0;
    return rows
      .filter((r) => r.status === 'active') // JS guard for test mock
      .filter((r) => time(r) < staleBeforeMs) // never-checked (time=0) always qualifies
      .sort((a, b) => time(a) - time(b)) // oldest/never-checked first
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        stableClusterId: r.stableClusterId ?? null,
        memberArticleIds: r.memberArticleIds ?? [],
        latestArticleId: r.latestArticleId ?? null,
      }));
  } catch (err) {
    logger.warn('[tracked-story] getActiveForPoll failed', { error: String(err) });
    return [];
  }
}

/** Stamp a story as just-checked (poll ran, whatever the outcome). Never throws. */
export async function stampChecked(id: string): Promise<void> {
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      await record.update((m) => {
        m.lastCheckedAt = new Date();
      });
    });
  } catch (err) {
    logger.warn('[tracked-story] stampChecked failed', { id, error: String(err) });
  }
}
