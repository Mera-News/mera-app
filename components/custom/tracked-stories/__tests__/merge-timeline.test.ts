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
});
