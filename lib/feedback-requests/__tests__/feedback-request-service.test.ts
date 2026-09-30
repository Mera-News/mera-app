// feedback-request-service: the two GraphQL calls and how their failures map
// to outcomes the modal can show.

const mockQuery = jest.fn();
const mockMutate = jest.fn();
const mockBreadcrumb = jest.fn();
const mockCapture = jest.fn();
let mockIsConnected: boolean = true;

jest.mock('@/lib/apollo-client', () => ({
  __esModule: true,
  default: {
    query: (...a: unknown[]) => mockQuery(...a),
    mutate: (...a: unknown[]) => mockMutate(...a),
  },
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    addBreadcrumb: (...a: unknown[]) => mockBreadcrumb(...a),
    captureException: (...a: unknown[]) => mockCapture(...a),
  },
}));
// The real module drags the settings DB and a native module; only the locale
// map is under test here, and it is tested where it lives.
jest.mock('@/lib/publication-display-service', () => ({
  serverLocaleFor: (code: string) =>
    ({ pt: 'pt-BR', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' } as Record<string, string>)[code] ?? code,
}));
jest.mock('@/lib/stores/network-store', () => ({
  useNetworkStore: { getState: () => ({ isConnected: mockIsConnected }) },
}));

import {
  FEEDBACK_REQUEST_CLOSED,
  fetchActiveFeedbackRequests,
  submitFeedbackResponse,
} from '../feedback-request-service';

const ID = '0123456789abcdef01234567';

function gqlError(code: string) {
  return Object.assign(new Error('gql'), { errors: [{ message: 'x', extensions: { code } }] });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockMutate.mockReset();
  mockBreadcrumb.mockReset();
  mockCapture.mockReset();
  mockIsConnected = true;
});

describe('fetchActiveFeedbackRequests', () => {
  it('maps the app language to the server locale (zh-Hans would get English as-is)', async () => {
    mockQuery.mockResolvedValue({ data: { activeFeedbackRequests: [] } });
    await fetchActiveFeedbackRequests('zh-Hans');
    expect(mockQuery.mock.calls[0][0].variables).toEqual({ locale: 'zh-CN' });
  });

  it('is no-cache, off the sync banner, and never sends a user id', async () => {
    mockQuery.mockResolvedValue({ data: { activeFeedbackRequests: [] } });
    await fetchActiveFeedbackRequests('en');
    const opts = mockQuery.mock.calls[0][0];
    expect(opts.fetchPolicy).toBe('no-cache');
    expect(opts.context).toEqual({ noSyncStatus: true });
    expect(Object.keys(opts.variables)).toEqual(['locale']);
  });

  it('returns parsed requests with endsAt in epoch ms', async () => {
    mockQuery.mockResolvedValue({
      data: {
        activeFeedbackRequests: [
          { id: ID, question: 'How is it going?', endsAt: '2026-10-07T00:00:00.000Z', createdAt: '2026-09-30T00:00:00.000Z', answered: false },
        ],
      },
    });
    await expect(fetchActiveFeedbackRequests('en')).resolves.toEqual({
      ok: true,
      requests: [{ id: ID, question: 'How is it going?', endsAt: Date.parse('2026-10-07T00:00:00.000Z'), answered: false }],
    });
  });

  it('drops rows with no id, a blank question or an unparseable endsAt', async () => {
    mockQuery.mockResolvedValue({
      data: {
        activeFeedbackRequests: [
          null,
          { id: '', question: 'q', endsAt: '2026-10-07T00:00:00Z', answered: false },
          { id: ID, question: '   ', endsAt: '2026-10-07T00:00:00Z', answered: false },
          { id: ID, question: 'q', endsAt: 'not a date', answered: false },
          { id: ID, question: 'q', endsAt: '2026-10-07T00:00:00Z', answered: true },
        ],
      },
    });
    const result = await fetchActiveFeedbackRequests('en');
    expect(result).toEqual({
      ok: true,
      requests: [{ id: ID, question: 'q', endsAt: Date.parse('2026-10-07T00:00:00Z'), answered: true }],
    });
  });

  it('treats a missing payload as an empty list', async () => {
    mockQuery.mockResolvedValue({ data: undefined });
    await expect(fetchActiveFeedbackRequests('en')).resolves.toEqual({ ok: true, requests: [] });
  });

  // The error link owns the Sentry capture; a second event here would double it.
  it('on failure: breadcrumb only, never a capture, never a throw', async () => {
    mockQuery.mockRejectedValue(gqlError('INTERNAL_SERVER_ERROR'));
    await expect(fetchActiveFeedbackRequests('en')).resolves.toEqual({ ok: false, offline: false });
    expect(mockBreadcrumb).toHaveBeenCalledTimes(1);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('reports offline only when the device link is known down', async () => {
    mockIsConnected = false;
    mockQuery.mockRejectedValue(new Error('Network request failed'));
    await expect(fetchActiveFeedbackRequests('en')).resolves.toEqual({ ok: false, offline: true });
  });
});

describe('submitFeedbackResponse', () => {
  it('sends the trimmed text and the request id only', async () => {
    mockMutate.mockResolvedValue({ data: { submitFeedbackResponse: { ok: true, alreadyAnswered: false } } });
    await expect(submitFeedbackResponse(ID, '  great  ')).resolves.toEqual({ status: 'ok', alreadyAnswered: false });
    const opts = mockMutate.mock.calls[0][0];
    expect(opts.variables).toEqual({ input: { feedbackRequestId: ID, text: 'great' } });
    expect(opts.fetchPolicy).toBe('no-cache');
    expect(opts.context).toEqual({ noSyncStatus: true, expectedErrorCodes: [FEEDBACK_REQUEST_CLOSED] });
  });

  it('caps the text at 2000 characters', async () => {
    mockMutate.mockResolvedValue({ data: { submitFeedbackResponse: { ok: true, alreadyAnswered: false } } });
    await submitFeedbackResponse(ID, 'a'.repeat(2500));
    expect(mockMutate.mock.calls[0][0].variables.input.text).toHaveLength(2000);
  });

  it('never sends an empty answer', async () => {
    await expect(submitFeedbackResponse(ID, '   ')).resolves.toEqual({ status: 'error', offline: false });
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('alreadyAnswered is a success', async () => {
    mockMutate.mockResolvedValue({ data: { submitFeedbackResponse: { ok: false, alreadyAnswered: true } } });
    await expect(submitFeedbackResponse(ID, 'x')).resolves.toEqual({ status: 'ok', alreadyAnswered: true });
  });

  it('ok false without alreadyAnswered is an error', async () => {
    mockMutate.mockResolvedValue({ data: { submitFeedbackResponse: { ok: false, alreadyAnswered: false } } });
    await expect(submitFeedbackResponse(ID, 'x')).resolves.toEqual({ status: 'error', offline: false });
    expect(mockBreadcrumb).toHaveBeenCalled();
  });

  it('an empty result is an error', async () => {
    mockMutate.mockResolvedValue({ data: null });
    await expect(submitFeedbackResponse(ID, 'x')).resolves.toEqual({ status: 'error', offline: false });
  });

  it('FEEDBACK_REQUEST_CLOSED maps to closed (Apollo 4 errors)', async () => {
    mockMutate.mockRejectedValue(gqlError(FEEDBACK_REQUEST_CLOSED));
    await expect(submitFeedbackResponse(ID, 'x')).resolves.toEqual({ status: 'closed' });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('FEEDBACK_REQUEST_CLOSED maps to closed (Apollo 3 graphQLErrors)', async () => {
    mockMutate.mockRejectedValue(
      Object.assign(new Error('gql'), { graphQLErrors: [{ extensions: { code: FEEDBACK_REQUEST_CLOSED } }] }),
    );
    await expect(submitFeedbackResponse(ID, 'x')).resolves.toEqual({ status: 'closed' });
  });

  it('any other failure is an error, offline when the link is down', async () => {
    mockMutate.mockRejectedValue(new Error('boom'));
    await expect(submitFeedbackResponse(ID, 'x')).resolves.toEqual({ status: 'error', offline: false });
    mockIsConnected = false;
    mockMutate.mockRejectedValue('not an error object');
    await expect(submitFeedbackResponse(ID, 'x')).resolves.toEqual({ status: 'error', offline: true });
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
