// opened-stories-store against real story_impressions rows, seeded through the impression
// service the open handler uses. `articleIds` is the Feed's ingest-gate key (article axis only);
// `ids` is the article-plus-cluster union the Dashboard read-ticks and the P_SEEN demotion use.
// Replaces lib/stores/__tests__/opened-stories-store.test.ts (which mocked the service).
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import logger from '@/lib/logger';
import { getOpenedSeenSet, recordOpen } from '@/lib/database/services/story-impression-service';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { failTableQuery, resetStore, restoreFaults } from './support';

const store = () => useOpenedStoriesStore.getState();
const sorted = (set: Set<string>) => [...set].sort();

beforeEach(() => resetStore(useOpenedStoriesStore));
afterEach(restoreFaults);

it('starts empty and unhydrated', () => {
  expect(store().ids.size).toBe(0);
  expect(store().articleIds.size).toBe(0);
  expect(store().hydrated).toBe(false);
});

describe('hydrate', () => {
  it('fills `ids` with the article-and-cluster union and `articleIds` with article ids only', async () => {
    await recordOpen({ articleId: 'a1', stableClusterId: 'clu-1', surface: 'feed' });
    await recordOpen({ articleId: 'a2', surface: 'detail' }); // no stable cluster

    await store().hydrate();

    expect(sorted(store().ids)).toEqual(['a1', 'a2', 'clu-1']);
    expect(sorted(store().articleIds)).toEqual(['a1', 'a2']);
    expect(store().hydrated).toBe(true);
  });

  it('loads what the service itself reads as the opened seen set', async () => {
    await recordOpen({ articleId: 'a1', stableClusterId: 'clu-1', surface: 'feed' });
    await store().hydrate();
    expect(sorted(store().ids)).toEqual(sorted(await getOpenedSeenSet()));
  });

  it('an empty impressions table hydrates to empty sets', async () => {
    await store().hydrate();
    expect(store().ids.size).toBe(0);
    expect(store().articleIds.size).toBe(0);
    expect(store().hydrated).toBe(true);
  });

  it('an optimistic markOpened that lands BEFORE hydrate is preserved in both sets (merge, not replace)', async () => {
    store().markOpened('optimistic', 'optimistic-clu');
    await recordOpen({ articleId: 'from-db', stableClusterId: 'from-db-clu', surface: 'feed' });

    await store().hydrate();

    expect(sorted(store().ids)).toEqual(['from-db', 'from-db-clu', 'optimistic', 'optimistic-clu']);
    expect(sorted(store().articleIds)).toEqual(['from-db', 'optimistic']);
    // the optimistic cluster id must never leak into the article axis
    expect(store().articleIds.has('optimistic-clu')).toBe(false);
  });

  it('flips hydrated even when the read throws, and reports it', async () => {
    const err = new Error('db error');
    failTableQuery('story_impressions', err);

    await store().hydrate();

    expect(store().hydrated).toBe(true);
    expect(store().ids.size).toBe(0);
    expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { store: 'opened-stories-store' } });
  });

  it('a failed read keeps what was marked optimistically', async () => {
    store().markOpened('art-1', 'clu-1');
    failTableQuery('story_impressions');

    await store().hydrate();

    expect(sorted(store().ids)).toEqual(['art-1', 'clu-1']);
    expect(store().hydrated).toBe(true);
  });
});

describe('markOpened', () => {
  it('adds the article id and the stable cluster id synchronously', () => {
    store().markOpened('art-9', 'stable-9');
    expect(store().ids.has('art-9')).toBe(true);
    expect(store().ids.has('stable-9')).toBe(true);
  });

  it('puts the cluster id in `ids` but NOT in `articleIds`', () => {
    store().markOpened('art-9', 'stable-9');
    expect(store().articleIds.has('stable-9')).toBe(false);
    expect(store().articleIds.has('art-9')).toBe(true);
  });

  it('without a stable cluster id leaves both sets with just the article', () => {
    store().markOpened('art-only');
    expect([...store().ids]).toEqual(['art-only']);
    expect([...store().articleIds]).toEqual(['art-only']);
  });

  it('with an empty article id adds only the cluster and leaves the article set as it was', () => {
    const before = store().articleIds;
    store().markOpened('', 'clu-only');
    expect([...store().ids]).toEqual(['clu-only']);
    expect(store().articleIds).toBe(before);
  });

  it('replaces the Set references, so subscribers see a new identity', () => {
    const ids = store().ids;
    const articleIds = store().articleIds;
    store().markOpened('art-x');
    expect(store().ids).not.toBe(ids);
    expect(store().articleIds).not.toBe(articleIds);
  });

  it('is memory only: nothing is written to story_impressions', async () => {
    store().markOpened('art-x', 'clu-x');
    expect((await getOpenedSeenSet()).size).toBe(0);
  });
});
