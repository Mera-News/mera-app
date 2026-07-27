// auth-failure-breaker.test.ts — unit tests for the 401/auth circuit breaker.
//
// The breaker lazy-requires ./auth-client and ./scheduler/AppScheduler inside
// its functions, so mocking those modules is enough — no import ordering games.

const mockCaptureMessage = jest.fn();
const mockAddBreadcrumb = jest.fn();

const mockGetSession = jest.fn();
const mockClearAuthStorage = jest.fn((..._args: any[]) => Promise.resolve());
const mockInvalidateJwtCache = jest.fn();
const mockSetNeedsReauth = jest.fn();
// Mutable so a test can put the store in the "already flagged for re-auth"
// state that onAppForeground must refuse to resume from. The `mock` prefix is
// load-bearing: babel-jest rejects other out-of-scope names in a mock factory.
let mockNeedsReauth = false;

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
  invalidateJwtCache: (...args: any[]) => mockInvalidateJwtCache(...args),
}));

jest.mock('../scheduler/AppScheduler', () => ({
  AppScheduler: {
    pauseTask: (...args: any[]) => mockPauseTask(...args),
    resumeTask: (...args: any[]) => mockResumeTask(...args),
  },
}));

jest.mock('../stores/user-store', () => ({
  useUserStore: {
    getState: () => ({
      needsReauth: mockNeedsReauth,
      setNeedsReauth: (...args: any[]) => mockSetNeedsReauth(...args),
    }),
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
  mockNeedsReauth = false;
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

  it('repairs BEFORE pausing: the 3rd failure only drops the JWT and re-checks', async () => {
    // Repair-first ordering: nothing is paused and nothing is reported until
    // the server-truth re-check has had its say.
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();

    expect(mockInvalidateJwtCache).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockPauseTask).not.toHaveBeenCalled();

    await flush();
  });

  it('threshold with a LIVE session: feed-sync is never paused, no Sentry event', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { id: 's1' } } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockPauseTask).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).not.toHaveBeenCalledWith(true);
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('threshold with a DEAD session: pauses, captures once, flags needsReauth', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Auth circuit breaker tripped',
      expect.objectContaining({
        level: 'warning',
        tags: { source: 'auth-breaker', type: 'auth' },
        extra: { consecutiveFailures: 3, recheck: 'dead' },
      }),
    );
    expect(mockPauseTask).toHaveBeenCalledWith('feed-sync');
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
    expect(_getBreakerState().breakerOpen).toBe(true);
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

    expect(mockGetSession).toHaveBeenCalledTimes(1);
    // Still undecided, so still nothing paused/reported.
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockPauseTask).not.toHaveBeenCalled();

    resolveSession({ data: null }); // dead
    await flush();

    // Exactly one event and one pause for the whole trip, regardless of the
    // extra failures that landed while the re-check was in flight.
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockPauseTask).toHaveBeenCalledTimes(1);
  });

  it('does not act on a stale verdict when a success closed the breaker mid-re-check', async () => {
    // Deferring the pause until the re-check answers opens a window: if a
    // concurrent request succeeds first, the verdict we are holding is already
    // out of date. Pausing on it would leave feed-sync paused with the breaker
    // closed — a state nothing in the module resumes from.
    let resolveSession: (v: unknown) => void = () => {};
    mockGetSession.mockReturnValueOnce(
      new Promise((res) => {
        resolveSession = res;
      }),
    );

    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure(); // trips, re-check in flight

    recordAuthSuccess(); // another query came back fine
    expect(_getBreakerState().breakerOpen).toBe(false);

    resolveSession({ data: null }); // stale "dead" verdict lands afterwards
    await flush();

    expect(mockPauseTask).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(false);
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
  // Trip the breaker into the inconclusive (offline) state: open, paused, no
  // needsReauth flag — the state a foreground is supposed to recover from.
  async function tripInconclusive() {
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();
    expect(_getBreakerState().breakerOpen).toBe(true);
    jest.clearAllMocks();
  }

  it('resumes only after a fresh getSession proves the session alive', async () => {
    await tripInconclusive();

    onAppForeground();
    // Revalidates instead of resuming blind — the old unconditional resume is
    // what bought 3 more 401s and an immediate re-trip on every foreground.
    expect(mockGetSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
    expect(mockResumeTask).not.toHaveBeenCalled();

    await flush();
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('returns synchronously — does not await the re-check', async () => {
    await tripInconclusive();

    let resolveSession: (v: unknown) => void = () => {};
    mockGetSession.mockReturnValueOnce(
      new Promise((res) => {
        resolveSession = res;
      }),
    );

    // AppScheduler._onForeground calls this inline; it must not block on a
    // network round-trip.
    onAppForeground();
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(true);

    resolveSession({ data: { session: { id: 's1' } } });
    await flush();
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
  });

  it('leaves the breaker open when the foreground re-check is still inconclusive', async () => {
    await tripInconclusive();
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 500 } });

    onAppForeground();
    await flush();

    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('does nothing when needsReauth is already set — the banner is the recovery path', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null }); // dead
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
    mockNeedsReauth = true;
    jest.clearAllMocks();

    onAppForeground();
    await flush();

    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('resets the counter without a round-trip when the breaker never opened', async () => {
    recordAuthFailure();
    recordAuthFailure();

    onAppForeground();
    await flush();

    expect(_getBreakerState().consecutiveFailures).toBe(0);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockResumeTask).not.toHaveBeenCalled();
  });

  it('is a no-op when the breaker is closed and counter is zero', () => {
    onAppForeground();
    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});
