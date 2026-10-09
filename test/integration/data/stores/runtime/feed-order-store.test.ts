// feed-order-store against the real settings table: the persisted order and the card-state blob
// are read and written as rows, so persistence is asserted on what is on disk, not on a call.
//
// Covers: hydrate (row load, eviction of ids with no backing item, builtAt, the empty-pool guard,
// hydrateStats, the in-flight guard, failure paths), ingest (no-op until hydrated, the initial
// build, the narrowed opened gate, prepend, rep-switch dedupe, group SPLIT never stealing a claimed
// row), the verdict mirror, card-state parse and persistence (the 1s coalesced write on a strict
// clock), flushPersist, markSkipped, markViewed, removeIds and reset.
// Replaces lib/stores/__tests__/feed-order-store.test.ts (which mocked setting-service).
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
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  FEED_CARD_STATE_SETTING_KEY,
  FEED_ORDER_SETTING_KEY,
  useFeedOrderStore,
} from '@/lib/stores/feed-order-store';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useStrictClock } from '@/test/helpers';
import {
  countSettingReads,
  drainWrites,
  failNextWrite,
  failSettingRead,
  resetStore,
  restoreFaults,
  rowAppears,
  runDueTimers,
  rowIs,
  settle,
  until,
  watchWrites,
} from './support';

const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const MIN = 60_000;
/** The store's own debounce; asserted from the outside by driving the clock to its edge. */
const DEBOUNCE_MS = 1000;

function item(
  id: string,
  over: { score?: number; pubMs?: number; cluster?: string | null; articleId?: string; memberIds?: string[] } = {},
): FeedListItem {
  const clusters = over.cluster ? [{ stableClusterId: over.cluster }] : [];
  const suggestion = {
    _id: id,
    articleId: over.articleId ?? id,
    firstPubDate: new Date(over.pubMs ?? 1_000).toISOString(),
    clusters,
  } as unknown as ForYouSuggestion;
  return {
    id,
    suggestion,
    memberCount: over.memberIds?.length ?? 1,
    memberIds: over.memberIds ?? [over.articleId ?? id],
    breaking: false,
    score: over.score ?? 0.5,
  };
}

const store = () => useFeedOrderStore.getState();

/** A persisted order that is byte-distinct from what the store itself writes (`order` first), so a
 *  re-persist of an unchanged order shows up as a changed row. */
const orderBlob = (order: string[], builtAt: number | null = 1) => JSON.stringify({ builtAt, order });

/** A hydrated store whose persisted order is `order`, backed by `items`. */
async function hydrated(items: FeedListItem[], order = items.map((i) => i.id), builtAt: number | null = 1) {
  await setSetting(FEED_ORDER_SETTING_KEY, orderBlob(order, builtAt));
  await store().hydrate(items);
}

describe('feed-order-store', () => {
  beforeEach(() => {
    useStrictClock(NOW);
    resetStore(useFeedOrderStore);
  });
  // Inside the outer describe so it runs before the setup file restores real timers. reset() is the
  // only public way to cancel the module-level persist timer, which would otherwise stay armed and
  // make the next test's first mark a no-op.
  afterEach(async () => {
    restoreFaults();
    store().reset();
    // A write still in flight when the setup file swaps the fake clock back would never finish and
    // would block the next test's database reset: wait for the deletes to complete.
    await drainWrites();
    await until(
      async () =>
        (await getSetting(FEED_ORDER_SETTING_KEY)) === null && (await getSetting(FEED_CARD_STATE_SETTING_KEY)) === null,
      'reset to delete both rows',
    );
  });

  describe('hydrate', () => {
    it('loads the persisted order, evicts ids with no backing item, restores builtAt, reports hydrateStats and re-persists the survivors', async () => {
      await setSetting(FEED_ORDER_SETTING_KEY, orderBlob(['a', 'b', 'c'], 123));

      // b has aged out of the live pool: only a and c back the persisted order
      await store().hydrate([item('a'), item('c')]);

      const s = store();
      expect(s.order).toEqual(['a', 'c']);
      expect(Object.keys(s.itemsById).sort()).toEqual(['a', 'c']);
      expect(s.builtAt).toBe(123);
      expect(s.hydrated).toBe(true);
      expect(s.hydrateStats).toEqual({
        persistedOrderCount: 3,
        candidateCountAtHydrate: 2,
        survivorCount: 2,
        emptyPoolGuardTripped: false,
      });
      // the survivors are written back; `order` is the FIRST serialized key
      await rowIs(FEED_ORDER_SETTING_KEY, '{"order":["a","c"],"builtAt":123}');
    });

    it('keeps the persisted row untouched when every id still has a backing item', async () => {
      await setSetting(FEED_ORDER_SETTING_KEY, orderBlob(['a', 'b'], 5));
      await store().hydrate([item('a'), item('b')]);
      await settle();
      expect(await getSetting(FEED_ORDER_SETTING_KEY)).toBe(orderBlob(['a', 'b'], 5));
    });

    it('flips hydrated even when the row read throws, and reports it', async () => {
      const err = new Error('db crash');
      failSettingRead(FEED_ORDER_SETTING_KEY, err);

      await store().hydrate([item('a')]);

      expect(store().hydrated).toBe(true);
      expect(store().order).toEqual([]);
      expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { store: 'feed-order-store' } });
    });

    it.each([
      ['corrupt JSON', '{not json'],
      ['an object with no order array', '{"order":"nope"}'],
      ['a bare number', '7'],
    ])('%s reads as an empty order, hydrated', async (_label, raw) => {
      await setSetting(FEED_ORDER_SETTING_KEY, raw);
      await store().hydrate([item('a')]);
      expect(store().order).toEqual([]);
      expect(store().builtAt).toBeNull();
      expect(store().hydrated).toBe(true);
    });

    it('drops non-string ids and a non-numeric builtAt from a malformed order blob', async () => {
      await setSetting(FEED_ORDER_SETTING_KEY, '{"order":["a",7,null,"b"],"builtAt":"x"}');
      await store().hydrate([item('a'), item('b')]);
      expect(store().order).toEqual(['a', 'b']);
      expect(store().builtAt).toBeNull();
    });

    it('EMPTY-POOL GUARD: hydrate([]) against a persisted order skips the eviction pass, so the reading order survives a hydrate that races the suggestion store', async () => {
      await setSetting(FEED_ORDER_SETTING_KEY, orderBlob(['a', 'b', 'c'], 7));

      await store().hydrate([]);

      const s = store();
      expect(s.order).toEqual(['a', 'b', 'c']);
      // the pass is skipped entirely, so itemsById stays empty until the follow-up ingest heals it
      expect(s.itemsById).toEqual({});
      expect(s.hydrateStats).toEqual({
        persistedOrderCount: 3,
        candidateCountAtHydrate: 0,
        survivorCount: 3,
        emptyPoolGuardTripped: true,
      });
      // survivors match the persisted count, so nothing is written back
      await settle();
      expect(await getSetting(FEED_ORDER_SETTING_KEY)).toBe(orderBlob(['a', 'b', 'c'], 7));

      // the suggestion store lands a moment later and ingest reconciles normally
      store().ingest([item('a', { score: 0.9 }), item('b', { score: 0.8 }), item('c', { score: 0.7 })], new Set());
      expect(store().order).toEqual(['a', 'b', 'c']);
      expect(Object.keys(store().itemsById).sort()).toEqual(['a', 'b', 'c']);
      await settle();
      expect(await getSetting(FEED_ORDER_SETTING_KEY)).toBe(orderBlob(['a', 'b', 'c'], 7));
    });

    it('with no persisted row and no candidates, the empty-pool guard is not tripped', async () => {
      await store().hydrate([]);
      expect(store().hydrateStats).toEqual({
        persistedOrderCount: 0,
        candidateCountAtHydrate: 0,
        survivorCount: 0,
        emptyPoolGuardTripped: false,
      });
    });

    it('two feed tabs hydrating at once share one read of each row', async () => {
      await setSetting(FEED_ORDER_SETTING_KEY, orderBlob(['a'], 3));
      const orderReads = countSettingReads(FEED_ORDER_SETTING_KEY);
      const cardReads = countSettingReads(FEED_CARD_STATE_SETTING_KEY);

      await Promise.all([store().hydrate([item('a')]), store().hydrate([item('a')])]);

      expect(orderReads()).toBe(1);
      expect(cardReads()).toBe(1);
      expect(store().order).toEqual(['a']);
    });

    it('once hydrated, a later hydrate reads nothing and changes nothing', async () => {
      await hydrated([item('a')]);
      await setSetting(FEED_ORDER_SETTING_KEY, orderBlob(['zzz'], 9));
      const reads = countSettingReads(FEED_ORDER_SETTING_KEY);

      await store().hydrate([item('zzz')]);

      expect(reads()).toBe(0);
      expect(store().order).toEqual(['a']);
    });
  });

  describe('ingest, no-op until hydrated', () => {
    it('does nothing before hydrate and writes no row', async () => {
      store().ingest([item('a')], new Set());
      await settle();
      expect(store().order).toEqual([]);
      expect(await getSetting(FEED_ORDER_SETTING_KEY)).toBeNull();
    });
  });

  describe('ingest, initial build (empty order)', () => {
    it('inserts in pure feedCompare order, stamps builtAt and persists both', async () => {
      await store().hydrate([]); // a first launch: no row at all
      store().ingest([item('a', { score: 0.8 }), item('b', { score: 1.0 }), item('c', { score: 0.5 })], new Set());

      // feedCompare = score desc
      expect(store().order).toEqual(['b', 'a', 'c']);
      expect(store().builtAt).toBe(NOW);
      await rowIs(FEED_ORDER_SETTING_KEY, `{"order":["b","a","c"],"builtAt":${NOW}}`);
    });

    it('does not stamp builtAt for an ingest that lays nothing out', async () => {
      await setSetting(FEED_ORDER_SETTING_KEY, orderBlob([], null));
      await store().hydrate([]);
      store().ingest([], new Set());
      expect(store().builtAt).toBeNull();
      await settle();
      expect(await getSetting(FEED_ORDER_SETTING_KEY)).toBe(orderBlob([], null));
    });

    it('skips genuinely new ids whose exact articleId is already opened', async () => {
      await hydrated([]);
      store().ingest([item('a'), item('b')], new Set(['a']));
      expect(store().order).toEqual(['b']);
    });
  });

  describe('ingest, narrowed opened gate (exact articleId only)', () => {
    // The gate used to match the cluster-wide opened set (article ids plus stable cluster ids with a
    // 30-day TTL), so reading one article suppressed every future article in that ongoing story.
    it('excludes a candidate whose own articleId is in openedArticleIds', async () => {
      await hydrated([]);
      store().ingest([item('a', { articleId: 'art-a' })], new Set(['art-a']));
      expect(store().order).toEqual([]);
    });

    it('does NOT exclude a candidate merely because its stableClusterId is in the opened set', async () => {
      await hydrated([]);
      store().ingest([item('a', { articleId: 'art-a', cluster: 'C1' })], new Set(['C1']));
      expect(store().order).toEqual(['a']);
    });

    // The gate sits in PASS B, which only sees ids not already in `order`. Hoisting it ahead of the
    // known-row check would make every read card vanish on its next refresh.
    it('never removes an already laid-out row, even when its own articleId is opened on the next sync', async () => {
      await hydrated([item('a', { score: 0.9 })]);
      store().markViewed('a', NOW);

      store().ingest([item('a', { score: 0.2 })], new Set(['a']));

      expect(store().order).toEqual(['a']);
      expect(store().itemsById.a.score).toBe(0.2); // refreshed in place
    });
  });

  describe('ingest, prepend', () => {
    it('lands a new batch at the FRONT, sorted among itself by feedCompare', async () => {
      await hydrated([item('a', { score: 0.9 })]);
      store().ingest(
        [
          item('a', { score: 0.9 }),
          item('x', { score: 0.5 }),
          item('y', { score: 0.8 }),
          item('z', { score: 0.5, pubMs: 2_000 }), // ties x on score, wins on pubDate
        ],
        new Set(),
      );
      // y (0.8) > z (0.5, newer) > x (0.5, older), then the existing row
      expect(store().order).toEqual(['y', 'z', 'x', 'a']);
    });

    it('keeps existing rows in their relative order, each shifted by the size of the batch', async () => {
      const existing = [item('a', { score: 0.9 }), item('b', { score: 0.7 }), item('c', { score: 0.3 })];
      await hydrated(existing);
      store().ingest([...existing, item('x', { score: 1.0 }), item('y', { score: 0.95 })], new Set());
      expect(store().order).toEqual(['x', 'y', 'a', 'b', 'c']);
    });

    it('persists the prepended order', async () => {
      await hydrated([item('a', { score: 0.9 })], ['a'], 11);
      store().ingest([item('a', { score: 0.9 }), item('x', { score: 0.5 })], new Set());
      await rowIs(FEED_ORDER_SETTING_KEY, '{"order":["x","a"],"builtAt":11}');
    });

    // Regression: the old insertion-sort scan broke on the first order id with no backing item, making
    // that id a permanent insert magnet. A ghost id is reachable through the empty-pool guard.
    it('an order id with no backing row no longer attracts inserts', async () => {
      await setSetting(FEED_ORDER_SETTING_KEY, orderBlob(['a', 'ghost'], 1));
      await store().hydrate([]); // empty pool: nothing is evicted, itemsById stays empty

      store().ingest([item('a', { score: 1.0 }), item('z', { score: 0.1 })], new Set());

      // a is an exact-id match; ghost has no row to match against; z is new and goes to the front
      expect(store().order).toEqual(['z', 'a', 'ghost']);
    });

    it('two successive ingests: the SECOND batch ends up above the first', async () => {
      await hydrated([]);
      store().ingest([item('a', { score: 0.5 }), item('b', { score: 0.4 })], new Set());
      expect(store().order).toEqual(['a', 'b']);

      store().ingest(
        [item('a', { score: 0.5 }), item('b', { score: 0.4 }), item('c', { score: 0.2 }), item('d', { score: 0.1 })],
        new Set(),
      );
      expect(store().order).toEqual(['c', 'd', 'a', 'b']);
    });

    it('a duplicate candidate id in one batch is laid out once', async () => {
      await hydrated([]);
      store().ingest([item('a', { score: 0.9 }), item('a', { score: 0.9 })], new Set());
      expect(store().order).toEqual(['a']);
    });

    it('a no-op ingest changes neither the order nor the persisted row', async () => {
      const items = [item('a', { score: 0.9 }), item('b', { score: 0.5 })];
      await hydrated(items, ['a', 'b'], 4);

      store().ingest(items, new Set());

      expect(store().order).toEqual(['a', 'b']);
      await settle();
      expect(await getSetting(FEED_ORDER_SETTING_KEY)).toBe(orderBlob(['a', 'b'], 4));
    });

    it('reports a failed order write and keeps the in-memory order', async () => {
      await hydrated([]);
      const err = new Error('disk full');
      failNextWrite(err);

      store().ingest([item('a')], new Set());

      expect(store().order).toEqual(['a']);
      await until(
        () => (logger.captureException as jest.Mock).mock.calls.length > 0,
        'the failed write to be reported',
      );
      expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { store: 'feed-order-store' } });
    });
  });

  describe('ingest, rep-switch dedupe', () => {
    it('updates the existing entry in place under its old id: no duplicate, position kept, fresh rep data', async () => {
      await hydrated([item('x', { score: 0.5, cluster: 'C1' })]);

      // a new representative article y for the SAME stable cluster (the group grew)
      store().ingest([item('y', { score: 0.9, cluster: 'C1' })], new Set());

      expect(store().order).toEqual(['x']);
      expect(store().itemsById.y).toBeUndefined();
      expect(store().itemsById.x.suggestion.articleId).toBe('y');
      expect(store().itemsById.x.score).toBe(0.9);
      expect(store().itemsById.x.id).toBe('x');
    });

    it('resolves a rep-switch through memberIds when the group has no stable cluster', async () => {
      await hydrated([item('x', { score: 0.5, memberIds: ['x', 'y'] })]);

      store().ingest([item('y', { score: 0.9, memberIds: ['x', 'y'] })], new Set());

      expect(store().order).toEqual(['x']);
      expect(store().itemsById.x.suggestion.articleId).toBe('y');
    });

    // Story groups are rebuilt from cluster memberships on every sync, so they SPLIT as well as merge.
    // Without the claim guards, a split-off sibling matched the surviving row through its stale
    // memberIds and overwrote it: the row's own story vanished and the sibling never got a card.
    describe('group SPLIT: a sibling must never steal a claimed row', () => {
      it('keeps the exact-id row and gives the split-off sibling its own card', async () => {
        await hydrated([item('x', { score: 0.9, memberIds: ['x', 'y'] })]);

        store().ingest(
          [item('x', { score: 0.9, memberIds: ['x'] }), item('y', { score: 0.4, memberIds: ['y'] })],
          new Set(),
        );

        expect(store().order).toEqual(['y', 'x']);
        expect(store().itemsById.x.suggestion.articleId).toBe('x');
        expect(store().itemsById.y.suggestion.articleId).toBe('y');
      });

      it('is order-independent: the sibling arriving FIRST still cannot claim the row', async () => {
        await hydrated([item('x', { score: 0.9, memberIds: ['x', 'y'] })]);

        store().ingest(
          [item('y', { score: 0.4, memberIds: ['y'] }), item('x', { score: 0.9, memberIds: ['x'] })],
          new Set(),
        );

        expect(store().order).toEqual(['y', 'x']);
        expect(store().itemsById.x.suggestion.articleId).toBe('x');
        expect(store().itemsById.y.suggestion.articleId).toBe('y');
      });

      it('two unclaimed candidates matching one row: only the first claims it', async () => {
        await hydrated([item('x', { score: 0.9, memberIds: ['x', 'p', 'q'] })]);

        // neither p nor q is an exact-id match, so both resolve to row x
        store().ingest(
          [item('p', { score: 0.8, memberIds: ['p'] }), item('q', { score: 0.3, memberIds: ['q'] })],
          new Set(),
        );

        // p takes the row in place; q becomes its own card, prepended because it is new
        expect(store().itemsById.x.suggestion.articleId).toBe('p');
        expect(store().order).toEqual(['q', 'x']);
      });
    });
  });

  describe('verdict mirror', () => {
    it('sets and paths verdicts; a flip keeps the existing path', async () => {
      await hydrated([item('a')]);
      store().setVerdict('a', 'like');
      expect(store().verdicts.a).toEqual({ verdict: 'like', path: [] });
      store().setPath('a', ['too-much']);
      expect(store().verdicts.a).toEqual({ verdict: 'like', path: ['too-much'] });
      store().setVerdict('a', 'dislike');
      expect(store().verdicts.a).toEqual({ verdict: 'dislike', path: ['too-much'] });
    });

    it('setPath is a no-op when no verdict exists', () => {
      store().setPath('ghost', ['x']);
      expect(store().verdicts.ghost).toBeUndefined();
    });

    it('clearVerdict drops the verdict and its path (the un-vote path)', () => {
      store().setVerdict('a', 'like');
      store().setPath('a', ['too-much']);
      store().clearVerdict('a');
      expect(store().verdicts.a).toBeUndefined();
    });

    it('clearVerdict is a no-op when no verdict exists', () => {
      const before = store().verdicts;
      store().clearVerdict('ghost');
      expect(store().verdicts).toBe(before);
    });

    it('setCommitted stores true only, deletes the key to unmark, and ignores an unknown verdict', () => {
      store().setCommitted('ghost', true);
      expect(store().verdicts.ghost).toBeUndefined();

      store().setVerdict('a', 'like');
      store().setCommitted('a', true);
      expect(store().verdicts.a).toEqual({ verdict: 'like', path: [], committed: true });

      store().setCommitted('a', false);
      // an uncommitted record keeps the exact shape it had before the field existed
      expect(store().verdicts.a).toEqual({ verdict: 'like', path: [] });
      expect('committed' in store().verdicts.a).toBe(false);
    });

    it('verdicts are session-only: they are not in either persisted row', async () => {
      await hydrated([item('a')]);
      store().setVerdict('a', 'like');
      store().markViewed('a', NOW);
      await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
      const card = await rowAppears(FEED_CARD_STATE_SETTING_KEY);
      expect(card).not.toContain('like');
      expect(await getSetting(FEED_ORDER_SETTING_KEY)).not.toContain('like');
    });
  });

  describe('card state, parse and persistence', () => {
    it('a device with no card-state row hydrates to an empty map and keeps the whole order (back-compat)', async () => {
      await hydrated([item('a'), item('b'), item('c')]);
      expect(store().order).toEqual(['a', 'b', 'c']);
      expect(store().cardStates).toEqual({});
    });

    it('drops malformed state entries but keeps the valid one; a malformed `tombs` does not crash or touch the order', async () => {
      await setSetting(FEED_ORDER_SETTING_KEY, orderBlob(['ok', 'short', 'badcode', 'nullat', 'inf'], 1));
      // raw literal on purpose: JSON.stringify turns Infinity into null, so a non-finite `at` can only
      // be written by hand (1e999 parses back as Infinity)
      await setSetting(
        FEED_CARD_STATE_SETTING_KEY,
        `{"states":{"ok":["s",${NOW}],"short":["s"],"badcode":["x",${NOW}],` +
          `"nullat":["v",null],"inf":["s",1e999]},"tombs":"not-an-object"}`,
      );

      await store().hydrate(['ok', 'short', 'badcode', 'nullat', 'inf'].map((id) => item(id)));

      expect(store().cardStates).toEqual({ ok: { state: 'skipped', at: NOW } });
      expect(store().order).toEqual(['ok', 'short', 'badcode', 'nullat', 'inf']);
    });

    it.each([
      ['corrupt JSON', '{not json'],
      ['a bare string', '"x"'],
      ['no states key', '{"tombs":{}}'],
      ['states that is not an object', '{"states":3}'],
    ])('a card-state row with %s hydrates to an empty map and does not wipe the order', async (_label, raw) => {
      await setSetting(FEED_CARD_STATE_SETTING_KEY, raw);
      await hydrated([item('a')]);
      expect(store().cardStates).toEqual({});
      expect(store().order).toEqual(['a']);
    });

    it('a failed card-state read hydrates nothing (both rows are read together)', async () => {
      failSettingRead(FEED_CARD_STATE_SETTING_KEY);
      await setSetting(FEED_ORDER_SETTING_KEY, orderBlob(['a'], 1));

      await store().hydrate([item('a')]);

      expect(store().hydrated).toBe(true);
      expect(store().order).toEqual([]);
      expect(logger.captureException).toHaveBeenCalled();
    });

    it('legacy blob back-compat: an old `{ states, tombs }` row parses `states`, ignores `tombs`, and has no effect on ingest', async () => {
      await setSetting(FEED_CARD_STATE_SETTING_KEY, JSON.stringify({ states: { a: ['s', NOW] }, tombs: { z: NOW } }));
      await hydrated([item('a')]);
      expect(store().cardStates).toEqual({ a: { state: 'skipped', at: NOW } });

      // the tombstone mechanism is gone: z is genuinely new and prepends
      store().ingest([item('z')], new Set());
      expect(store().order).toEqual(['z', 'a']);
    });

    it('round-trips: states serialize as [code, ms] under `states` with no `tombs`, and re-parse identically', async () => {
      await hydrated([item('a'), item('b')]);
      store().markSkipped(['a'], NOW);
      store().markViewed('b', NOW);
      await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

      const raw = await rowAppears(FEED_CARD_STATE_SETTING_KEY);
      expect(JSON.parse(raw)).toEqual({ states: { a: ['s', NOW], b: ['v', NOW] } });
      expect(raw).not.toContain('tombs');

      // a cold start: the bytes on disk, through hydrate
      resetStore(useFeedOrderStore);
      await store().hydrate([item('a'), item('b')]);
      expect(store().cardStates).toEqual({
        a: { state: 'skipped', at: NOW },
        b: { state: 'viewed', at: NOW },
      });
    });

    it('marks do not write at once; one coalesced write lands exactly at the debounce edge and the timer does not re-arm', async () => {
      await hydrated([item('a'), item('b')]);
      const writes = watchWrites(FEED_CARD_STATE_SETTING_KEY);

      store().markSkipped(['a'], NOW);
      await jest.advanceTimersByTimeAsync(DEBOUNCE_MS / 2);
      store().markViewed('b', NOW); // joins the burst, does not reset the timer
      expect(writes()).toBe(0);

      await jest.advanceTimersByTimeAsync(DEBOUNCE_MS / 2 - 1);
      await settle();
      expect(writes()).toBe(0);
      expect(await getSetting(FEED_CARD_STATE_SETTING_KEY)).toBeNull();

      await jest.advanceTimersByTimeAsync(1);
      const raw = await rowAppears(FEED_CARD_STATE_SETTING_KEY);
      expect(JSON.parse(raw)).toEqual({ states: { a: ['s', NOW], b: ['v', NOW] } }); // the burst, in one blob
      expect(writes()).toBe(1);

      await jest.advanceTimersByTimeAsync(10 * DEBOUNCE_MS);
      await settle();
      expect(writes()).toBe(1);
    });

    it('a mark after the write starts a new debounce window', async () => {
      await hydrated([item('a'), item('b')]);
      const writes = watchWrites(FEED_CARD_STATE_SETTING_KEY);
      store().markViewed('a', NOW);
      await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await rowAppears(FEED_CARD_STATE_SETTING_KEY);
      expect(writes()).toBe(1);

      store().markViewed('b', NOW + 5);
      await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await until(async () => (await getSetting(FEED_CARD_STATE_SETTING_KEY))!.includes('"b"'), 'the second blob');
      expect(writes()).toBe(2);
    });
  });

  describe('flushPersist', () => {
    it('writes a pending debounced blob at once (the app-background path) and cancels the timer', async () => {
      await hydrated([item('a')]);
      const writes = watchWrites(FEED_CARD_STATE_SETTING_KEY);
      store().markViewed('a', NOW);
      expect(writes()).toBe(0);

      store().flushPersist();

      expect(JSON.parse(await rowAppears(FEED_CARD_STATE_SETTING_KEY))).toEqual({ states: { a: ['v', NOW] } });
      await jest.advanceTimersByTimeAsync(10 * DEBOUNCE_MS);
      await settle();
      expect(writes()).toBe(1); // the timer was cancelled, not left armed
    });

    it('is a no-op when no write is pending', async () => {
      await hydrated([item('a')]);
      const writes = watchWrites(FEED_CARD_STATE_SETTING_KEY);
      store().flushPersist();
      await settle();
      expect(writes()).toBe(0);
      expect(await getSetting(FEED_CARD_STATE_SETTING_KEY)).toBeNull();
    });
  });

  describe('markSkipped', () => {
    it('stamps `skipped` at the given clock', async () => {
      await hydrated([item('a')]);
      store().markSkipped(['a'], NOW);
      expect(store().cardStates.a).toEqual({ state: 'skipped', at: NOW });
    });

    it('stamps the current time when no clock is given', async () => {
      await hydrated([item('a')]);
      await jest.advanceTimersByTimeAsync(3 * MIN);
      store().markSkipped(['a']);
      expect(store().cardStates.a).toEqual({ state: 'skipped', at: NOW + 3 * MIN });
    });

    it('is WRITE-ONCE: a second pass does not restamp `at`', async () => {
      await hydrated([item('a')]);
      store().markSkipped(['a'], NOW);
      store().markSkipped(['a'], NOW + 5 * MIN);
      expect(store().cardStates.a).toEqual({ state: 'skipped', at: NOW });
    });

    it('never downgrades a `viewed` card', async () => {
      await hydrated([item('a')]);
      store().markViewed('a', NOW);
      store().markSkipped(['a'], NOW + MIN);
      expect(store().cardStates.a).toEqual({ state: 'viewed', at: NOW });
    });

    it('ignores ids that are not laid out', async () => {
      await hydrated([item('a')]);
      store().markSkipped(['ghost', 'a'], NOW);
      expect(store().cardStates).toEqual({ a: { state: 'skipped', at: NOW } });
    });

    it('is a no-op before hydrate', () => {
      useFeedOrderStore.setState({ order: ['a'] });
      store().markSkipped(['a'], NOW);
      expect(store().cardStates).toEqual({});
    });

    it('does not notify subscribers when nothing changed', async () => {
      await hydrated([item('a')]);
      store().markSkipped(['a'], NOW);
      const listener = jest.fn();
      const unsubscribe = useFeedOrderStore.subscribe(listener);

      store().markSkipped(['a'], NOW + MIN); // already skipped (write-once)
      store().markSkipped(['ghost'], NOW); // not laid out
      store().markSkipped([], NOW); // empty batch

      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });
  });

  describe('markViewed', () => {
    it('upgrades `skipped` to `viewed` with a fresh stamp', async () => {
      await hydrated([item('a')]);
      store().markSkipped(['a'], NOW);
      store().markViewed('a', NOW + 2 * MIN);
      expect(store().cardStates.a).toEqual({ state: 'viewed', at: NOW + 2 * MIN });
    });

    it('is idempotent once `viewed`: keeps the first stamp', async () => {
      await hydrated([item('a')]);
      store().markViewed('a', NOW);
      store().markViewed('a', NOW + 5 * MIN);
      expect(store().cardStates.a).toEqual({ state: 'viewed', at: NOW });
    });

    it('ignores an id that is not laid out, and does nothing before hydrate', async () => {
      store().markViewed('a', NOW); // unhydrated
      expect(store().cardStates).toEqual({});
      await hydrated([item('a')]);
      store().markViewed('ghost', NOW);
      expect(store().cardStates).toEqual({});
    });
  });

  describe('removeIds', () => {
    it('drops exactly the given ids from the order and the rows, and persists the order', async () => {
      await hydrated([item('a'), item('b'), item('c')], ['a', 'b', 'c'], 8);

      store().removeIds(['b', 'zzz']);

      expect(store().order).toEqual(['a', 'c']);
      expect(Object.keys(store().itemsById).sort()).toEqual(['a', 'c']);
      await rowIs(FEED_ORDER_SETTING_KEY, '{"order":["a","c"],"builtAt":8}');
    });

    it('remembers nothing: a removed id is laid out again by the next ingest', async () => {
      await hydrated([item('a'), item('b')]);
      store().removeIds(['b']);
      store().ingest([item('a'), item('b')], new Set());
      expect(store().order).toEqual(['b', 'a']);
    });

    it('writes nothing when no listed id is laid out, or for an empty list', async () => {
      await hydrated([item('a')], ['a'], 8);
      store().removeIds(['zzz']);
      store().removeIds([]);
      await settle();
      expect(await getSetting(FEED_ORDER_SETTING_KEY)).toBe(orderBlob(['a'], 8));
    });
  });

  describe('reset', () => {
    it('clears state, deletes BOTH rows and leaves the store hydrated-and-empty', async () => {
      await hydrated([item('a'), item('b')]);
      store().setVerdict('a', 'like');
      store().markSkipped(['a'], NOW);
      store().flushPersist();
      await rowAppears(FEED_CARD_STATE_SETTING_KEY);

      store().reset();
      await runDueTimers(); // the deletes are queued behind each other

      const s = store();
      expect(s.order).toEqual([]);
      expect(s.itemsById).toEqual({});
      expect(s.verdicts).toEqual({});
      expect(s.cardStates).toEqual({});
      expect(s.builtAt).toBeNull();
      expect(s.hydrateStats).toBeNull();
      // HYDRATED-AND-EMPTY: ingest must not be gated off after a clear
      expect(s.hydrated).toBe(true);
      await rowIs(FEED_ORDER_SETTING_KEY, null);
      await rowIs(FEED_CARD_STATE_SETTING_KEY, null);
    });

    it('a following ingest repopulates with no remount and no re-hydrate, and a stray hydrate cannot resurrect the old order', async () => {
      await hydrated([item('a'), item('b')], ['a', 'b'], 5);
      store().reset();
      expect(store().order).toEqual([]);
      await rowIs(FEED_ORDER_SETTING_KEY, null);

      store().ingest([item('c'), item('d')], new Set());
      expect([...store().order].sort()).toEqual(['c', 'd']);

      await store().hydrate([item('a'), item('b')]);
      expect([...store().order].sort()).toEqual(['c', 'd']);
    });

    it('cancels a pending debounced persist, so nothing re-writes the blob after the delete', async () => {
      await hydrated([item('a')]);
      const writes = watchWrites(FEED_CARD_STATE_SETTING_KEY);
      store().markViewed('a', NOW); // arms the 1s trailing timer
      expect(store().cardStates.a).toEqual({ state: 'viewed', at: NOW });

      store().reset();
      await jest.advanceTimersByTimeAsync(10 * DEBOUNCE_MS);
      await settle();

      expect(writes()).toBe(0);
      expect(await getSetting(FEED_CARD_STATE_SETTING_KEY)).toBeNull();
    });

    it('a failed delete is reported and the store is still empty and hydrated', async () => {
      await hydrated([item('a')]);
      const err = new Error('disk full');
      failNextWrite(err);

      store().reset();

      expect(store().order).toEqual([]);
      expect(store().hydrated).toBe(true);
      await until(
        () => (logger.captureException as jest.Mock).mock.calls.length > 0,
        'the failed delete to be reported',
      );
      expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { store: 'feed-order-store' } });
    });
  });
});
