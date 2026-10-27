// Unit tests for the pure tracked-story timeline builder. No RN/React —
// exercises dedupe (freshest-wins) and strict newest-first ordering over the
// LOCAL member snapshots (a followed story is a topic; there is no server
// archive anymore).

import { buildTimeline, foldTimeline, type TimelineCard } from '@/components/custom/tracked-stories/merge-timeline';
import type { TrackedStoryMemberSnapshot } from '@/lib/database/models/TrackedStory';

function local(
  overrides: Partial<TrackedStoryMemberSnapshot> = {},
): TrackedStoryMemberSnapshot {
  return {
    articleId: 'a1',
    title: 'Local title',
    pubDateMs: 1000,
    ...overrides,
  } as TrackedStoryMemberSnapshot;
}

const idOf = (cards: TimelineCard[]) => cards.map((c) => c.articleId);

describe('buildTimeline', () => {
  it('dedupes by articleId (last snapshot wins)', () => {
    const out = buildTimeline([
      local({ articleId: 'a1', title: 'First' }),
      local({ articleId: 'a1', title: 'Fresher' }),
    ]);
    expect(out).toHaveLength(1);
    expect(idOf(out)).toEqual(['a1']);
    expect(out[0].title).toBe('Fresher');
  });

  it('maps the snapshot fields onto the card', () => {
    const out = buildTimeline([
      local({
        articleId: 'a1',
        title: 'T',
        pubDateMs: 4321,
        imageUrl: 'https://img',
        publicationName: 'Acme',
      }),
    ]);
    expect(out[0]).toMatchObject({
      articleId: 'a1',
      title: 'T',
      pubDateMs: 4321,
      imageUrl: 'https://img',
      publicationName: 'Acme',
    });
  });

  it('sorts strictly newest-first by pubDate', () => {
    const out = buildTimeline([
      local({ articleId: 'old', pubDateMs: 1000 }),
      local({ articleId: 'new', pubDateMs: 9000 }),
      local({ articleId: 'mid', pubDateMs: 5000 }),
    ]);
    expect(idOf(out)).toEqual(['new', 'mid', 'old']);
  });

  it('treats a missing pubDate as oldest (0)', () => {
    const out = buildTimeline([
      local({ articleId: 'dated', pubDateMs: 5000 }),
      local({ articleId: 'undated', pubDateMs: undefined as unknown as number }),
    ]);
    expect(idOf(out)).toEqual(['dated', 'undated']);
  });

  it('skips snapshots with no articleId', () => {
    const out = buildTimeline([local({ articleId: '' })]);
    expect(out).toHaveLength(0);
  });

  it('returns an empty list for no snapshots', () => {
    expect(buildTimeline([])).toEqual([]);
  });

  // Q12: row 1 must be the LATEST PUBLISHED article, never "the article the
  // story was seeded from". The seed used to be stamped with the TRACK moment
  // (`Date.now()`), which pinned a 13h-old article above 1h-old coverage and
  // made its clock chip mean something different from every other row's. The
  // seed now carries its real pubDate, so it sorts on publication like anything
  // else — this pins that down.
  it('does NOT pin the seed article: an older seed sorts below newer members', () => {
    const out = buildTimeline([
      // Order of arrival mimics reality: the seed is stored first, the
      // reconcile appends fresher coverage afterwards.
      local({ articleId: 'seed-old', pubDateMs: 1_000 }),
      local({ articleId: 'reconciled-newer', pubDateMs: 8_000 }),
      local({ articleId: 'reconciled-newest', pubDateMs: 9_000 }),
    ]);
    expect(idOf(out)).toEqual(['reconciled-newest', 'reconciled-newer', 'seed-old']);
    expect(out[0].pubDateMs).toBe(9_000);
  });

  it('keeps a genuinely-newest seed at row 1', () => {
    const out = buildTimeline([
      local({ articleId: 'seed-newest', pubDateMs: 9_000 }),
      local({ articleId: 'older', pubDateMs: 2_000 }),
    ]);
    expect(idOf(out)).toEqual(['seed-newest', 'older']);
  });
});

// ux2: a timeline card never hands English to the card as the ORIGINAL title.
// English as the "original" of a Japanese article told TranslatableDynamic the
// original was already in the reader's language, so it never translated.
describe('timelineCardToArticle', () => {
  const { timelineCardToArticle, localToCard } = require('@/components/custom/tracked-stories/merge-timeline');

  it('keeps the real original title as `title` and English as the internal title', () => {
    const card = localToCard({
      articleId: 'a', title: 'Tokyo rain', titleOriginal: '東京で雨', pubDateMs: 1, languageCode: 'ja',
    });
    const article = timelineCardToArticle(card);
    expect(article.title).toBe('東京で雨');
    expect(article.title_en_internal_only).toBe('Tokyo rain');
    expect(article.original_language_code).toBe('ja');
  });

  it('leaves `title` empty when there is no original, never the English', () => {
    const article = timelineCardToArticle(
      localToCard({ articleId: 'a', title: 'Tokyo rain', pubDateMs: 1, languageCode: 'ja' }),
    );
    expect(article.title).toBeUndefined();
    expect(article.title_en_internal_only).toBe('Tokyo rain');
  });
});

describe('latestMember', () => {
  const { latestMember } = require('@/components/custom/tracked-stories/merge-timeline') as typeof import('@/components/custom/tracked-stories/merge-timeline');
  const snap = (articleId: string, pubDateMs: number) => ({ articleId, title: articleId, pubDateMs });
  it('picks the newest CURRENT member, skipping a newer disowned one', () => {
    const snaps = [snap('a', 1), snap('b', 3), snap('gone', 9), snap('c', 2)];
    expect(latestMember(snaps, ['a', 'b', 'c'])?.articleId).toBe('b');
  });
  it('is null with no current member', () => {
    expect(latestMember([snap('a', 1)], [])).toBeNull();
    expect(latestMember(undefined, undefined)).toBeNull();
  });
});

describe('foldTimeline', () => {
  const DAY = Date.UTC(2026, 9, 1, 12);
  const card = (o: Partial<TimelineCard> & { articleId: string }): TimelineCard => ({
    title: '',
    pubDateMs: DAY,
    ...o,
  });
  const heads = (e: ReturnType<typeof foldTimeline>) => e.map((x) => x.head.articleId);

  it('folds copies that share a storyKey into one entry, newest head first', () => {
    const out = foldTimeline(
      [
        card({ articleId: 'a', storyKey: 'K', title: 'One', pubDateMs: DAY }),
        card({ articleId: 'b', storyKey: 'K', title: 'Two', pubDateMs: DAY + 5 }),
        card({ articleId: 'c', title: 'Other', pubDateMs: DAY + 10 }),
      ],
      null,
    );
    expect(out).toHaveLength(2);
    expect(heads(out)).toEqual(['c', 'a']); // null ctx: the oldest copy fronts
    expect(out[1].copies.map((c) => c.articleId)).toEqual(['b']);
  });

  it('folds an English-only seed with an original-language copy of the same headline on the same day', () => {
    const out = foldTimeline(
      [
        card({ articleId: 'seed', title: 'Cabinet falls after budget vote' }),
        card({ articleId: 'nl', title: 'Cabinet falls after budget vote', titleOriginal: 'Kabinet valt na begrotingsstemming' }),
        card({ articleId: 'nl2', title: 'x', titleOriginal: 'Cabinet falls after budget vote' }),
      ],
      null,
    );
    expect(out).toHaveLength(1);
  });

  it('keeps two storyKeys apart even when a title joins them', () => {
    const same = 'Cabinet falls after budget vote';
    const out = foldTimeline(
      [
        card({ articleId: 'a', storyKey: 'K1', title: same }),
        card({ articleId: 'b', storyKey: 'K2', title: same }),
      ],
      null,
    );
    expect(out).toHaveLength(2);
  });

  it('does not fold short titles, or the same title on another UTC day', () => {
    expect(
      foldTimeline([card({ articleId: 'a', title: 'Short one' }), card({ articleId: 'b', title: 'Short one' })], null),
    ).toHaveLength(2);
    const t = 'Morning briefing for the whole region';
    expect(
      foldTimeline(
        [card({ articleId: 'a', title: t }), card({ articleId: 'b', title: t, pubDateMs: DAY + 86_400_000 })],
        null,
      ),
    ).toHaveLength(2);
  });
});
