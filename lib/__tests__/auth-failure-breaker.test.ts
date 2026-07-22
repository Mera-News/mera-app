// auth-failure-breaker.test.ts — unit tests for the 401/auth circuit breaker.
//
// The breaker lazy-requires ./auth-client and ./scheduler/AppScheduler inside
// its functions, so mocking those modules is enough — no import ordering games.

const mockCaptureMessage = jest.fn();
const mockAddBreadcrumb = jest.fn();

const mockGetSession = jest.fn();
const mockClearAuthStorage = jest.fn((..._args: any[]) => Promise.resolve());
const mockSetNeedsReauth = jest.fn();

const mockPauseTask = jest.fn();
const mockResumeTask = jest.fn();

jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    captureMessage: (...args: any[]) => mockCaptureMessage(...args),
    addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
  },
}));

jest.mock('../auth-client', () => ({
  authClient: {
    getSession: (...args: any[]) => mockGetSession(...args),
  },
  clearAuthStorage: (...args: any[]) => mockClearAuthStorage(...args),
}));

jest.mock('../scheduler/AppScheduler', () => ({
  AppScheduler: {
    pauseTask: (...args: any[]) => mockPauseTask(...args),
    resumeTask: (...args: any[]) => mockResumeTask(...args),
  },
}));

jest.mock('../stores/user-store', () => ({
  useUserStore: {
    getState: () => ({ setNeedsReauth: (...args: any[]) => mockSetNeedsReauth(...args) }),
  },
}));

import {
  recordAuthFailure,
  recordAuthSuccess,
  onAppForeground,
  _resetForTests,
  _getBreakerState,
} from '../auth-failure-breaker';

// Flush the microtask queue so the fire-and-forget re-check promise settles.
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  _resetForTests();
  // Default: re-check finds a live session (so an incidental trip doesn't log out).
  mockGetSession.mockResolvedValue({ data: { session: { id: 's1' } } });
});

describe('recordAuthFailure — tripping', () => {
  it('does not trip before the threshold (2 failures)', () => {
    recordAuthFailure();
    recordAuthFailure();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockPauseTask).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(false);
  });

  it('trips on the 3rd consecutive failure: one Sentry event, pause, one re-check', async () => {
    // Keep the session "dead so it stays open" is not needed here — we just
    // assert the trip side effects. Use a live session to avoid logout noise.
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Auth circuit breaker tripped',
      expect.objectContaining({
        level: 'warning',
        tags: { source: 'auth-breaker', type: 'auth' },
        extra: { consecutiveFailures: 3 },
      }),
    );
    expect(mockPauseTask).toHaveBeenCalledWith('feed-sync');
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });

    await flush();
  });

  it('does not re-capture or re-pause on a 4th failure while re-check pending', async () => {
    // Make getSession hang so the re-check stays in flight across failure #4.
    let resolveSession: (v: unknown) => void = () => {};
    mockGetSession.mockReturnValueOnce(
      new Promise((res) => {
        resolveSession = res;
      }),
    );

    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure(); // trips, re-check in flight
    recordAuthFailure(); // #4 while pending — must be a no-op

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockPauseTask).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledTimes(1);

    resolveSession({ data: { session: { id: 's1' } } });
    await flush();
  });
});

describe('recordAuthSuccess — reset', () => {
  it('resets the counter so 2 + success + 2 does not trip', () => {
    recordAuthFailure();
    recordAuthFailure();
    recordAuthSuccess();
    recordAuthFailure();
    recordAuthFailure();

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(_getBreakerState().consecutiveFailures).toBe(2);
  });

  it('closes an open breaker and resumes feed-sync', async () => {
    // Trip with a re-check that finds the session dead (so it stays open until success).
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();
    // dead session -> needsReauth flagged (NOT ejected), breaker still open
    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);

    recordAuthSuccess();
    // success clears the reauth flag and resumes the poller
    expect(mockSetNeedsReauth).toHaveBeenLastCalledWith(false);
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
    expect(_getBreakerState().breakerOpen).toBe(false);
  });
});

describe('re-check outcomes', () => {
  it('alive session → resume feed-sync, breaker closed, no reauth flag', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { id: 's1' } } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).not.toHaveBeenCalledWith(true);
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('dead session (null data, no error) → flags needsReauth, no eject', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
    // breaker stays open so feed-sync remains paused until re-login
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('401 error → flags needsReauth, no eject', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 401 } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
  });

  it('network/offline error → does NOT flag reauth, breaker stays open', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 0 } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).not.toHaveBeenCalledWith(true);
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('thrown error (offline) → does NOT flag reauth, breaker stays open', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('Network request failed'));
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).not.toHaveBeenCalledWith(true);
    expect(_getBreakerState().breakerOpen).toBe(true);
  });
});

describe('re-check dedupe', () => {
  it('does not start a second re-check while one is in flight', async () => {
    let resolveSession: (v: unknown) => void = () => {};
    mockGetSession.mockReturnValueOnce(
      new Promise((res) => {
        resolveSession = res;
      }),
    );

    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure(); // trip + start re-check
    // Additional failures while pending must not spawn more getSession calls.
    recordAuthFailure();
    recordAuthFailure();

    expect(mockGetSession).toHaveBeenCalledTimes(1);

    resolveSession({ data: null, error: { status: 500 } }); // inconclusive, stays open
    await flush();
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });
});

describe('onAppForeground', () => {
  it('resets and resumes when the breaker was open', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();
    expect(_getBreakerState().breakerOpen).toBe(true);

    onAppForeground();
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('is a no-op when the breaker is closed and counter is zero', () => {
    onAppForeground();
    expect(mockResumeTask).not.toHaveBeenCalled();
  });
});
