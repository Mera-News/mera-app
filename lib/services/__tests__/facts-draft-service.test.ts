// facts-draft-service: the Profile-chat fingerprint that decides whether a
// combination pass is owed (ux2 F2).

const mockSettings = new Map<string, string>();
const mockCalls: string[] = [];
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => {
    mockCalls.push(`set:${k}`);
    mockSettings.set(k, v);
  }),
  deleteSetting: jest.fn(async (k: string) => {
    mockCalls.push(`delete:${k}`);
    mockSettings.delete(k);
  }),
}));
let mockFacts: { id: string; statement: string }[] = [];
jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: jest.fn(async () => mockFacts),
}));
const mockMarkComboPending = jest.fn(async () => {
  mockCalls.push('markComboPending');
});
const mockRunPendingComboPass = jest.fn(async () => 'enqueued');
jest.mock('@/lib/database/services/combo-pass-service', () => ({
  markComboPending: () => mockMarkComboPending(),
  runPendingComboPass: () => mockRunPendingComboPass(),
}));

import {
  closeFactsDraft,
  factsFingerprint,
  openFactsDraft,
  recoverOpenFactsDraft,
  settleProfileChatClose,
} from '../facts-draft-service';

beforeEach(() => {
  mockSettings.clear();
  mockCalls.length = 0;
  jest.clearAllMocks();
  mockFacts = [
    { id: 'f1', statement: 'Lives in Porto' },
    { id: 'f2', statement: 'From India' },
  ];
});

describe('factsFingerprint', () => {
  it('ignores order and changes with any statement', () => {
    const a = factsFingerprint([{ id: 'a', statement: 'x' }, { id: 'b', statement: 'y' }]);
    const b = factsFingerprint([{ id: 'b', statement: 'y' }, { id: 'a', statement: 'x' }]);
    const c = factsFingerprint([{ id: 'a', statement: 'x' }, { id: 'b', statement: 'z' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('open and close', () => {
  it('no change: close reports false and owes no pass', async () => {
    await openFactsDraft();
    expect(mockSettings.get('facts_draft_open')).toBe('1');
    expect(await closeFactsDraft()).toBe(false);
    expect(mockMarkComboPending).not.toHaveBeenCalled();
    expect(mockSettings.has('facts_draft_open')).toBe(false);
  });

  it('an added, updated or deleted fact owes a pass', async () => {
    for (const change of [
      () => mockFacts.push({ id: 'f3', statement: 'Works as a nurse' }),
      () => { mockFacts[0] = { id: 'f1', statement: 'Lives in Lisbon' }; },
      () => mockFacts.pop(),
    ]) {
      mockFacts = [
        { id: 'f1', statement: 'Lives in Porto' },
        { id: 'f2', statement: 'From India' },
      ];
      await openFactsDraft();
      change();
      expect(await closeFactsDraft()).toBe(true);
    }
    expect(mockMarkComboPending).toHaveBeenCalledTimes(3);
  });

  it('marks the pass pending BEFORE clearing the open marker, so a kill in between still recovers', async () => {
    await openFactsDraft();
    mockFacts.pop();
    mockCalls.length = 0;
    await closeFactsDraft();
    expect(mockCalls.indexOf('markComboPending')).toBeLessThan(mockCalls.indexOf('delete:facts_draft_open'));
  });

  it('a close with no open draft does nothing', async () => {
    expect(await closeFactsDraft()).toBe(false);
    expect(mockMarkComboPending).not.toHaveBeenCalled();
  });

  it('the close path runs the pass only when facts changed', async () => {
    await openFactsDraft();
    await settleProfileChatClose();
    expect(mockRunPendingComboPass).not.toHaveBeenCalled();

    await openFactsDraft();
    mockFacts.pop();
    await settleProfileChatClose();
    expect(mockRunPendingComboPass).toHaveBeenCalledTimes(1);
  });
});

describe('kill recovery', () => {
  it('an open draft with a different fingerprint on the next launch owes a pass, once', async () => {
    await openFactsDraft();
    mockFacts.push({ id: 'f3', statement: 'Works as a nurse' });
    // (app killed here; the chat never closed)
    expect(await recoverOpenFactsDraft()).toBe(true);
    expect(mockMarkComboPending).toHaveBeenCalledTimes(1);
    expect(await recoverOpenFactsDraft()).toBe(false);
  });

  it('an open draft with no change clears quietly', async () => {
    await openFactsDraft();
    expect(await recoverOpenFactsDraft()).toBe(false);
    expect(mockSettings.has('facts_draft_open')).toBe(false);
  });
});
