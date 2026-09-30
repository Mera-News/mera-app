// feedback-request-sync: server list -> local state, drawer rows, actioned rows.
// The state module is real (over a fake settings map); the fetch and the
// notification table are mocked.

const mockRows = new Map<string, string>();
const mockFetch = jest.fn();
const mockNotify = jest.fn(async (_input: unknown) => ({}));
const mockMarkActionedBySource = jest.fn(async (_source: string) => 1);

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockRows.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => {
    mockRows.set(k, v);
  }),
}));
jest.mock('@/lib/database/services/notification-service', () => ({
  notify: (input: unknown) => mockNotify(input),
  markActionedBySource: (source: string) => mockMarkActionedBySource(source),
}));
jest.mock('../feedback-request-service', () => ({
  fetchActiveFeedbackRequests: (...a: unknown[]) => mockFetch(...a),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

import {
  FEEDBACK_REQUESTS_STATE_KEY,
  __resetFeedbackRequestStateForTests,
  markFeedbackRequestShown,
  subscribeFeedbackRequestsState,
} from '../feedback-request-state';
import {
  feedbackRequestNotificationSource,
  ingestFeedbackRequests,
  syncFeedbackRequests,
} from '../feedback-request-sync';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = 1_000_000_000_000;

function state() {
  return JSON.parse(mockRows.get(FEEDBACK_REQUESTS_STATE_KEY) ?? '{}');
}

beforeEach(() => {
  mockRows.clear();
  mockFetch.mockReset();
  mockNotify.mockClear();
  mockMarkActionedBySource.mockClear();
  __resetFeedbackRequestStateForTests();
});

describe('syncFeedbackRequests', () => {
  it('passes the app language through to the fetch', async () => {
    mockFetch.mockResolvedValue({ ok: true, requests: [] });
    await syncFeedbackRequests('zh-Hans', NOW);
    expect(mockFetch).toHaveBeenCalledWith('zh-Hans');
  });

  it('a failed fetch changes nothing', async () => {
    mockFetch.mockResolvedValue({ ok: false, offline: true });
    await expect(syncFeedbackRequests('en', NOW)).resolves.toEqual({ ok: false, fetched: 0, newRows: 0, answered: 0 });
    expect(mockRows.size).toBe(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('an empty list is a normal, quiet result', async () => {
    mockFetch.mockResolvedValue({ ok: true, requests: [] });
    await expect(syncFeedbackRequests('en', NOW)).resolves.toEqual({ ok: true, fetched: 0, newRows: 0, answered: 0 });
    expect(mockRows.size).toBe(0);
  });

  it('a new request: state entry, then ONE drawer row with the raw question', async () => {
    mockFetch.mockResolvedValue({ ok: true, requests: [{ id: A, question: 'Q?', endsAt: NOW + 10, answered: false }] });
    await expect(syncFeedbackRequests('en', NOW)).resolves.toEqual({ ok: true, fetched: 1, newRows: 1, answered: 0 });
    expect(state()[A]).toEqual({ question: 'Q?', endsAt: NOW + 10 });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith({
      type: 'feedback_request',
      title: 'feedbackRequest.title',
      body: 'Q?',
      icon: null,
      context: { feedbackRequestId: A, endsAt: NOW + 10 },
      source: `feedback_request:${A}`,
    });

    // A second sync of the same request: no second row.
    await syncFeedbackRequests('en', NOW);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('refreshes the question (re-localized) and endsAt, keeping the stamps', async () => {
    mockFetch.mockResolvedValue({ ok: true, requests: [{ id: A, question: 'Q?', endsAt: NOW + 10, answered: false }] });
    await syncFeedbackRequests('en', NOW);
    await markFeedbackRequestShown(A, NOW + 1);
    mockFetch.mockResolvedValue({ ok: true, requests: [{ id: A, question: 'F?', endsAt: NOW + 20, answered: false }] });
    await syncFeedbackRequests('fr', NOW + 2);
    expect(state()[A]).toEqual({ question: 'F?', endsAt: NOW + 20, shownAt: NOW + 1 });
  });

  it('answered elsewhere: stamps answeredAt and marks the drawer row actioned', async () => {
    mockFetch.mockResolvedValue({ ok: true, requests: [{ id: A, question: 'Q?', endsAt: NOW + 10, answered: false }] });
    await syncFeedbackRequests('en', NOW);
    mockFetch.mockResolvedValue({ ok: true, requests: [{ id: A, question: 'Q?', endsAt: NOW + 10, answered: true }] });
    await expect(syncFeedbackRequests('en', NOW + 5)).resolves.toMatchObject({ answered: 1 });
    expect(state()[A].answeredAt).toBe(NOW + 5);
    expect(mockMarkActionedBySource).toHaveBeenCalledWith(feedbackRequestNotificationSource(A));

    // Once stamped, a later sync does not re-action it.
    mockMarkActionedBySource.mockClear();
    await syncFeedbackRequests('en', NOW + 6);
    expect(mockMarkActionedBySource).not.toHaveBeenCalled();
    expect(state()[A].answeredAt).toBe(NOW + 5);
  });

  it('already answered on first sight: recorded, but no drawer row and nothing to action', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      requests: [
        { id: A, question: 'Q?', endsAt: NOW + 10, answered: true },
        { id: B, question: 'R?', endsAt: NOW + 10, answered: false },
      ],
    });
    await expect(syncFeedbackRequests('en', NOW)).resolves.toEqual({ ok: true, fetched: 2, newRows: 1, answered: 0 });
    expect(state()[A].answeredAt).toBe(NOW);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockMarkActionedBySource).not.toHaveBeenCalled();
  });

  // The auto-show host is level-triggered off state writes.
  it('a sync with requests wakes state listeners', async () => {
    const listener = jest.fn();
    subscribeFeedbackRequestsState(listener);
    mockFetch.mockResolvedValue({ ok: true, requests: [{ id: A, question: 'Q?', endsAt: NOW + 10, answered: false }] });
    await syncFeedbackRequests('en', NOW);
    expect(listener).toHaveBeenCalled();
  });
});

describe('ingestFeedbackRequests', () => {
  it('an empty list writes nothing', async () => {
    await expect(ingestFeedbackRequests([], NOW)).resolves.toEqual({ newRows: 0, answered: 0 });
    expect(mockRows.size).toBe(0);
  });
});
