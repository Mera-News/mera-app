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

const mockCommit = jest.fn(async () => ({ savedFacts: [{ id: 'f9', statement: 'Lives in Zzqq' }], conflicts: [] }));
jest.mock('@/lib/chat-tools/fact-commit', () => ({
  commitFactChoices: (...a: unknown[]) => mockCommit(...(a as [])),
}));

const mockDelete = jest.fn(async () => ({ success: true, deletedCount: 1, deletedStatements: ['Lives in Porto'] }));
jest.mock('@/lib/chat-tools/tool-handlers', () => ({
  handleDeleteUserFacts: (...a: unknown[]) => mockDelete(...(a as [])),
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
  readPendingGroups,
  unresolvedGroups,
} from '@/lib/chat-tools/fact-choice-resolution';
import { commitSaveAsWritten, resolveGroup, resolveGroups } from '../fact-choice-actions';

const KEY = 'msg-1::0';
const OPTIONS = [['Lives in Hoorn'], ['Works as a farmer'], ['Parents in Malaga']];

// THE DEVICE CONDITION: the store starts EMPTY. The staged blob lives on
// `message.toolCalls[idx].result`, and nothing copies it into `toolCallResults`
// — that map holds OVERRIDES only. The original suite seeded the store with the
// staged blob, which is why it stayed green while the device lost every card on
// the first tap: merging into `undefined` produced an empty spine and the
// deriver then emitted nothing at all.
const STAGED: Record<string, unknown> = {
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
};

function seed() {
  mockStoreResults = {};
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
  // The device failure, reduced. On the FIRST tap of a turn there is no entry at
  // resultKey, so the merge has to fall back to the staged result. Without that
  // it merged into `undefined`, computed an empty spine, and wrote back a blob
  // with `pendingFacts: []` — which the deriver applies as the WHOLE result,
  // finding zero groups and emitting zero cards. Every card in the turn vanished
  // on one tap, and the fact was still saved because the commit ran first.
  it('DEVICE REPRO: first tap on an EMPTY store keeps the whole spine', () => {
    expect(mockStoreResults[KEY]).toBeUndefined();

    resolveGroup(KEY, gid(1), saved(1), STAGED);

    const blob = mockStoreResults[KEY];
    expect(readPendingGroups(blob)).toHaveLength(3);
    expect(unresolvedGroups(blob).map((g) => g.index)).toEqual([0, 2]);
    expect(blob.pendingFacts).toHaveLength(3);
  });

  it('DEVICE REPRO: first Skip on an EMPTY store keeps the whole spine', () => {
    resolveGroup(
      KEY,
      gid(0),
      { status: 'dismissed', options: OPTIONS[0], questionnaireAttribute: null },
      STAGED,
    );
    expect(readPendingGroups(mockStoreResults[KEY])).toHaveLength(3);
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([1, 2]);
  });

  it('DEVICE REPRO: first Add all on an EMPTY store resolves all three', () => {
    resolveGroups(
      KEY,
      [0, 1, 2].map((i) => ({ groupId: gid(i), resolution: saved(i) })),
      STAGED,
    );
    expect(readPendingGroups(mockStoreResults[KEY])).toHaveLength(3);
    expect(unresolvedGroups(mockStoreResults[KEY])).toHaveLength(0);
    expect(mockStoreResults[KEY].savedFacts).toHaveLength(3);
  });

  it('resolves only the group it names', () => {
    resolveGroup(KEY, gid(1), saved(1), STAGED);
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([0, 2]);
  });

  it('CONCURRENCY: a second resolve keeps the first, reading the live store', () => {
    // Deliberately interleaved the way two taps interleave: each call re-reads
    // the store rather than a value captured before the first write.
    resolveGroup(KEY, gid(0), saved(0), STAGED);
    resolveGroup(KEY, gid(2), saved(2), STAGED);

    const resolutions = readGroupResolutions(mockStoreResults[KEY]) ?? {};
    expect(Object.keys(resolutions).sort()).toEqual([gid(0), gid(2)].sort());
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([1]);
  });

  it('writes the durable half once per call, at the right message and index', () => {
    resolveGroup(KEY, gid(0), saved(0), STAGED);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch.mock.calls[0][0]).toBe('msg-1');
    expect(mockPatch.mock.calls[0][1]).toBe(0);
    // The durable blob must be the MERGED one, not just this group's entry.
    expect(mockPatch.mock.calls[0][2]).toEqual(mockStoreResults[KEY]);
  });

  it('a rejected durable write never throws into the tap', () => {
    mockPatch.mockRejectedValueOnce(new Error('no row yet'));
    expect(() => resolveGroup(KEY, gid(0), saved(0), STAGED)).not.toThrow();
    // A missing message row is not an error: the assistant message persists only
    // when the turn finalises, so a fast tap legitimately lands first.
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([1, 2]);
  });

  it('undo removes the entry and returns the group to pending', () => {
    resolveGroup(KEY, gid(0), {
      status: 'dismissed',
      options: OPTIONS[0],
      questionnaireAttribute: null,
    }, STAGED);
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([1, 2]);

    resolveGroup(KEY, gid(0), undefined, STAGED);
    expect(unresolvedGroups(mockStoreResults[KEY]).map((g) => g.index)).toEqual([0, 1, 2]);
  });
});

describe('resolveGroups', () => {
  it('resolves every group in ONE store write and ONE durable patch', () => {
    resolveGroups(
      KEY,
      [0, 1, 2].map((i) => ({ groupId: gid(i), resolution: saved(i) })),
      STAGED,
    );
    expect(unresolvedGroups(mockStoreResults[KEY])).toHaveLength(0);
    // N calls would be N patches and N re-renders for one tap.
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it('fires the fully-resolved rewrite exactly once, at the end', () => {
    resolveGroups(
      KEY,
      [0, 1, 2].map((i) => ({ groupId: gid(i), resolution: saved(i) })),
      STAGED,
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
      STAGED,
    );
    expect(unresolvedGroups(mockStoreResults[KEY])).toHaveLength(0);
    expect(mockStoreResults[KEY].factsSaved).toBe(0);
    expect(mockStoreResults[KEY].savedFacts).toEqual([]);
  });

  it('preserves a group resolved EARLIER by a single tap', () => {
    resolveGroup(KEY, gid(1), saved(1), STAGED);
    // The bulk row only ever carries the groups still pending.
    resolveGroups(
      KEY,
      [0, 2].map((i) => ({ groupId: gid(i), resolution: saved(i) })),
      STAGED,
    );
    const resolutions = readGroupResolutions(mockStoreResults[KEY]) ?? {};
    expect(Object.keys(resolutions)).toHaveLength(3);
    expect(mockStoreResults[KEY].savedFacts).toHaveLength(3);
  });
});

describe('ux2 D9: commitSaveAsWritten', () => {
  beforeEach(() => {
    mockStoreResults = {};
    mockCommit.mockClear();
    mockPatch.mockClear();
  });

  it('commits the sentence with its key and skill, and records the saved fact on the offering call', async () => {
    const base = { saveAsWritten: { statement: 'Lives in Zzqq' } };
    await commitSaveAsWritten({
      resultKey: 'a1::2',
      baseResult: base,
      entry: {
        statement: 'Lives in Zzqq',
        questionnaire_attribute: 'location: neighborhood/area, city, and country (preserve specifics)',
        topic_skill_id: 'topics/residence',
      },
    });
    expect(mockCommit).toHaveBeenCalledWith([
      {
        statement: 'Lives in Zzqq',
        questionnaire: { attribute: 'location: neighborhood/area, city, and country (preserve specifics)' },
        skillId: 'topics/residence',
      },
    ]);
    expect(mockStoreResults['a1::2']).toEqual({ ...base, saveAsWrittenSaved: [{ id: 'f9', statement: 'Lives in Zzqq' }] });
    expect(mockPatch).toHaveBeenCalledWith('a1', 2, mockStoreResults['a1::2']);
  });
});

describe('ux2 batch 25 M6: confirmPendingDelete', () => {
  const { confirmPendingDelete } = require('../fact-choice-actions') as typeof import('../fact-choice-actions');
  const pending = { resultKey: 'a1::0', baseResult: { pendingFactIds: ['h1'] }, factIds: ['h1'] };
  beforeEach(() => { mockStoreResults = {}; mockDelete.mockClear(); mockPatch.mockClear(); });

  it('Remove deletes exactly those ids and records what went', async () => {
    await confirmPendingDelete(pending, 'remove');
    expect(mockDelete).toHaveBeenCalledWith({ fact_ids: ['h1'] });
    expect(mockStoreResults['a1::0']).toMatchObject({ deleteOutcome: 'removed', deletedStatements: ['Lives in Porto'] });
    expect(mockPatch).toHaveBeenCalledWith('a1', 0, mockStoreResults['a1::0']);
  });
  it('Keep deletes nothing', async () => {
    await confirmPendingDelete(pending, 'keep');
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockStoreResults['a1::0']).toMatchObject({ deleteOutcome: 'kept' });
  });
});
