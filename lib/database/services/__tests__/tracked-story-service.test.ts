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
  advanceSeenWatermark,
  setLlmHeadline,
  getActiveForTopicReconcile,
  getLegacyTrackedForMigration,
  bindTrackedTopic,
  sortTrackedStories,
  mergeMemberSnapshots,
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
    seenPubWatermarkMs: overrides.seenPubWatermarkMs ?? null,
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

describe('setLlmHeadline', () => {
  it('writes a trimmed headline, no-ops on blank', async () => {
    const row = makeStory({ id: 's1' });
    db._setRows('tracked_stories', [row]);
    await setLlmHeadline('s1', '  Headline here  ');
    expect(row.llmHeadline).toBe('Headline here');

    await setLlmHeadline('s1', '   ');
    expect(row.llmHeadline).toBe('Headline here'); // unchanged
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

describe('applyUpdates — watermark-gated unseen count (v44)', () => {
  it('null watermark → legacy count (bumps by number of new ids)', async () => {
    const row = makeStory({
      id: 's1',
      memberArticleIds: ['a1'],
      unseenCount: 0,
      seenPubWatermarkMs: null,
    });
    db._setRows('tracked_stories', [row]);

    await applyUpdates('s1', {
      newMemberIds: ['a2', 'a3'],
      // Even with snapshots, a null watermark means the user never opened the
      // timeline → fall back to the legacy count.
      newSnapshots: [
        { articleId: 'a2', title: 'A2', pubDateMs: 500 }, // older than any watermark
        { articleId: 'a3', title: 'A3', pubDateMs: 9000 },
      ],
    });

    expect(row.unseenCount).toBe(2); // legacy: both new ids
  });

  it('watermark set → counts only members published AFTER the watermark', async () => {
    const row = makeStory({
      id: 's1',
      memberArticleIds: ['a1'],
      unseenCount: 0,
      seenPubWatermarkMs: 1000,
    });
    db._setRows('tracked_stories', [row]);

    await applyUpdates('s1', {
      newMemberIds: ['newer1', 'newer2', 'newer3', 'backfilled'],
      newSnapshots: [
        { articleId: 'newer1', title: 'N1', pubDateMs: 2000 }, // newer ✓
        { articleId: 'newer2', title: 'N2', pubDateMs: 3000 }, // newer ✓
        { articleId: 'newer3', title: 'N3', pubDateMs: 4000 }, // newer ✓
        { articleId: 'backfilled', title: 'Old', pubDateMs: 500 }, // older ✗
      ],
    });

    // Only the 3 published after the watermark count; the backfilled old one doesn't.
    expect(row.unseenCount).toBe(3);
    // All four still join the timeline (snapshots merged, pubDate-desc).
    expect(row.memberSnapshots.map((s: any) => s.articleId)).toEqual([
      'newer3',
      'newer2',
      'newer1',
      'backfilled',
    ]);
  });

  it('snapshots with pubDateMs 0/undefined count as OLD (backfill safety)', async () => {
    const row = makeStory({ id: 's1', unseenCount: 0, seenPubWatermarkMs: 1000 });
    db._setRows('tracked_stories', [row]);

    await applyUpdates('s1', {
      newMemberIds: ['zero', 'undef', 'real'],
      newSnapshots: [
        { articleId: 'zero', title: 'Z', pubDateMs: 0 },
        { articleId: 'undef', title: 'U' } as any, // pubDateMs undefined
        { articleId: 'real', title: 'R', pubDateMs: 5000 },
      ],
    });

    expect(row.unseenCount).toBe(1); // only 'real'
  });

  it('no snapshots (legacy poll path) → legacy count even with a watermark set', async () => {
    const row = makeStory({ id: 's1', unseenCount: 0, seenPubWatermarkMs: 1000 });
    db._setRows('tracked_stories', [row]);

    await applyUpdates('s1', { newMemberIds: ['a2', 'a3'] });

    expect(row.unseenCount).toBe(2); // legacy count — no per-member pubDates to gate on
  });
});

describe('advanceSeenWatermark (v44)', () => {
  it('sets the watermark when previously null', async () => {
    const row = makeStory({ id: 's1', seenPubWatermarkMs: null });
    db._setRows('tracked_stories', [row]);
    await advanceSeenWatermark('s1', 5000);
    expect(row.seenPubWatermarkMs).toBe(5000);
  });

  it('advances forward but never backwards (max semantics)', async () => {
    const row = makeStory({ id: 's1', seenPubWatermarkMs: 5000 });
    db._setRows('tracked_stories', [row]);

    await advanceSeenWatermark('s1', 9000);
    expect(row.seenPubWatermarkMs).toBe(9000); // moved forward

    await advanceSeenWatermark('s1', 3000);
    expect(row.seenPubWatermarkMs).toBe(9000); // stays — never moves back
  });

  it('ignores non-positive / non-finite watermarks', async () => {
    const row = makeStory({ id: 's1', seenPubWatermarkMs: 5000 });
    db._setRows('tracked_stories', [row]);
    await advanceSeenWatermark('s1', 0);
    await advanceSeenWatermark('s1', -1);
    await advanceSeenWatermark('s1', NaN);
    expect(row.seenPubWatermarkMs).toBe(5000);
  });

  it('never throws on a missing row', async () => {
    await expect(advanceSeenWatermark('nope', 1234)).resolves.toBeUndefined();
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

describe('getLegacyTrackedForMigration', () => {
  it('returns active, topic-less rows with de-duplicated headline/fallback/snapshot titles', async () => {
    db._setRows('tracked_stories', [
      // Active, no topicId → titles = dedup of [headline, fallback, snapshot titles].
      makeStory({
        id: 'legacy-a',
        status: 'active',
        topicId: null,
        llmHeadline: '  Protest updates  ',
        fallbackTitle: 'Protest hits capital',
        memberSnapshots: [
          { articleId: 's1', title: 'Protest hits capital', pubDateMs: 2 }, // dupe of fallback
          { articleId: 's2', title: 'Thousands march downtown', pubDateMs: 1 },
          { articleId: 's3', title: '   ', pubDateMs: 3 }, // blank → dropped
        ],
      }),
      // Active, no topicId, no headline → titles start from fallback + snapshots.
      makeStory({
        id: 'legacy-b',
        status: 'active',
        topicId: null,
        llmHeadline: null,
        fallbackTitle: '  Fallback only  ',
        memberSnapshots: [],
      }),
      // Already topic-linked → excluded.
      makeStory({
        id: 'topic-linked',
        status: 'active',
        topicId: 'top-1',
        llmHeadline: 'Has a headline',
      }),
      // Ended → excluded even though topic-less.
      makeStory({
        id: 'ended',
        status: 'ended',
        topicId: null,
        llmHeadline: 'Ended headline',
      }),
      // Active, topic-less, but no usable titles (all blank) → dropped.
      makeStory({
        id: 'no-titles',
        status: 'active',
        topicId: null,
        llmHeadline: '   ',
        fallbackTitle: '',
        memberSnapshots: [{ articleId: 's1', title: '  ', pubDateMs: 1 }],
      }),
    ]);

    const rows = await getLegacyTrackedForMigration();
    expect(rows).toEqual([
      {
        id: 'legacy-a',
        titles: ['Protest updates', 'Protest hits capital', 'Thousands march downtown'],
      },
      { id: 'legacy-b', titles: ['Fallback only'] },
    ]);
  });

  it('never throws — returns [] when the query errors', async () => {
    db._collections['tracked_stories'].query = jest.fn(() => {
      throw new Error('boom');
    });
    await expect(getLegacyTrackedForMigration()).resolves.toEqual([]);
  });
});

describe('bindTrackedTopic', () => {
  it('binds topicId and trims topicText', async () => {
    const row = makeStory({ id: 's1', topicId: null, topicText: null });
    db._setRows('tracked_stories', [row]);
    await bindTrackedTopic('s1', 'top-9', '  Updates on the protest  ');
    expect(row.topicId).toBe('top-9');
    expect(row.topicText).toBe('Updates on the protest');
  });

  it('allows a null topicId (unbind) while still setting text', async () => {
    const row = makeStory({ id: 's1', topicId: 'old-top', topicText: 'old text' });
    db._setRows('tracked_stories', [row]);
    await bindTrackedTopic('s1', null, 'New text');
    expect(row.topicId).toBeNull();
    expect(row.topicText).toBe('New text');
  });

  it('no-ops on blank topicText', async () => {
    const row = makeStory({ id: 's1', topicId: 'top-1', topicText: 'kept' });
    db._setRows('tracked_stories', [row]);
    await bindTrackedTopic('s1', 'top-2', '   ');
    expect(row.topicId).toBe('top-1');
    expect(row.topicText).toBe('kept');
  });

  it('never throws on a missing row', async () => {
    await expect(bindTrackedTopic('nope', 'top-1', 'text')).resolves.toBeUndefined();
  });
});
