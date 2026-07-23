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

/** Lean projection for the topic-linked reconcile path (v40). */
export interface TrackedStoryTopicReconcileRow {
  id: string;
  topicId: string;
  memberArticleIds: string[];
}

/** Lean projection of a legacy (topic-less) active story awaiting migration to
 *  the topic model. `titles` are the known member titles fed to the LLM scope
 *  generator that mints the tracked topic + display headline. */
export interface LegacyTrackedStoryRow {
  id: string;
  titles: string[];
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
 * (newest-first, capped at 30), bump `unseen_count`, stamp `last_update_at`,
 * and reset the miss streak. Optionally refresh the "latest" pointer. Never
 * throws.
 *
 * The `unseen_count` bump is WATERMARK-GATED (schema v44): when the caller
 * passes `newSnapshots` (so we know each new member's pubDate) AND the story
 * has a `seen_pub_watermark_ms` set (the user has opened the timeline at least
 * once), only members published strictly AFTER that watermark count as "new" —
 * so backfilled OLD articles the pipeline just discovered don't inflate the
 * badge. A snapshot with pubDateMs 0/undefined counts as OLD (deliberate
 * backfill safety). Otherwise (no snapshots — the legacy cluster/poll path — or
 * a null watermark) we fall back to the legacy `+= newIds.length`.
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

        const snapshots = updates.newSnapshots;
        const watermark = m.seenPubWatermarkMs;
        if (snapshots && snapshots.length > 0 && watermark != null) {
          // Watermark-gated: only members newer than the last-seen watermark.
          m.unseenCount =
            (m.unseenCount ?? 0) +
            snapshots.filter((s) => (s.pubDateMs ?? 0) > watermark).length;
        } else {
          // Legacy path — no per-member pubDate, or never opened yet.
          m.unseenCount = (m.unseenCount ?? 0) + newIds.length;
        }

        m.lastUpdateAt = new Date();
        m.missCount = 0;
        if (snapshots && snapshots.length > 0) {
          m.memberSnapshots = mergeMemberSnapshots(m.memberSnapshots ?? [], snapshots);
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
 * Advance a story's seen-pubDate watermark (schema v44) — the newest member
 * pubDate the user has actually seen. Called by the timeline screen after a
 * SUCCESSFUL load with the max pubDate on screen. Monotonic: never moves the
 * watermark backwards (`Math.max(current ?? 0, watermarkMs)`), so a later load
 * that happens to render an older subset can't re-inflate future badges. Swallows
 * errors (never throws — a failed watermark write must not break the screen).
 */
export async function advanceSeenWatermark(id: string, watermarkMs: number): Promise<void> {
  if (!Number.isFinite(watermarkMs) || watermarkMs <= 0) return;
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      await record.update((m) => {
        m.seenPubWatermarkMs = Math.max(m.seenPubWatermarkMs ?? 0, watermarkMs);
      });
    });
  } catch (err) {
    logger.warn('[tracked-story] advanceSeenWatermark failed', { id, error: String(err) });
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

/**
 * Active stories still on the legacy stable-cluster model (no `topic_id`) — the
 * one-shot migration work list. Each carries the story's known `titles` (its
 * display headline, fallback title, and member-snapshot titles, de-duplicated)
 * that the LLM scope generator turns into a tracked topic + display headline.
 * Rows with no usable titles are dropped (nothing to scope on). Never throws.
 */
export async function getLegacyTrackedForMigration(): Promise<LegacyTrackedStoryRow[]> {
  try {
    const rows = await collection.query(Q.where('status', 'active')).fetch();
    return rows
      .filter((r) => r.status === 'active' && !r.topicId) // JS guard for test mock
      .map((r) => {
        const seen = new Set<string>();
        const titles: string[] = [];
        for (const raw of [
          r.llmHeadline,
          r.fallbackTitle,
          ...(r.memberSnapshots ?? []).map((s) => s.title),
        ]) {
          const t = (raw ?? '').trim();
          if (t && !seen.has(t)) {
            seen.add(t);
            titles.push(t);
          }
        }
        return { id: r.id, titles };
      })
      .filter((r) => r.titles.length > 0);
  } catch (err) {
    logger.warn('[tracked-story] getLegacyTrackedForMigration failed', {
      error: String(err),
    });
    return [];
  }
}

/**
 * Bind a minted topic (id + text) onto a story — the migration setter that
 * converts a legacy stable-cluster follow into a topic-linked one. No-op on
 * blank text. Never throws.
 */
export async function bindTrackedTopic(
  id: string,
  topicId: string | null,
  topicText: string,
): Promise<void> {
  const text = (topicText ?? '').trim();
  if (!text) return;
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      await record.update((m) => {
        m.topicId = topicId;
        m.topicText = text;
      });
    });
  } catch (err) {
    logger.warn('[tracked-story] bindTrackedTopic failed', { id, error: String(err) });
  }
}

/** Stamp a story as just-checked by the reconcile. Never throws. */
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
