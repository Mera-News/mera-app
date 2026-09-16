// fact-choice-actions — the store/durable write half of per-group resolution.
//
// The concurrency test is the point of this file. Two cards resolving into the
// SAME blob is the normal case (that is what "several facts in one turn" means),
// so a merge that reads a captured render-time value instead of the live store
// silently drops whichever resolution lost the race. It compiles, it type-checks
// and it looks right in a single-card test.

const mockPatch = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/database/services/conversation-service', () => ({
  patchMessageToolCallResult: (...args: unknown[]) => mockPatch(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let mockStoreResults: Record<string, Record<string, unknown>> = {};
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: {
    getState: () => ({
      toolCallResults: mockStoreResults,
      setToolCallResult: (key: string, result: Record<string, unknown>) => {
        mockStoreResults = { ...mockStoreResults, [key]: result };
      },
    }),
  },
}));

import {
  factChoiceGroupId,
  readGroupResolutions,
  unresolvedGroups,
} from '@/lib/chat-tools/fact-choice-resolution';
import { resolveGroup, resolveGroups } from '../fact-choice-actions';

const KEY = 'msg-1::0';
const OPTIONS = [['Lives in Hoorn'], ['Works as a farmer'], ['Parents in Malaga']];

function seed() {
  mockStoreResults = {
    [KEY]: {
      success: true,
      staged: true,
      factsSaved: 0,
      savedFacts: [],
      conflicts: [],
      groupResolutions: {},
      pendingFacts: OPTIONS.map((options, index) => ({
        index,
        groupId: factChoiceGroupId(index, options),
        options,
        questionnaireAttribute: null,
      })),
    },
  };
}

const gid = (i: number) => factChoiceGroupId(i, OPTIONS[i]);
const saved = (i: number) => ({
  status: 'saved' as const,
  statements: OPTIONS[i],
  savedFacts: [{ id: `f${i}`, statement: OPTIONS[i][0] }],
  conflicts: [],
});

beforeEach(() => {
  seed();
  mockPatch.mockClear();
});

describe('resolveGroup', () => {
  it('resolves only the group it names', () => {
    resolveGroup(KEY, gid(1), saved(1));
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([0, 2]);
  });

  it('CONCURRENCY: a second resolve keeps the first, reading the live store', () => {
    // Deliberately interleaved the way two taps interleave: each call re-reads
    // the store rather than a value captured before the first write.
    resolveGroup(KEY, gid(0), saved(0));
    resolveGroup(KEY, gid(2), saved(2));

    const resolutions = readGroupResolutions(mockStoreResults[KEY]) ?? {};
    expect(Object.keys(resolutions).sort()).toEqual([gid(0), gid(2)].sort());
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([1]);
  });

  it('writes the durable half once per call, at the right message and index', () => {
    resolveGroup(KEY, gid(0), saved(0));
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch.mock.calls[0][0]).toBe('msg-1');
    expect(mockPatch.mock.calls[0][1]).toBe(0);
    // The durable blob must be the MERGED one, not just this group's entry.
    expect(mockPatch.mock.calls[0][2]).toEqual(mockStoreResults[KEY]);
  });

  it('a rejected durable write never throws into the tap', () => {
    mockPatch.mockRejectedValueOnce(new Error('no row yet'));
    expect(() => resolveGroup(KEY, gid(0), saved(0))).not.toThrow();
    // A missing message row is not an error: the assistant message persists only
    // when the turn finalises, so a fast tap legitimately lands first.
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([1, 2]);
  });

  it('undo removes the entry and returns the group to pending', () => {
    resolveGroup(KEY, gid(0), {
      status: 'dismissed',
      options: OPTIONS[0],
      questionnaireAttribute: null,
    });
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([1, 2]);

    resolveGroup(KEY, gid(0), undefined);
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([0, 1, 2]);
  });
});

describe('resolveGroups', () => {
  it('resolves every group in ONE store write and ONE durable patch', () => {
    resolveGroups(
      KEY,
      [0, 1, 2].map((i) => ({ groupId: gid(i), resolution: saved(i) })),
    );
    expect(unresolvedGroups(mockStoreResults[KEY])).toHaveLength(0);
    // N calls would be N patches and N re-renders for one tap.
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it('fires the fully-resolved rewrite exactly once, at the end', () => {
    resolveGroups(
      KEY,
      [0, 1, 2].map((i) => ({ groupId: gid(i), resolution: saved(i) })),
    );
    const blob = mockStoreResults[KEY];
    // An older bundle after a rollback must read this as done, with nothing
    // left to re-offer.
    expect(blob.pendingFacts).toBeUndefined();
    expect(blob.factsSaved).toBe(3);
    expect(blob.savedFacts).toHaveLength(3);
  });

  it('skip-all dismisses every group without saving anything', () => {
    resolveGroups(
      KEY,
      [0, 1, 2].map((i) => ({
        groupId: gid(i),
        resolution: {
          status: 'dismissed' as const,
          options: OPTIONS[i],
          questionnaireAttribute: null,
        },
      })),
    );
    expect(unresolvedGroups(mockStoreResults[KEY])).toHaveLength(0);
    expect(mockStoreResults[KEY].factsSaved).toBe(0);
    expect(mockStoreResults[KEY].savedFacts).toEqual([]);
  });

  it('preserves a group resolved EARLIER by a single tap', () => {
    resolveGroup(KEY, gid(1), saved(1));
    // The bulk row only ever carries the groups still pending.
    resolveGroups(
      KEY,
      [0, 2].map((i) => ({ groupId: gid(i), resolution: saved(i) })),
    );
    const resolutions = readGroupResolutions(mockStoreResults[KEY]) ?? {};
    expect(Object.keys(resolutions)).toHaveLength(3);
    expect(mockStoreResults[KEY].savedFacts).toHaveLength(3);
  });
});
