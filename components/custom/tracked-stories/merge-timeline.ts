// Pure tracked-story timeline merge — no React/RN dependencies so it can be
// unit-tested in isolation (extracted from StoryTimelineScreen for Part E).
//
// A tracked story's timeline is assembled from two sources: the local member
// snapshots (seeded at track time + reconcile-discovered) and the server archive
// snapshots (the durable coverage under the stable cluster id). This module
// normalizes both into a single TimelineCard shape, dedupes by articleId, and
// orders strictly newest-first by pubDate.

import type { TrackedStoryMemberSnapshot } from '@/lib/database/models/TrackedStory';
import type { TrackedStoryArticleSnapshot } from '@/lib/generated/graphql-types';

/** The card shape both the local member snapshots and the server archive
 *  snapshots are normalized into before rendering. `pubDateMs` drives the strict
 *  newest-first ordering that applies regardless of source. */
export interface TimelineCard {
  articleId: string;
  title: string;
  pubDateMs: number;
  imageUrl?: string;
  publicationName?: string;
  countryCode?: string;
  articleUrl?: string;
}

export function serverToCard(snap: TrackedStoryArticleSnapshot): TimelineCard {
  return {
    articleId: snap.articleId,
    title: snap.title_en ?? '',
    pubDateMs: snap.pubDate ? Date.parse(snap.pubDate) || 0 : 0,
    imageUrl: snap.image_url ?? undefined,
    publicationName: snap.publication_name ?? undefined,
    countryCode: snap.country_code ?? undefined,
    articleUrl: snap.article_url ?? undefined,
  };
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
 * Merge the local member snapshots with the server archive snapshots, deduped
 * by articleId, then sorted strictly newest-first by pubDate.
 *
 * Field precedence is source-specific:
 *  - **pubDate**: the SERVER archive is authoritative (`base?.pubDateMs ||
 *    localCard.pubDateMs`). The local seed historically stamped `Date.now()` at
 *    track time, which made cards sort by the track moment rather than the real
 *    publication time; trusting the server archive first fixes those rows even
 *    without a re-seed (Part E). The local snapshot's (now real) pubDate is the
 *    fallback when the server has none.
 *  - **title / media**: the local snapshot wins (it carries reconcile-discovered
 *    fields), falling back to the server snapshot so a card never renders blank
 *    when either source has the value.
 */
export function mergeTimeline(
  local: TrackedStoryMemberSnapshot[],
  server: TrackedStoryArticleSnapshot[],
): TimelineCard[] {
  const byId = new Map<string, TimelineCard>();
  for (const s of server) {
    if (s.articleId) byId.set(s.articleId, serverToCard(s));
  }
  for (const l of local) {
    if (!l.articleId) continue;
    const base = byId.get(l.articleId);
    const localCard = localToCard(l);
    byId.set(l.articleId, {
      ...base,
      ...localCard,
      // Title / media fall back to the server snapshot when the local one is
      // missing them.
      title: localCard.title || base?.title || '',
      imageUrl: localCard.imageUrl ?? base?.imageUrl,
      publicationName: localCard.publicationName ?? base?.publicationName,
      countryCode: base?.countryCode,
      articleUrl: base?.articleUrl,
      // pubDate: server archive is authoritative; local is the fallback.
      pubDateMs: base?.pubDateMs || localCard.pubDateMs || 0,
    });
  }
  return [...byId.values()].sort((a, b) => b.pubDateMs - a.pubDateMs);
}
