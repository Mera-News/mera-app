// Unit tests for the pure tracked-story timeline merge (Part E). No RN/React —
// exercises dedupe, field precedence, and the server-authoritative pubDate flip.

import { mergeTimeline, type TimelineCard } from '../merge-timeline';
import type { TrackedStoryMemberSnapshot } from '@/lib/database/models/TrackedStory';
import type { TrackedStoryArticleSnapshot } from '@/lib/generated/graphql-types';

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

function server(
  overrides: Partial<TrackedStoryArticleSnapshot> = {},
): TrackedStoryArticleSnapshot {
  return {
    articleId: 'a1',
    title_en: 'Server title',
    pubDate: new Date(2000).toISOString(),
    image_url: null,
    publication_name: null,
    country_code: null,
    article_url: null,
    ...overrides,
  } as TrackedStoryArticleSnapshot;
}

const idOf = (cards: TimelineCard[]) => cards.map((c) => c.articleId);

describe('mergeTimeline', () => {
  it('dedupes by articleId across sources', () => {
    const out = mergeTimeline([local({ articleId: 'a1' })], [server({ articleId: 'a1' })]);
    expect(out).toHaveLength(1);
    expect(idOf(out)).toEqual(['a1']);
  });

  it('lets the SERVER archive win on pubDate (the Part E fix)', () => {
    // Local seed stamped a much-later track moment; server archive is authoritative.
    const out = mergeTimeline(
      [local({ articleId: 'a1', pubDateMs: 9_000_000 })],
      [server({ articleId: 'a1', pubDate: new Date(5000).toISOString() })],
    );
    expect(out[0].pubDateMs).toBe(5000);
  });

  it('falls back to the local pubDate when the server snapshot has none', () => {
    const out = mergeTimeline(
      [local({ articleId: 'a1', pubDateMs: 4321 })],
      [server({ articleId: 'a1', pubDate: '' })],
    );
    expect(out[0].pubDateMs).toBe(4321);
  });

  it('prefers the local title, falling back to the server title when blank', () => {
    const withLocal = mergeTimeline(
      [local({ articleId: 'a1', title: 'Local wins' })],
      [server({ articleId: 'a1', title_en: 'Server title' })],
    );
    expect(withLocal[0].title).toBe('Local wins');

    const blankLocal = mergeTimeline(
      [local({ articleId: 'a1', title: '' })],
      [server({ articleId: 'a1', title_en: 'Server fallback' })],
    );
    expect(blankLocal[0].title).toBe('Server fallback');
  });

  it('sorts strictly newest-first by pubDate', () => {
    const out = mergeTimeline(
      [],
      [
        server({ articleId: 'old', pubDate: new Date(1000).toISOString() }),
        server({ articleId: 'new', pubDate: new Date(9000).toISOString() }),
        server({ articleId: 'mid', pubDate: new Date(5000).toISOString() }),
      ],
    );
    expect(idOf(out)).toEqual(['new', 'mid', 'old']);
  });

  it('carries server-only media/url fields onto the merged card', () => {
    const out = mergeTimeline(
      [local({ articleId: 'a1', title: 'T', imageUrl: undefined, publicationName: undefined })],
      [
        server({
          articleId: 'a1',
          image_url: 'https://img',
          country_code: 'IN',
          article_url: 'https://read',
        }),
      ],
    );
    expect(out[0].imageUrl).toBe('https://img');
    expect(out[0].countryCode).toBe('IN');
    expect(out[0].articleUrl).toBe('https://read');
  });

  it('skips snapshots with no articleId', () => {
    const out = mergeTimeline(
      [local({ articleId: '' })],
      [server({ articleId: '' })],
    );
    expect(out).toHaveLength(0);
  });

  // ── r6 P6 regression: freshness refetch + backfill ordering ──────────────
  it('server pubDate wins over a legacy local track-time stamp on re-merge', () => {
    // The local seed historically stamped Date.now() at track time; a refetch
    // that pairs it with the authoritative server archive must sort by the real
    // publication time, not the (much later) track moment.
    const localSeed = [
      local({ articleId: 'seed', title: 'Seed', pubDateMs: 9_999_999_999 }),
    ];
    const serverArchive = [
      server({ articleId: 'seed', title_en: 'Seed', pubDate: new Date(5000).toISOString() }),
      server({ articleId: 'newer', title_en: 'Newer', pubDate: new Date(8000).toISOString() }),
    ];
    const merged = mergeTimeline(localSeed, serverArchive);
    expect(idOf(merged)).toEqual(['newer', 'seed']);
    // The legacy track-time stamp is discarded in favour of the server pubDate.
    expect(merged.find((c) => c.articleId === 'seed')!.pubDateMs).toBe(5000);
  });

  it('re-merge after refetch keeps strict pubDate-desc with backfilled older articles below newer', () => {
    const localSeed = [
      local({ articleId: 'seed', title: 'Seed', pubDateMs: 9_999_999_999 }),
    ];
    // The refetched archive gained a BACKFILLED older article and a genuinely
    // newer one. Latest-published must stay on top; the backfill sinks below.
    const refetched = [
      server({ articleId: 'seed', title_en: 'Seed', pubDate: new Date(5000).toISOString() }),
      server({ articleId: 'newer', title_en: 'Newer', pubDate: new Date(8000).toISOString() }),
      server({ articleId: 'backfill-old', title_en: 'Old', pubDate: new Date(1000).toISOString() }),
      server({ articleId: 'newest', title_en: 'Newest', pubDate: new Date(9000).toISOString() }),
    ];
    const merged = mergeTimeline(localSeed, refetched);
    expect(idOf(merged)).toEqual(['newest', 'newer', 'seed', 'backfill-old']);
  });
});
