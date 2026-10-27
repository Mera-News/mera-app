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
import type { UserGeoLanguageContext } from '@/lib/algorithms/geo-language-priority';
import { makeRepCompare } from '@/lib/algorithms/representative-compare';
import { foldKeysOf } from '@/lib/tracking/story-fold-key';

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
  /** The server's story key, when the snapshot carries one. */
  storyKey?: string;
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
    storyKey: snap.storyKey,
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

/** One story on the timeline: the copy shown and the other copies of it. */
export interface TimelineEntry {
  head: TimelineCard;
  copies: TimelineCard[];
}

/**
 * Fold the per-article cards into one entry per story (display only: the
 * ledger and snapshots stay per article). Cards sharing any fold key are one
 * story, EXCEPT that a title key never joins two groups that already carry
 * different storyKeys: the server decided those are two stories. The head is
 * the copy `makeRepCompare` elects for this reader; entries sort newest head
 * first. A pure function of (cards, ctx), so it belongs in a memo, never in
 * the async load that fetched the cards.
 */
export function foldTimeline(
  cards: readonly TimelineCard[],
  userCtx: UserGeoLanguageContext | null,
): TimelineEntry[] {
  const parent = cards.map((_, i) => i);
  const skOf = new Map<number, string>(); // root -> its storyKey
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const ka = skOf.get(ra);
    const kb = skOf.get(rb);
    if (ka && kb && ka !== kb) return;
    parent[rb] = ra;
    if (kb && !ka) skOf.set(ra, kb);
  };
  cards.forEach((c, i) => {
    if (c.storyKey) skOf.set(find(i), c.storyKey);
  });
  const holder = new Map<string, number>();
  cards.forEach((c, i) => {
    for (const key of foldKeysOf(c)) {
      const h = holder.get(key);
      if (h === undefined) holder.set(key, i);
      else union(h, i);
    }
  });

  const groups = new Map<number, TimelineCard[]>();
  cards.forEach((c, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  });
  const compare = makeRepCompare(userCtx);
  const asItem = (c: TimelineCard) => ({
    s: {
      _id: c.articleId,
      firstPubDate: c.pubDateMs ? new Date(c.pubDateMs).toISOString() : null,
      rawScore: null,
      publication_name: c.publicationName ?? null,
      country_code: c.countryCode ?? null,
      language_code: c.languageCode ?? null,
      image_url: c.imageUrl ?? null,
    },
  });
  return [...groups.values()]
    .map((members) => {
      const sorted = [...members].sort((a, b) => compare(asItem(a), asItem(b)));
      return { head: sorted[0], copies: sorted.slice(1) };
    })
    .sort((a, b) => b.head.pubDateMs - a.head.pubDateMs);
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

/**
 * A Stories row's latest headline (FinalFeedStatus #6): the newest snapshot
 * among the story's CURRENT members (`memberArticleIds`, the same filter its
 * count uses, so a disowned article never resurfaces here). Null when none.
 */
export function latestMember(
  snapshots: readonly TrackedStoryMemberSnapshot[] | undefined,
  memberIds: readonly string[] | undefined,
): TrackedStoryMemberSnapshot | null {
  const ids = new Set(memberIds ?? []);
  let best: TrackedStoryMemberSnapshot | null = null;
  for (const s of snapshots ?? []) {
    if (!ids.has(s.articleId)) continue;
    if (!best || s.pubDateMs > best.pubDateMs) best = s;
  }
  return best;
}
