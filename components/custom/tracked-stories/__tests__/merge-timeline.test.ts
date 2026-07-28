// Unit tests for the pure tracked-story timeline builder. No RN/React —
// exercises dedupe (freshest-wins) and strict newest-first ordering over the
// LOCAL member snapshots (a followed story is a topic; there is no server
// archive anymore).

import { buildTimeline, type TimelineCard } from '../merge-timeline';
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
