// Pure tracked-story timeline builder — no React/RN dependencies so it can be
// unit-tested in isolation (extracted from StoryTimelineScreen).
//
// A tracked story's timeline is now assembled entirely from its LOCAL member
// snapshots (seeded at track time + grown by the topic reconcile each fetch
// cycle). There is no server-side archive anymore — a followed story is just a
// tracked topic. This module normalizes the local snapshots into a single
// TimelineCard shape, dedupes by articleId, and orders strictly newest-first.

import type { TrackedStoryMemberSnapshot } from '@/lib/database/models/TrackedStory';

/** The card shape the local member snapshots are normalized into before
 *  rendering. `pubDateMs` drives the strict newest-first ordering. */
export interface TimelineCard {
  articleId: string;
  title: string;
  pubDateMs: number;
  imageUrl?: string;
  publicationName?: string;
  countryCode?: string;
  articleUrl?: string;
}

export function localToCard(snap: TrackedStoryMemberSnapshot): TimelineCard {
  return {
    articleId: snap.articleId,
    title: snap.title ?? '',
    pubDateMs: snap.pubDateMs ?? 0,
    imageUrl: snap.imageUrl,
    publicationName: snap.publicationName,
  };
}

/**
 * Build the timeline cards from a story's local member snapshots: dedupe by
 * articleId (freshest snapshot wins — reconcile snapshots carry the richer
 * fields) and sort strictly newest-first by pubDate.
 */
export function buildTimeline(local: TrackedStoryMemberSnapshot[]): TimelineCard[] {
  const byId = new Map<string, TimelineCard>();
  for (const l of local) {
    if (!l.articleId) continue;
    byId.set(l.articleId, localToCard(l));
  }
  return [...byId.values()].sort((a, b) => b.pubDateMs - a.pubDateMs);
}
