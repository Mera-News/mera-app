// feedback-tree-service at its seam: the real settings service on the in-memory DB, the real
// Apollo client against MSW. Read path: memo -> persisted cache -> bundled snapshot. Refresh path:
// throttled, version-checked, schema-gated. Replaces lib/services/__tests__/feedback-tree-service.test.ts.
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import * as settingService from '@/lib/database/services/setting-service';
import {
  getFeedbackTree,
  refreshFeedbackTree,
  resetFeedbackTreeMemo,
} from '@/lib/services/feedback-tree-service';
import { APP_FEEDBACK_SCHEMA, BUNDLED_FEEDBACK_TREE } from '@/lib/services/feedback-tree-snapshot';
import { mockGqlError, server } from '@/test/helpers';
import { failTransport, resetNetworkMemory, serve, spyLogger, underClock } from './kit';

const KEY_JSON = 'feedback_tree.json';
const KEY_VERSION = 'feedback_tree.version';
const KEY_FETCHED_AT = 'feedback_tree.fetched_at';
const DAY_MS = 24 * 60 * 60 * 1000;

let log: ReturnType<typeof spyLogger>;
beforeEach(() => {
  resetNetworkMemory();
  resetFeedbackTreeMemo();
  log = spyLogger();
});
afterEach(() => log.restore());

/** A minimal but valid server tree JSON. */
const serverTree = (version: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version,
    root: [{ id: 'x', labelKey: 'k', labelDefault: 'X', leaf: { seenOnly: true } }],
    ...extra,
  });

const likeRoot = [{ id: 'like_x', labelKey: 'k', labelDefault: 'X', leaf: { openChat: true } }];

/** Answers FeedbackTree and records the variables of each request. */
function serveTree(resp: { version: number; minAppSchema: number; treeJson: string } | null) {
  return serve('FeedbackTree', () => ({
    feedbackTree: resp && { __typename: 'FeedbackTree', updatedAt: 'now', ...resp },
  }));
}

describe('getFeedbackTree', () => {
  it('falls back to the bundled tree when nothing is cached', async () => {
    expect(await getFeedbackTree()).toBe(BUNDLED_FEEDBACK_TREE);
  });

  it('returns the cached tree when a valid one is persisted', async () => {
    await setSetting(KEY_JSON, serverTree(2));
    expect((await getFeedbackTree()).version).toBe(2);
  });

  it('answers from the memo: a later change to the persisted row is not re-read', async () => {
    await setSetting(KEY_JSON, serverTree(2));
    expect((await getFeedbackTree()).version).toBe(2);

    await setSetting(KEY_JSON, serverTree(3));
    expect((await getFeedbackTree()).version).toBe(2);

    resetFeedbackTreeMemo();
    expect((await getFeedbackTree()).version).toBe(3);
  });

  it('memoises the bundled fallback too: a cache row written afterwards waits for a memo reset', async () => {
    expect(await getFeedbackTree()).toBe(BUNDLED_FEEDBACK_TREE);
    await setSetting(KEY_JSON, serverTree(2));
    expect(await getFeedbackTree()).toBe(BUNDLED_FEEDBACK_TREE);
  });

  it('falls back to bundled when the cached JSON is corrupt', async () => {
    await setSetting(KEY_JSON, '{not json');
    expect(await getFeedbackTree()).toBe(BUNDLED_FEEDBACK_TREE);
  });

  it('logs a corrupt cache row under the cache tag', async () => {
    await setSetting(KEY_JSON, '{not json');
    await getFeedbackTree();
    expect(log.captureException).toHaveBeenCalledWith(
      expect.any(SyntaxError),
      expect.objectContaining({ tags: { service: 'feedback-tree-service', method: 'getFeedbackTree.cache' } }),
    );
  });

  it('falls back to bundled and logs when the settings read itself fails', async () => {
    const read = jest.spyOn(settingService, 'getSetting').mockRejectedValueOnce(new Error('db down'));
    expect(await getFeedbackTree()).toBe(BUNDLED_FEEDBACK_TREE);
    expect(log.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'db down' }),
      expect.objectContaining({ tags: { service: 'feedback-tree-service', method: 'getFeedbackTree.cache' } }),
    );
    read.mockRestore();
  });

  it.each([
    ['a version that is not a number', JSON.stringify({ version: '2', root: [] })],
    ['a root that is not an array', JSON.stringify({ version: 2, root: {} })],
    ['a root node without an id', JSON.stringify({ version: 2, root: [{ labelKey: 'k' }] })],
    ['JSON null', 'null'],
    ['a bare number', '7'],
  ])('falls back to bundled for %s', async (_name, json) => {
    await setSetting(KEY_JSON, json);
    expect(await getFeedbackTree()).toBe(BUNDLED_FEEDBACK_TREE);
  });

  it('accepts a cached tree carrying a valid likeRoot', async () => {
    await setSetting(KEY_JSON, serverTree(2, { likeRoot }));
    expect((await getFeedbackTree()).likeRoot).toEqual(likeRoot);
  });

  it('falls back to bundled when the cached likeRoot is malformed', async () => {
    // likeRoot present but not an array of valid nodes (missing `id`).
    await setSetting(KEY_JSON, serverTree(2, { likeRoot: [{ labelKey: 'k', labelDefault: 'X' }] }));
    expect(await getFeedbackTree()).toBe(BUNDLED_FEEDBACK_TREE);
  });
});

describe('refreshFeedbackTree', () => {
  it('persists a newer tree, stamps the version and updates the memo', async () => {
    serveTree({ version: 2, minAppSchema: 1, treeJson: serverTree(2) });

    await refreshFeedbackTree({ force: true });

    expect(await getSetting(KEY_JSON)).toBe(serverTree(2));
    expect(await getSetting(KEY_VERSION)).toBe('2');
    // memo updated: the next read is the new tree without touching the row
    expect((await getFeedbackTree()).version).toBe(2);
  });

  it('replaces a cached tree with a newer server tree and sends the cached version', async () => {
    await setSetting(KEY_JSON, serverTree(2));
    await setSetting(KEY_VERSION, '2');
    expect((await getFeedbackTree()).version).toBe(2);
    const seen = serveTree({ version: 3, minAppSchema: 1, treeJson: serverTree(3) });

    await refreshFeedbackTree({ force: true });

    expect(seen).toEqual([{ currentVersion: 2 }]);
    expect(await getSetting(KEY_JSON)).toBe(serverTree(3));
    expect(await getSetting(KEY_VERSION)).toBe('3');
    expect((await getFeedbackTree()).version).toBe(3);
  });

  it('sends a null current version when nothing is cached', async () => {
    const seen = serveTree(null);
    await refreshFeedbackTree({ force: true });
    expect(seen).toEqual([{ currentVersion: null }]);
  });

  it('sends the cached version and no-ops on not-modified (empty treeJson)', async () => {
    await setSetting(KEY_VERSION, '5');
    const seen = serveTree({ version: 5, minAppSchema: 1, treeJson: '' });

    await refreshFeedbackTree({ force: true });

    expect(seen).toEqual([{ currentVersion: 5 }]);
    // not-modified: never rewrites the tree JSON
    expect(await getSetting(KEY_JSON)).toBeNull();
  });

  it('DROPS a tree that needs a newer app schema than we support', async () => {
    serveTree({ version: 9, minAppSchema: 99, treeJson: serverTree(9) });

    await refreshFeedbackTree({ force: true });

    expect(await getSetting(KEY_JSON)).toBeNull();
    expect(await getSetting(KEY_VERSION)).toBeNull();
    expect(await getFeedbackTree()).toBe(BUNDLED_FEEDBACK_TREE);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('minAppSchema=99'));
  });

  it('keeps a cached tree when the server tree needs a newer app schema', async () => {
    await setSetting(KEY_JSON, serverTree(2));
    await setSetting(KEY_VERSION, '2');
    serveTree({ version: 9, minAppSchema: APP_FEEDBACK_SCHEMA + 1, treeJson: serverTree(9) });

    await refreshFeedbackTree({ force: true });

    expect(await getSetting(KEY_JSON)).toBe(serverTree(2));
    expect((await getFeedbackTree()).version).toBe(2);
  });

  it('ACCEPTS a tree whose minAppSchema exactly equals the app schema', async () => {
    const json = serverTree(2, { likeRoot });
    serveTree({ version: 2, minAppSchema: APP_FEEDBACK_SCHEMA, treeJson: json });

    await refreshFeedbackTree({ force: true });

    expect(await getSetting(KEY_JSON)).toBe(json);
    const tree = await getFeedbackTree();
    expect(tree.version).toBe(2);
    expect(tree.likeRoot).toHaveLength(1);
  });

  // Pins APP_FEEDBACK_SCHEMA itself: the live server tree (v3) publishes minAppSchema 4, which
  // behaves differently at 3 and at 4. Every other case here is indifferent to a botched bump.
  it('ACCEPTS a tree requiring app schema 4 (the desc-carrying server tree)', async () => {
    serveTree({ version: 3, minAppSchema: 4, treeJson: serverTree(3) });

    await refreshFeedbackTree({ force: true });

    expect(await getSetting(KEY_JSON)).toBe(serverTree(3));
    expect((await getFeedbackTree()).version).toBe(3);
  });

  // Pinned to APP_FEEDBACK_SCHEMA + 1 rather than a literal: this is about the COMPARISON, and a
  // hard-coded number stops exercising the drop path the moment the app schema catches up.
  it('DROPS a tree requiring one schema past what this app understands', async () => {
    serveTree({ version: 999, minAppSchema: APP_FEEDBACK_SCHEMA + 1, treeJson: serverTree(999) });

    await refreshFeedbackTree({ force: true });

    expect(await getSetting(KEY_JSON)).toBeNull();
    expect(await getFeedbackTree()).toBe(BUNDLED_FEEDBACK_TREE);
  });

  it('rejects (does not persist) a server tree with a malformed likeRoot', async () => {
    serveTree({ version: 2, minAppSchema: 2, treeJson: serverTree(2, { likeRoot: 'not-an-array' }) });

    await refreshFeedbackTree({ force: true });

    expect(await getSetting(KEY_JSON)).toBeNull();
    expect(await getFeedbackTree()).toBe(BUNDLED_FEEDBACK_TREE);
  });

  it('keeps bundled/cached when the server is unseeded (null response), and still throttles', async () => {
    serveTree(null);

    await refreshFeedbackTree({ force: true });

    expect(await getSetting(KEY_JSON)).toBeNull();
    expect(Number(await getSetting(KEY_FETCHED_AT))).toBeGreaterThan(0);
  });

  it('logs and persists nothing for a treeJson that is not JSON', async () => {
    serveTree({ version: 2, minAppSchema: 1, treeJson: '{not json' });

    await expect(refreshFeedbackTree({ force: true })).resolves.toBeUndefined();

    expect(await getSetting(KEY_JSON)).toBeNull();
    expect(log.captureException).toHaveBeenCalledWith(
      expect.any(SyntaxError),
      expect.objectContaining({ tags: { service: 'feedback-tree-service', method: 'refreshFeedbackTree' } }),
    );
  });

  it('swallows a GraphQL error, logs it and leaves the throttle stamp unset so the next open retries', async () => {
    server.use(mockGqlError('FeedbackTree', 'INTERNAL_SERVER_ERROR', { message: 'offline' }));

    await expect(refreshFeedbackTree({ force: true })).resolves.toBeUndefined();

    expect(await getSetting(KEY_FETCHED_AT)).toBeNull();
    expect(log.captureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: { service: 'feedback-tree-service', method: 'refreshFeedbackTree' } }),
    );
  });

  it('swallows a transport failure (offline) with no throw', async () => {
    server.use(failTransport('FeedbackTree'));
    await expect(underClock(() => refreshFeedbackTree({ force: true }))).resolves.toBeUndefined();
    expect(await getSetting(KEY_JSON)).toBeNull();
  });

  describe('the 24h throttle', () => {
    it('skips the request when the last check was recent', async () => {
      await setSetting(KEY_FETCHED_AT, String(Date.now()));
      const seen = serveTree({ version: 2, minAppSchema: 1, treeJson: serverTree(2) });

      await refreshFeedbackTree();

      expect(seen).toEqual([]);
      expect(await getSetting(KEY_JSON)).toBeNull();
    });

    it('asks again once the last check is a day old', async () => {
      await setSetting(KEY_FETCHED_AT, String(Date.now() - DAY_MS - 1000));
      const seen = serveTree({ version: 2, minAppSchema: 1, treeJson: serverTree(2) });

      await refreshFeedbackTree();

      expect(seen).toHaveLength(1);
      expect(await getSetting(KEY_JSON)).toBe(serverTree(2));
    });

    it('asks on the first run, when there is no stamp', async () => {
      const seen = serveTree(null);
      await refreshFeedbackTree();
      expect(seen).toHaveLength(1);
    });

    it('force overrides a recent stamp', async () => {
      await setSetting(KEY_FETCHED_AT, String(Date.now()));
      const seen = serveTree(null);
      await refreshFeedbackTree({ force: true });
      expect(seen).toHaveLength(1);
    });

    it('stamps the check even when the tree is dropped, so a bad tree is not re-fetched all day', async () => {
      serveTree({ version: 9, minAppSchema: 99, treeJson: serverTree(9) });
      await refreshFeedbackTree({ force: true });
      const seen = serveTree(null);

      await refreshFeedbackTree();

      expect(seen).toEqual([]);
    });
  });
});
