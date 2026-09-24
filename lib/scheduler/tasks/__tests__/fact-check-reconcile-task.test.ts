// fact-check-reconcile-task — registration shape + handler.
//
// Mocks are created inside the factories and read back via jest.requireMock:
// Babel hoists the task import above any module-level const.

jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { register: jest.fn() },
}));

jest.mock('@/lib/fact-check/fact-check-graphql-client', () => ({
  reconcileAskedFactChecks: jest.fn(async () => 0),
}));

import '../fact-check-reconcile-task';

const {
  AppScheduler: { register: mockRegister },
} = jest.requireMock('@/lib/scheduler/AppScheduler') as any;
const { reconcileAskedFactChecks: mockReconcile } = jest.requireMock(
  '@/lib/fact-check/fact-check-graphql-client',
) as any;

const def = mockRegister.mock.calls[0]?.[0];

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

describe('fact-check-reconcile-task registration', () => {
  it('registers once, by name', () => {
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(def.name).toBe('fact-check-reconcile');
  });

  // frequency 0 is what keeps it off the 5s tick; a positive cadence would
  // poll the server on a timer for every device.
  it('is event-driven only: frequency 0, foreground and reconnect triggers', () => {
    expect(def.frequency).toBe(0);
    expect([...def.triggers].sort()).toEqual(['app-foreground', 'network-reconnect']);
  });

  // Exact list, not toContain: an added condition must fail here rather than
  // ship green (a condition never applies to trigger() anyway).
  it('is gated on exactly db-ready and network', () => {
    expect(def.conditions.map((c: { type: string }) => c.type)).toEqual(['db-ready', 'network']);
  });

  it('is exclusive with a single attempt', () => {
    expect(def.exclusive).toBe(true);
    expect(def.maxAttempts).toBe(1);
  });
});

describe('fact-check-reconcile-task handler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls reconcileAskedFactChecks once', async () => {
    await def.handler(undefined, makeCtx());
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('logs how many asked checks are still waiting', async () => {
    mockReconcile.mockResolvedValueOnce(2);
    const ctx = makeCtx();
    await def.handler(undefined, ctx);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('2 still waiting'));
  });

  it('never calls ctx.markNoOp (nothing pending is the normal state)', async () => {
    const ctx = makeCtx();
    await def.handler(undefined, ctx);
    expect(ctx.markNoOp).not.toHaveBeenCalled();
  });
});
