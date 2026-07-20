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
});
