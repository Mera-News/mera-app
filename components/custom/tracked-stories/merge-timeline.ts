// Pure tracked-story timeline builder — no React/RN dependencies so it can be
// unit-tested in isolation (extracted from StoryTimelineScreen).
//
// A tracked story's timeline is now assembled entirely from its LOCAL member
// snapshots (seeded at track time + grown by the topic reconcile each fetch
// cycle). There is no server-side archive anymore — a followed story is just a
// tracked topic. This module normalizes the local snapshots into a single
// TimelineCard shape, dedupes by articleId, and orders strictly newest-first.

import type { TrackedStoryMemberSnapshot } from '@/lib/database/models/TrackedStory';
import type { NewsArticle } from '@/lib/generated/graphql-types';

/** The card shape the local member snapshots are normalized into before
 *  rendering. `pubDateMs` drives the strict newest-first ordering. */
export interface TimelineCard {
  articleId: string;
  /** English. */
  title: string;
  /** The title in the article's own language, when the snapshot has it. */
  titleOriginal?: string;
  pubDateMs: number;
  imageUrl?: string;
  publicationName?: string;
  languageCode?: string;
  countryCode?: string;
  articleUrl?: string;
}

export function localToCard(snap: TrackedStoryMemberSnapshot): TimelineCard {
  return {
    articleId: snap.articleId,
    title: snap.title ?? '',
    titleOriginal: snap.titleOriginal,
    pubDateMs: snap.pubDateMs ?? 0,
    imageUrl: snap.imageUrl,
    publicationName: snap.publicationName,
    languageCode: snap.languageCode,
    countryCode: snap.countryCode,
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

/**
 * A timeline card as the NewsArticle the compact card renders. `title` is the
 * ORIGINAL-language title and is left undefined when the snapshot has none:
 * the card passes it to TranslatableDynamic as `originalText` beside
 * `original_language_code`, and English there (with a `ja` code, say) reads as
 * "already in a Japanese reader's language", so the English is never
 * translated. Cards are lean, so fields they lack stay undefined.
 */
export function timelineCardToArticle(card: TimelineCard): NewsArticle {
  return {
    _id: card.articleId,
    title: card.titleOriginal || undefined,
    title_en_internal_only: card.title,
    pubDate: card.pubDateMs ? new Date(card.pubDateMs).toISOString() : undefined,
    image_url: card.imageUrl,
    article_url: card.articleUrl,
    original_language_code: card.languageCode,
    publicationSource:
      card.publicationName || card.countryCode
        ? ({
            _id: card.articleId,
            publication_name: card.publicationName,
            country_code: card.countryCode,
          } as NewsArticle['publicationSource'])
        : undefined,
  } as NewsArticle;
}
