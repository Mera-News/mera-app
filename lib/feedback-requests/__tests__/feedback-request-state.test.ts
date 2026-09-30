// feedback-request-state: the one settings row, its parse, the serialized
// read-modify-write and the auto-show pick. The settings row is a fake map.

const mockRows = new Map<string, string>();
let mockFailWrite = false;
let mockFailRead = false;
const mockCapture = jest.fn();

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn(async (k: string) => {
    if (mockFailRead) throw new Error('read failed');
    return mockRows.get(k) ?? null;
  }),
  setSetting: jest.fn(async (k: string, v: string) => {
    // Yield first so two unserialized writers would interleave.
    await new Promise((r) => setTimeout(r, 0));
    if (mockFailWrite) throw new Error('write failed');
    mockRows.set(k, v);
  }),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: (...a: unknown[]) => mockCapture(...a) },
}));

import {
  FEEDBACK_REQUESTS_STATE_KEY,
  FEEDBACK_REQUEST_STATE_RETENTION_MS,
  __resetFeedbackRequestStateForTests,
  isFeedbackRequestEnded,
  markFeedbackRequestAnswered,
  markFeedbackRequestDismissed,
  markFeedbackRequestShown,
  parseFeedbackRequestsState,
  pickAutoShowCandidate,
  readFeedbackRequestsState,
  subscribeFeedbackRequestsState,
  updateFeedbackRequestsState,
} from '../feedback-request-state';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = 1_000_000_000_000;

function row() {
  return JSON.parse(mockRows.get(FEEDBACK_REQUESTS_STATE_KEY) ?? '{}');
}

beforeEach(() => {
  mockRows.clear();
  mockFailWrite = false;
  mockFailRead = false;
  mockCapture.mockReset();
  __resetFeedbackRequestStateForTests();
});

describe('parseFeedbackRequestsState', () => {
  it('reads nothing from an empty, corrupt or non-object row', () => {
    expect(parseFeedbackRequestsState(null)).toEqual({});
    expect(parseFeedbackRequestsState('{')).toEqual({});
    expect(parseFeedbackRequestsState('[1]')).toEqual({});
    expect(parseFeedbackRequestsState('"x"')).toEqual({});
  });

  it('keeps valid entries and drops corrupt ones', () => {
    const parsed = parseFeedbackRequestsState(
      JSON.stringify({
        [A]: { question: 'q', endsAt: 5, shownAt: 1, answeredAt: 2, dismissedAt: 3 },
        [B]: { question: 'q', endsAt: 'soon' },
        c: null,
        d: { endsAt: 5 },
        e: { question: 'q', endsAt: 5, shownAt: 'x' },
      }),
    );
    expect(parsed).toEqual({
      [A]: { question: 'q', endsAt: 5, shownAt: 1, answeredAt: 2, dismissedAt: 3 },
      e: { question: 'q', endsAt: 5 },
    });
  });
});

describe('updateFeedbackRequestsState', () => {
  // The task, the host and the modal all write this row; an unserialized
  // read-modify-write would lose one of two stamps landing together.
  it('serializes concurrent writers so neither stamp is lost', async () => {
    await updateFeedbackRequestsState((s) => {
      s[A] = { question: 'q', endsAt: NOW + 1000 };
    }, NOW);
    await Promise.all([
      markFeedbackRequestShown(A, NOW + 1),
      updateFeedbackRequestsState((s) => {
        s[A].question = 'q2';
      }, NOW),
      markFeedbackRequestAnswered(A, NOW + 2),
    ]);
    expect(row()[A]).toEqual({ question: 'q2', endsAt: NOW + 1000, shownAt: NOW + 1, answeredAt: NOW + 2 });
  });

  it('prunes entries that ended past the retention window', async () => {
    await updateFeedbackRequestsState((s) => {
      s[A] = { question: 'old', endsAt: NOW - FEEDBACK_REQUEST_STATE_RETENTION_MS - 1 };
      s[B] = { question: 'recent', endsAt: NOW - 1 };
    }, NOW);
    expect(Object.keys(row())).toEqual([B]);
  });

  it('notifies listeners after a write, and stops after unsubscribe', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeFeedbackRequestsState(listener);
    await updateFeedbackRequestsState(() => {}, NOW);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await updateFeedbackRequestsState(() => {}, NOW);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a mutator returning false writes nothing and notifies nobody', async () => {
    const { setSetting } = jest.requireMock('@/lib/database/services/setting-service') as { setSetting: jest.Mock };
    setSetting.mockClear();
    const listener = jest.fn();
    subscribeFeedbackRequestsState(listener);
    await updateFeedbackRequestsState(() => false, NOW);
    expect(setSetting).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener does not stop the others', async () => {
    const good = jest.fn();
    subscribeFeedbackRequestsState(() => {
      throw new Error('bad listener');
    });
    subscribeFeedbackRequestsState(good);
    await updateFeedbackRequestsState(() => {}, NOW);
    expect(good).toHaveBeenCalled();
  });

  it('a failed write reports, resolves with the previous state and notifies nobody', async () => {
    await updateFeedbackRequestsState((s) => {
      s[A] = { question: 'q', endsAt: NOW + 1 };
    }, NOW);
    const listener = jest.fn();
    subscribeFeedbackRequestsState(listener);
    mockFailWrite = true;
    const result = await updateFeedbackRequestsState((s) => {
      delete s[A];
    }, NOW);
    expect(result[A]).toBeDefined();
    expect(listener).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalled();
    // The chain is not poisoned: the next write still runs.
    mockFailWrite = false;
    await markFeedbackRequestShown(A, NOW);
    expect(row()[A].shownAt).toBe(NOW);
  });

  it('an unreadable row reads as empty and is reported', async () => {
    mockFailRead = true;
    await expect(readFeedbackRequestsState()).resolves.toEqual({});
    expect(mockCapture).toHaveBeenCalled();
  });
});

describe('stamps', () => {
  beforeEach(async () => {
    await updateFeedbackRequestsState((s) => {
      s[A] = { question: 'q', endsAt: NOW + 1000 };
    }, NOW);
  });

  it('shownAt: first presentation wins', async () => {
    await expect(markFeedbackRequestShown(A, NOW + 1)).resolves.toBe(true);
    await markFeedbackRequestShown(A, NOW + 2);
    expect(row()[A].shownAt).toBe(NOW + 1);
  });

  it('shownAt on an unknown id: false without a seed, created from the seed', async () => {
    await expect(markFeedbackRequestShown(B, NOW)).resolves.toBe(false);
    expect(row()[B]).toBeUndefined();
    await expect(markFeedbackRequestShown(B, NOW, { question: 'seeded', endsAt: NOW + 5 })).resolves.toBe(true);
    expect(row()[B]).toEqual({ question: 'seeded', endsAt: NOW + 5, shownAt: NOW });
  });

  it('dismissedAt: first wins, never after an answer, unknown ids ignored', async () => {
    await markFeedbackRequestDismissed(A, NOW + 1);
    await markFeedbackRequestDismissed(A, NOW + 2);
    expect(row()[A].dismissedAt).toBe(NOW + 1);
    await markFeedbackRequestDismissed(B, NOW);
    expect(row()[B]).toBeUndefined();

    await updateFeedbackRequestsState((s) => {
      s[B] = { question: 'q', endsAt: NOW + 1000, answeredAt: NOW };
    }, NOW);
    await markFeedbackRequestDismissed(B, NOW + 3);
    expect(row()[B].dismissedAt).toBeUndefined();
  });

  it('answeredAt: first wins, unknown ids ignored', async () => {
    await markFeedbackRequestAnswered(A, NOW + 1);
    await markFeedbackRequestAnswered(A, NOW + 2);
    expect(row()[A].answeredAt).toBe(NOW + 1);
    await markFeedbackRequestAnswered(B, NOW);
    expect(row()[B]).toBeUndefined();
  });
});

describe('pickAutoShowCandidate', () => {
  it('skips shown, answered, dismissed and ended; picks the one closing soonest', () => {
    const state = {
      shown: { question: 'q', endsAt: NOW + 10, shownAt: NOW },
      answered: { question: 'q', endsAt: NOW + 10, answeredAt: NOW },
      dismissed: { question: 'q', endsAt: NOW + 10, dismissedAt: NOW },
      ended: { question: 'q', endsAt: NOW },
      later: { question: 'q', endsAt: NOW + 500 },
      sooner: { question: 'q', endsAt: NOW + 100 },
    };
    expect(pickAutoShowCandidate(state, NOW)).toBe('sooner');
    expect(pickAutoShowCandidate({}, NOW)).toBeNull();
  });

  it('isFeedbackRequestEnded is inclusive of endsAt', () => {
    expect(isFeedbackRequestEnded({ endsAt: NOW }, NOW)).toBe(true);
    expect(isFeedbackRequestEnded({ endsAt: NOW + 1 }, NOW)).toBe(false);
  });
});
