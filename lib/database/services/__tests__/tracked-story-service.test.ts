// tracked-story-service unit tests — WatermelonDB I/O via makeDatabaseMock.
// The fake query() ignores predicates and returns every row set, so tests give
// only the rows a call should see and rely on the service's JS status guards.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('../../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import {
  trackStory,
  untrackStory,
  isTracked,
  markSeen,
  applyUpdates,
  resolveStableId,
  setLlmHeadline,
  recordMiss,
  getActiveForReconcile,
  getActiveForTopicReconcile,
  sortTrackedStories,
  mergeMemberSnapshots,
  MISSES_TO_END,
} from '../tracked-story-service';

const db = database as any;

function makeStory(overrides: Record<string, any> = {}) {
  return makeRecord({
    id: overrides.id ?? 'story-1',
    stableClusterId: overrides.stableClusterId ?? null,
    memberArticleIds: overrides.memberArticleIds ?? ['a1'],
    llmHeadline: overrides.llmHeadline ?? null,
    fallbackTitle: overrides.fallbackTitle ?? 'A story',
    latestArticleId: overrides.latestArticleId ?? 'a1',
    latestTitle: overrides.latestTitle ?? 'A story',
    originSurface: overrides.originSurface ?? 'detail',
    lastUpdateAt: overrides.lastUpdateAt ?? null,
    unseenCount: overrides.unseenCount ?? 0,
    lastCheckedAt: overrides.lastCheckedAt ?? null,
    missCount: overrides.missCount ?? 0,
    status: overrides.status ?? 'active',
    topicId: overrides.topicId ?? null,
    topicText: overrides.topicText ?? null,
    memberSnapshots: overrides.memberSnapshots ?? [],
    createdAt: overrides.createdAt ?? new Date(1700000000000),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('tracked_stories', []);
});

describe('trackStory', () => {
  it('creates an active row seeded from the tapped article', async () => {
    const created = await trackStory({
      stableClusterId: 'clu-1',
      articleId: 'art-1',
      title: 'Big story',
      originSurface: 'for_you',
    });
    expect(created.status).toBe('active');
    expect(created.stableClusterId).toBe('clu-1');
    expect(created.memberArticleIds).toEqual(['art-1']);
    expect(created.fallbackTitle).toBe('Big story');
    expect(created.latestArticleId).toBe('art-1');
    expect(created.unseenCount).toBe(0);
    expect(created.missCount).toBe(0);
    expect(created.llmHeadline).toBeNull();
  });

  it('normalizes a blank stable cluster id to null', async () => {
    const created = await trackStory({
      stableClusterId: '   ',
      articleId: 'art-2',
      title: 'X',
      originSurface: 'detail',
    });
    expect(created.stableClusterId).toBeNull();
  });
});

describe('untrackStory', () => {
  it('hard-deletes the row', async () => {
    const row = makeStory({ id: 's1' });
    db._setRows('tracked_stories', [row]);
    await untrackStory('s1');
    expect(row.destroyPermanently).toHaveBeenCalled();
  });

  it('never throws on a missing row', async () => {
    await expect(untrackStory('nope')).resolves.toBeUndefined();
  });
});

describe('isTracked', () => {
  it('matches on stable cluster id', async () => {
    db._setRows('tracked_stories', [makeStory({ stableClusterId: 'clu-9' })]);
    expect(await isTracked({ stableClusterId: 'clu-9' })).toBe(true);
    expect(await isTracked({ stableClusterId: 'clu-other' })).toBe(false);
  });

  it('matches on member article id', async () => {
    db._setRows('tracked_stories', [makeStory({ memberArticleIds: ['a1', 'a2'] })]);
    expect(await isTracked({ articleId: 'a2' })).toBe(true);
    expect(await isTracked({ articleId: 'a3' })).toBe(false);
  });

  it('ignores ended stories', async () => {
    db._setRows('tracked_stories', [
      makeStory({ status: 'ended', stableClusterId: 'clu-3' }),
    ]);
    expect(await isTracked({ stableClusterId: 'clu-3' })).toBe(false);
  });

  it('returns false when no key is supplied', async () => {
    db._setRows('tracked_stories', [makeStory()]);
    expect(await isTracked({})).toBe(false);
  });
});

describe('markSeen', () => {
  it('zeroes the unseen count', async () => {
    const row = makeStory({ id: 's1', unseenCount: 4 });
    db._setRows('tracked_stories', [row]);
    await markSeen('s1');
    expect(row.unseenCount).toBe(0);
  });
});

describe('applyUpdates', () => {
  it('prepends new ids, bumps unseen, stamps update, resets misses', async () => {
    const row = makeStory({
      id: 's1',
      memberArticleIds: ['old1', 'old2'],
      unseenCount: 1,
      missCount: 3,
    });
    db._setRows('tracked_stories', [row]);

    await applyUpdates('s1', {
      newMemberIds: ['new1', 'new2'],
      latestArticleId: 'new1',
      latestTitle: 'Newest',
    });

    expect(row.memberArticleIds).toEqual(['new1', 'new2', 'old1', 'old2']);
    expect(row.unseenCount).toBe(3); // 1 + 2 new
    expect(row.missCount).toBe(0);
    expect(row.latestArticleId).toBe('new1');
    expect(row.latestTitle).toBe('Newest');
    expect(row.lastUpdateAt).toBeInstanceOf(Date);
  });

  it('caps the member list at 30, newest-first', async () => {
    const existing = Array.from({ length: 30 }, (_, i) => `old${i}`);
    const row = makeStory({ id: 's1', memberArticleIds: existing });
    db._setRows('tracked_stories', [row]);

    await applyUpdates('s1', { newMemberIds: ['n1', 'n2', 'n3'] });

    expect(row.memberArticleIds).toHaveLength(30);
    expect(row.memberArticleIds.slice(0, 3)).toEqual(['n1', 'n2', 'n3']);
    expect(row.memberArticleIds).not.toContain('old29');
  });

  it('ignores blank new ids in the unseen math', async () => {
    const row = makeStory({ id: 's1', memberArticleIds: ['a'], unseenCount: 0 });
    db._setRows('tracked_stories', [row]);
    await applyUpdates('s1', { newMemberIds: ['', '  ', 'real'] });
    expect(row.unseenCount).toBe(1);
    expect(row.memberArticleIds).toEqual(['real', 'a']);
  });
});

describe('resolveStableId / setLlmHeadline', () => {
  it('binds a resolved stable cluster id', async () => {
    const row = makeStory({ id: 's1', stableClusterId: null });
    db._setRows('tracked_stories', [row]);
    await resolveStableId('s1', 'clu-x');
    expect(row.stableClusterId).toBe('clu-x');
  });

  it('writes a trimmed headline, no-ops on blank', async () => {
    const row = makeStory({ id: 's1' });
    db._setRows('tracked_stories', [row]);
    await setLlmHeadline('s1', '  Headline here  ');
    expect(row.llmHeadline).toBe('Headline here');

    await setLlmHeadline('s1', '   ');
    expect(row.llmHeadline).toBe('Headline here'); // unchanged
  });
});

describe('recordMiss', () => {
  it('increments the streak and stamps last_checked_at', async () => {
    const row = makeStory({ id: 's1', missCount: 2 });
    db._setRows('tracked_stories', [row]);
    await recordMiss('s1');
    expect(row.missCount).toBe(3);
    expect(row.status).toBe('active');
    expect(row.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('auto-ends the story once the streak hits MISSES_TO_END', async () => {
    const row = makeStory({ id: 's1', missCount: MISSES_TO_END - 1 });
    db._setRows('tracked_stories', [row]);
    await recordMiss('s1');
    expect(row.missCount).toBe(MISSES_TO_END);
    expect(row.status).toBe('ended');
  });
});

describe('getActiveForReconcile', () => {
  it('returns lean rows for active stories with a resolved stable id', async () => {
    db._setRows('tracked_stories', [
      makeStory({ id: 's1', status: 'active', stableClusterId: 'clu-1', memberArticleIds: ['a'] }),
      makeStory({ id: 's2', status: 'active', stableClusterId: null }),
      makeStory({ id: 's3', status: 'ended', stableClusterId: 'clu-3' }),
    ]);
    const rows = await getActiveForReconcile();
    expect(rows).toEqual([
      { id: 's1', stableClusterId: 'clu-1', memberArticleIds: ['a'], latestArticleId: 'a1' },
    ]);
  });
});

describe('sortTrackedStories', () => {
  it('orders unseen stories first, then newest activity', () => {
    const seenOld = makeStory({ id: 'seen-old', unseenCount: 0, lastUpdateAt: new Date(1000) });
    const seenNew = makeStory({ id: 'seen-new', unseenCount: 0, lastUpdateAt: new Date(5000) });
    const unseenOld = makeStory({ id: 'unseen-old', unseenCount: 2, lastUpdateAt: new Date(2000) });
    const unseenNew = makeStory({ id: 'unseen-new', unseenCount: 1, lastUpdateAt: new Date(9000) });

    const sorted = sortTrackedStories([seenOld, unseenOld, seenNew, unseenNew]);
    expect(sorted.map((s) => s.id)).toEqual([
      'unseen-new',
      'unseen-old',
      'seen-new',
      'seen-old',
    ]);
  });

  it('falls back to created_at when last_update_at is null', () => {
    const a = makeStory({ id: 'a', unseenCount: 0, lastUpdateAt: null, createdAt: new Date(1000) });
    const b = makeStory({ id: 'b', unseenCount: 0, lastUpdateAt: null, createdAt: new Date(2000) });
    expect(sortTrackedStories([a, b]).map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('trackStory — topic-linked fields (v40)', () => {
  it('persists topic id/text, headline, and seeds the originating snapshot', async () => {
    const created = await trackStory({
      stableClusterId: 'clu-1',
      articleId: 'art-1',
      title: 'Big story',
      originSurface: 'for_you',
      topicId: 'top-1',
      topicText: 'Updates on the protest',
      llmHeadline: 'Updates on the protest',
      initialSnapshot: {
        articleId: 'art-1',
        title: 'Big story',
        pubDateMs: 1700000000000,
        publicationName: 'BBC',
      },
    });
    expect(created.topicId).toBe('top-1');
    expect(created.topicText).toBe('Updates on the protest');
    expect(created.llmHeadline).toBe('Updates on the protest');
    expect(created.memberSnapshots).toEqual([
      { articleId: 'art-1', title: 'Big story', pubDateMs: 1700000000000, publicationName: 'BBC' },
    ]);
  });

  it('leaves topic fields null and snapshots empty for a legacy toggle-track', async () => {
    const created = await trackStory({
      stableClusterId: 'clu-1',
      articleId: 'art-1',
      title: 'X',
      originSurface: 'detail',
    });
    expect(created.topicId).toBeNull();
    expect(created.topicText).toBeNull();
    expect(created.llmHeadline).toBeNull();
    expect(created.memberSnapshots).toEqual([]);
  });
});

describe('applyUpdates — member snapshots (v40)', () => {
  it('merges new snapshots newest-first and dedupes (incoming wins)', async () => {
    const row = makeStory({
      id: 's1',
      memberArticleIds: ['a1'],
      memberSnapshots: [
        { articleId: 'a1', title: 'Old A1', pubDateMs: 1000 },
      ],
    });
    db._setRows('tracked_stories', [row]);

    await applyUpdates('s1', {
      newMemberIds: ['a2', 'a1'],
      newSnapshots: [
        { articleId: 'a2', title: 'A2', pubDateMs: 3000 },
        { articleId: 'a1', title: 'Fresh A1', pubDateMs: 5000 }, // overwrites older a1
      ],
    });

    // Sorted by pubDateMs desc; a1 uses the fresh snapshot.
    expect(row.memberSnapshots).toEqual([
      { articleId: 'a1', title: 'Fresh A1', pubDateMs: 5000 },
      { articleId: 'a2', title: 'A2', pubDateMs: 3000 },
    ]);
  });

  it('caps snapshots at 50, newest-first by pubDate', async () => {
    const existing = Array.from({ length: 50 }, (_, i) => ({
      articleId: `old${i}`,
      title: `Old ${i}`,
      pubDateMs: i, // ascending — old0 is the oldest
    }));
    const row = makeStory({ id: 's1', memberSnapshots: existing });
    db._setRows('tracked_stories', [row]);

    await applyUpdates('s1', {
      newMemberIds: ['n1'],
      newSnapshots: [{ articleId: 'n1', title: 'New', pubDateMs: 10_000 }],
    });

    expect(row.memberSnapshots).toHaveLength(50);
    expect(row.memberSnapshots[0]).toEqual({ articleId: 'n1', title: 'New', pubDateMs: 10_000 });
    // The oldest (old0, pubDateMs 0) is dropped by the cap.
    expect(row.memberSnapshots.some((s: any) => s.articleId === 'old0')).toBe(false);
  });

  it('leaves snapshots untouched when no newSnapshots are passed', async () => {
    const row = makeStory({
      id: 's1',
      memberSnapshots: [{ articleId: 'a1', title: 'Keep', pubDateMs: 1 }],
    });
    db._setRows('tracked_stories', [row]);
    await applyUpdates('s1', { newMemberIds: ['a2'] });
    expect(row.memberSnapshots).toEqual([{ articleId: 'a1', title: 'Keep', pubDateMs: 1 }]);
  });
});

describe('mergeMemberSnapshots', () => {
  it('dedupes by id (incoming wins), sorts newest-first, caps at 50', () => {
    const existing = [{ articleId: 'a', title: 'old', pubDateMs: 1 }];
    const incoming = [
      { articleId: 'a', title: 'new', pubDateMs: 9 },
      { articleId: 'b', title: 'b', pubDateMs: 5 },
    ];
    expect(mergeMemberSnapshots(existing, incoming)).toEqual([
      { articleId: 'a', title: 'new', pubDateMs: 9 },
      { articleId: 'b', title: 'b', pubDateMs: 5 },
    ]);
  });
});

describe('getActiveForTopicReconcile', () => {
  it('returns lean rows for active stories that carry a topic id', async () => {
    db._setRows('tracked_stories', [
      makeStory({ id: 't1', status: 'active', topicId: 'top-1', memberArticleIds: ['a'] }),
      makeStory({ id: 's2', status: 'active', topicId: null }),
      makeStory({ id: 't3', status: 'ended', topicId: 'top-3' }),
    ]);
    const rows = await getActiveForTopicReconcile();
    expect(rows).toEqual([{ id: 't1', topicId: 'top-1', memberArticleIds: ['a'] }]);
  });
});

describe('getActiveForReconcile — excludes topic-linked stories', () => {
  it('returns only legacy (no topic id) active stories with a stable id', async () => {
    db._setRows('tracked_stories', [
      makeStory({ id: 'legacy', status: 'active', stableClusterId: 'clu-1', topicId: null }),
      makeStory({ id: 'topic', status: 'active', stableClusterId: 'clu-2', topicId: 'top-1' }),
    ]);
    const rows = await getActiveForReconcile();
    expect(rows.map((r) => r.id)).toEqual(['legacy']);
  });
});
