// tracked-story-service.poll.test.ts — unit tests for the poll-task-only
// additions (getActiveForPoll / stampChecked). Split from
// tracked-story-service.test.ts to avoid churn on that shared file; same
// WatermelonDB mock pattern (makeDatabaseMock ignores query predicates, so
// tests give only the rows a call should see and rely on the service's JS
// filters, mirroring getActiveForReconcile's existing tests).

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
import { getActiveForPoll, stampChecked } from '../tracked-story-service';

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
    createdAt: overrides.createdAt ?? new Date(1700000000000),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('tracked_stories', []);
});

describe('getActiveForPoll', () => {
  const NOW = 1_700_100_000_000;
  const STALE_BEFORE = NOW - 30 * 60 * 1000;

  it('includes never-checked stories and excludes recently-checked ones', async () => {
    db._setRows('tracked_stories', [
      makeStory({ id: 'never', lastCheckedAt: null }),
      makeStory({ id: 'stale', lastCheckedAt: new Date(STALE_BEFORE - 1000) }),
      makeStory({ id: 'fresh', lastCheckedAt: new Date(STALE_BEFORE + 1000) }),
    ]);

    const rows = await getActiveForPoll(STALE_BEFORE, 10);

    expect(rows.map((r) => r.id).sort()).toEqual(['never', 'stale']);
  });

  it('includes singleton stories (no resolved stable id)', async () => {
    db._setRows('tracked_stories', [
      makeStory({ id: 'singleton', stableClusterId: null }),
    ]);

    const rows = await getActiveForPoll(STALE_BEFORE, 10);

    expect(rows).toEqual([
      { id: 'singleton', stableClusterId: null, memberArticleIds: ['a1'], latestArticleId: 'a1' },
    ]);
  });

  it('ignores ended stories', async () => {
    db._setRows('tracked_stories', [
      makeStory({ id: 'ended', status: 'ended' }),
    ]);

    const rows = await getActiveForPoll(STALE_BEFORE, 10);

    expect(rows).toEqual([]);
  });

  it('orders oldest/never-checked first and respects the cap', async () => {
    db._setRows('tracked_stories', [
      makeStory({ id: 'mid', lastCheckedAt: new Date(1000) }),
      makeStory({ id: 'never', lastCheckedAt: null }),
      makeStory({ id: 'oldest', lastCheckedAt: new Date(500) }),
      makeStory({ id: 'newer-but-stale', lastCheckedAt: new Date(2000) }),
    ]);

    const rows = await getActiveForPoll(STALE_BEFORE, 2);

    expect(rows.map((r) => r.id)).toEqual(['never', 'oldest']);
  });
});

describe('stampChecked', () => {
  it('stamps last_checked_at with a fresh Date', async () => {
    const row = makeStory({ id: 's1', lastCheckedAt: null });
    db._setRows('tracked_stories', [row]);

    await stampChecked('s1');

    expect(row.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('never throws on a missing row', async () => {
    await expect(stampChecked('nope')).resolves.toBeUndefined();
  });
});
