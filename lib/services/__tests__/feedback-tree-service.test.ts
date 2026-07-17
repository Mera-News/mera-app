// feedback-tree-service unit tests — the cached/version-checked/bundled read
// path and the schema-gated refresh path. apollo-client + setting-service KV are
// mocked so we can drive server responses and cache state directly.

const mockGetSetting = jest.fn((..._a: any[]): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((..._a: any[]): Promise<void> => Promise.resolve());
const mockQuery = jest.fn();

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
  setSetting: (...a: unknown[]) => mockSetSetting(...a),
}));
jest.mock('@/lib/apollo-client', () => ({
  __esModule: true,
  default: { query: (...a: unknown[]) => mockQuery(...a) },
}));

import {
  getFeedbackTree,
  refreshFeedbackTree,
  resetFeedbackTreeMemo,
} from '../feedback-tree-service';
import { BUNDLED_FEEDBACK_TREE } from '../feedback-tree-snapshot';

const KEY_JSON = 'feedback_tree.json';
const KEY_VERSION = 'feedback_tree.version';
const KEY_FETCHED_AT = 'feedback_tree.fetched_at';

/** A minimal but valid server tree JSON (version 2). */
const serverTree = (version: number) =>
  JSON.stringify({
    version,
    root: [{ id: 'x', labelKey: 'k', labelDefault: 'X', leaf: { seenOnly: true } }],
  });

beforeEach(() => {
  jest.clearAllMocks();
  resetFeedbackTreeMemo();
});

describe('getFeedbackTree', () => {
  it('falls back to the bundled tree when nothing is cached', async () => {
    mockGetSetting.mockResolvedValue(null);
    const tree = await getFeedbackTree();
    expect(tree).toBe(BUNDLED_FEEDBACK_TREE);
  });

  it('returns the cached tree when a valid one is persisted', async () => {
    mockGetSetting.mockImplementation((key: string) =>
      Promise.resolve(key === KEY_JSON ? serverTree(2) : null),
    );
    const tree = await getFeedbackTree();
    expect(tree.version).toBe(2);
  });

  it('falls back to bundled when the cached JSON is corrupt', async () => {
    mockGetSetting.mockImplementation((key: string) =>
      Promise.resolve(key === KEY_JSON ? '{not json' : null),
    );
    const tree = await getFeedbackTree();
    expect(tree).toBe(BUNDLED_FEEDBACK_TREE);
  });
});

describe('refreshFeedbackTree', () => {
  it('persists a newer tree and stamps the version', async () => {
    mockGetSetting.mockResolvedValue(null); // no cache, no throttle
    mockQuery.mockResolvedValue({
      data: { feedbackTree: { version: 2, minAppSchema: 1, updatedAt: 'now', treeJson: serverTree(2) } },
    });

    await refreshFeedbackTree({ force: true });

    expect(mockSetSetting).toHaveBeenCalledWith(KEY_JSON, serverTree(2));
    expect(mockSetSetting).toHaveBeenCalledWith(KEY_VERSION, '2');
    // memo updated → next read is the new tree
    expect((await getFeedbackTree()).version).toBe(2);
  });

  it('sends the cached version and no-ops on not-modified (empty treeJson)', async () => {
    mockGetSetting.mockImplementation((key: string) =>
      Promise.resolve(key === KEY_VERSION ? '5' : null),
    );
    mockQuery.mockResolvedValue({
      data: { feedbackTree: { version: 5, minAppSchema: 1, updatedAt: 'now', treeJson: '' } },
    });

    await refreshFeedbackTree({ force: true });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { currentVersion: 5 } }),
    );
    // not-modified → never rewrites the tree JSON
    expect(mockSetSetting).not.toHaveBeenCalledWith(KEY_JSON, expect.anything());
  });

  it('DROPS a tree that needs a newer app schema than we support', async () => {
    mockGetSetting.mockResolvedValue(null);
    mockQuery.mockResolvedValue({
      data: { feedbackTree: { version: 9, minAppSchema: 99, updatedAt: 'now', treeJson: serverTree(9) } },
    });

    await refreshFeedbackTree({ force: true });

    expect(mockSetSetting).not.toHaveBeenCalledWith(KEY_JSON, expect.anything());
    expect((await getFeedbackTree())).toBe(BUNDLED_FEEDBACK_TREE);
  });

  it('keeps bundled/cached when the server is unseeded (null response)', async () => {
    mockGetSetting.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ data: { feedbackTree: null } });

    await refreshFeedbackTree({ force: true });

    expect(mockSetSetting).not.toHaveBeenCalledWith(KEY_JSON, expect.anything());
    // still stamps fetched-at to throttle
    expect(mockSetSetting).toHaveBeenCalledWith(KEY_FETCHED_AT, expect.any(String));
  });

  it('swallows network errors (offline) — no throw', async () => {
    mockGetSetting.mockResolvedValue(null);
    mockQuery.mockRejectedValue(new Error('offline'));
    await expect(refreshFeedbackTree({ force: true })).resolves.toBeUndefined();
  });

  it('respects the 24h throttle unless forced', async () => {
    mockGetSetting.mockImplementation((key: string) =>
      Promise.resolve(key === KEY_FETCHED_AT ? String(Date.now()) : null),
    );
    await refreshFeedbackTree();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
