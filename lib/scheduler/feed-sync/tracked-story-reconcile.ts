// Tracked-Story Reconcile — piggybacks on every feed sync to grow followed
// stories, with zero extra network calls.
//
// A followed story is a user-owned TOPIC, linked server-side every cycle by the
// persona query. We match local suggestions whose stored `matched_topics`, OR
// this sync's server answer, carry the story's `topic_id` (a row persisted
// before the topic existed only ever appears in the latter), grow the story, and remember a lean card
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
import { retainStoryMember } from '@/lib/tracking/track-actions';
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
    // The real original, never the English (see TrackedStoryMemberSnapshot).
    titleOriginal: row.titleOriginal || undefined,
    pubDateMs: pubDateMs(row),
    imageUrl: row.imageUrl ?? undefined,
    publicationName: row.publicationName ?? undefined,
    languageCode: row.languageCode ?? undefined,
    countryCode: row.countryCode ?? undefined,
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

/** This sync's server answer: article id → the topics it matched. */
export type ServerTopicMatches = ReadonlyMap<string, readonly { topicId: string | null }[]>;

/**
 * TOPIC pass — grow every active topic-linked story from suggestions whose
 * matched topics carry its topic id. Appends member ids AND snapshots, and
 * stamps every examined story checked. Sends no notification.
 * Never ends a story (the topic keeps linking server-side).
 */
async function reconcileByTopic(serverMatches?: ServerTopicMatches): Promise<void> {
  const stories = await getActiveForTopicReconcile();
  if (stories.length === 0) return;

  const suggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
  const serverIds = serverMatches ? [...serverMatches.keys()] : [];
  const rows = await suggestionsCol
    .query(
      serverIds.length > 0
        ? Q.or(
            Q.where('matched_topics_json', Q.notEq(null)),
            Q.where('id', Q.oneOf(serverIds)),
          )
        : Q.where('matched_topics_json', Q.notEq(null)),
    )
    .fetch();

  // Invert: topicId → suggestion rows that matched it, from the row's stored
  // matches AND this sync's server answer. A row persisted before the topic
  // existed (the coverage a story was just followed from) never gets the new
  // topic id stored, so only the server answer can place it.
  const rowsByTopicId = new Map<string, ArticleSuggestionModel[]>();
  for (const row of rows) {
    const topicIds = new Set(matchedTopicIds(row.matchedTopicsJson));
    for (const m of serverMatches?.get(row.id) ?? []) if (m.topicId) topicIds.add(m.topicId);
    for (const topicId of topicIds) {
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
      logger.info('[tracked-story-reconcile] story matched', {
        id: story.id,
        matched: candidates.length,
        fresh: fresh.length,
      });

      if (fresh.length > 0) {
        await applyUpdates(story.id, {
          newMemberIds: fresh.map((r) => r.id),
          newSnapshots: fresh.map(snapshotFromSuggestion),
        });
        // Retain each new member on device, the way a save does. This is the
        // moment the full row is in hand: `article_suggestions` is pruned at
        // 48h and the server drops the article at 48h too, so a member not
        // retained now becomes unopenable the day after tomorrow — on a story
        // the reader explicitly asked to follow.
        // Bounded per story per cycle, and already off the UI path.
        for (const row of fresh) {
          await retainStoryMember(row.id, {
            title: row.titleEn,
            publicationName: row.publicationName,
          });
        }
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
export async function reconcileTrackedStories(serverMatches?: ServerTopicMatches): Promise<void> {
  await reconcileByTopic(serverMatches);
}
