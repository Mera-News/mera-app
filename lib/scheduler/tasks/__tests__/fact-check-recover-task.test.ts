// fact-check-recover-task — the thing that stops a killed app stranding a row.
//
// The failure this prevents: `enqueueFactCheck` writes `processing` and starts
// an in-memory run. Kill the app and the row survives, the run does not, and
// nothing is left that intends to finish it — the panel shows "checking…"
// forever. That is the same silent failure the server's retry cron existed to
// remove, one layer down.
//
// The properties that have to hold, and each is a test below: a LIVE run is
// never double-driven, a stranded one is, the pass is bounded, and a row that
// has burned its attempts becomes `blocked` (terminal, verdict-free) rather
// than looping — because "we could not finish" must never turn into an answer.

jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { register: jest.fn() },
}));

jest.mock('@/lib/stores/subscription-store', () => ({
  getAiAccess: jest.fn(() => 'entitled'),
}));

jest.mock('@/lib/database/services/fact-check-record-service', () => ({
  listFactChecksByStatus: jest.fn(async () => []),
  upsertFactCheck: jest.fn(async () => undefined),
}));

jest.mock('@/lib/fact-check/fact-check-queue', () => ({
  FACT_CHECK_STATUS: {
    processing: 'processing', complete: 'complete', blocked: 'blocked', failed: 'failed',
  },
  isFactCheckInFlight: jest.fn(() => false),
  redriveFactCheck: jest.fn(() => true),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), captureException: jest.fn() },
}));

// Named imports AND the bare side-effect import in one statement: loading the
// module is what performs the `AppScheduler.register()` under test.
import { isStranded, MAX_PER_PASS, STALE_AFTER_MS } from '../fact-check-recover-task';

const { AppScheduler: { register: mockRegister } } = jest.requireMock('@/lib/scheduler/AppScheduler') as any;
const { getAiAccess: mockGetAiAccess } = jest.requireMock('@/lib/stores/subscription-store') as any;
const {
  listFactChecksByStatus: mockList,
  upsertFactCheck: mockUpsert,
} = jest.requireMock('@/lib/database/services/fact-check-record-service') as any;
const {
  isFactCheckInFlight: mockInFlight,
  redriveFactCheck: mockRedrive,
} = jest.requireMock('@/lib/fact-check/fact-check-queue') as any;

const def = mockRegister.mock.calls[0]?.[0];

const NOW = 1_700_000_000_000;

function makeCtx() {
  return {
    jobId: 'job-1',
    attempt: 1,
    signal: new AbortController().signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    markNoOp: jest.fn(),
  };
}

function stale(overrides: Record<string, any> = {}) {
  return {
    id: 'r1',
    articleId: 'a1',
    factCheckId: 'fc1',
    articleTitle: 'T',
    status: 'processing',
    verdict: null,
    claim: 'a claim',
    claimKey: 'k1',
    requestedAt: NOW - STALE_AFTER_MS - 1,
    resolvedAt: null,
    payload: { startedAt: NOW - STALE_AFTER_MS - 1, attempts: 1 },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  mockList.mockResolvedValue([]);
  mockInFlight.mockReturnValue(false);
  mockRedrive.mockReturnValue(true);
  mockGetAiAccess.mockReturnValue('entitled');
});

afterEach(() => {
  (Date.now as unknown as jest.Mock).mockRestore?.();
});

describe('registration', () => {
  it('registers as fact-check-recover on app-foreground only', () => {
    expect(def.name).toBe('fact-check-recover');
    expect(def.triggers).toEqual(['app-foreground']);
    expect(def.frequency).toBe(0);
    expect(def.exclusive).toBe(true);
  });

  it('is gated on paid AI access, `!== locked` so "unknown" still recovers', () => {
    const custom = def.conditions.filter((c: any) => c.type === 'custom');
    expect(custom).toHaveLength(1);
    mockGetAiAccess.mockReturnValue('locked');
    expect(custom[0].check()).toBe(false);
    mockGetAiAccess.mockReturnValue('unknown');
    expect(custom[0].check()).toBe(true);
  });

  it('needs network, auth and a database', () => {
    const types = def.conditions.map((c: any) => c.type);
    expect(types).toEqual(expect.arrayContaining(['network', 'authenticated', 'db-ready']));
  });
});

describe('isStranded', () => {
  it('leaves a run that only just started alone', () => {
    expect(isStranded({ status: 'processing', payload: { startedAt: NOW - 1000 }, requestedAt: 0 }, NOW)).toBe(false);
  });

  it('claims a run older than the staleness threshold', () => {
    expect(isStranded({ status: 'processing', payload: { startedAt: NOW - STALE_AFTER_MS }, requestedAt: 0 }, NOW)).toBe(true);
  });

  it('uses `startedAt`, NOT `requested_at` — the latter is insert-only', () => {
    // A row asked for hours ago but re-driven a second ago is LIVE. Keying on
    // `requested_at` would re-drive it every foreground, forever.
    expect(isStranded({ status: 'processing', payload: { startedAt: NOW - 1 }, requestedAt: NOW - 86_400_000 }, NOW)).toBe(false);
  });

  it('falls back to `requested_at` for a row written before `startedAt` existed', () => {
    expect(isStranded({ status: 'processing', payload: {}, requestedAt: NOW - STALE_AFTER_MS - 1 }, NOW)).toBe(true);
  });

  it('never claims a terminal row', () => {
    for (const status of ['complete', 'blocked']) {
      expect(isStranded({ status, payload: { startedAt: 0 }, requestedAt: 0 }, NOW)).toBe(false);
    }
  });

  it('claims `failed` too — it is explicitly non-terminal and nothing else retries it', () => {
    expect(isStranded({ status: 'failed', payload: { startedAt: 0 }, requestedAt: 0 }, NOW)).toBe(true);
  });
});

describe('handler', () => {
  it('re-drives a stranded row', async () => {
    mockList.mockResolvedValueOnce([stale()]).mockResolvedValueOnce([]);
    const ctx = makeCtx();
    await def.handler(undefined, ctx);
    expect(mockRedrive).toHaveBeenCalledTimes(1);
    expect(ctx.markNoOp).not.toHaveBeenCalled();
  });

  it('never double-drives a run that is still in flight', async () => {
    mockList.mockResolvedValueOnce([stale()]).mockResolvedValueOnce([]);
    mockInFlight.mockReturnValue(true);
    await def.handler(undefined, makeCtx());
    expect(mockRedrive).not.toHaveBeenCalled();
  });

  it('is bounded to MAX_PER_PASS re-drives', async () => {
    mockList
      .mockResolvedValueOnce(
        Array.from({ length: 10 }, (_, i) => stale({ id: `r${i}`, claimKey: `k${i}` })),
      )
      .mockResolvedValueOnce([]);
    await def.handler(undefined, makeCtx());
    expect(mockRedrive).toHaveBeenCalledTimes(MAX_PER_PASS);
  });

  it('blocks — never verdicts — a row that has burned its attempts', async () => {
    mockList
      .mockResolvedValueOnce([stale({ payload: { startedAt: 0, attempts: 3 } })])
      .mockResolvedValueOnce([]);
    await def.handler(undefined, makeCtx());

    expect(mockRedrive).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const written = mockUpsert.mock.calls[0][0];
    expect(written.status).toBe('blocked');
    expect(written.verdict).toBeNull();
    expect(written.payload.verdict).toBeNull();
    expect(written.payload.blockedReason).toBe('attempts-exhausted');
    // …and it stays keyed to the same claim, so it replaces its own row rather
    // than colliding with another claim on the article.
    expect(written.claimKey).toBe('k1');
  });

  it('marks a pass that did nothing as a no-op so the next foreground retries', async () => {
    mockList.mockResolvedValue([]);
    const ctx = makeCtx();
    await def.handler(undefined, ctx);
    expect(ctx.markNoOp).toHaveBeenCalled();
  });

  it('skips a fresh row without touching it', async () => {
    mockList
      .mockResolvedValueOnce([stale({ payload: { startedAt: NOW - 1000, attempts: 1 } })])
      .mockResolvedValueOnce([]);
    await def.handler(undefined, makeCtx());
    expect(mockRedrive).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
