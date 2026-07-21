// feedback-cycle-task.test.ts — registration + handler for the daily feed
// optimisation cycle. Mocks defined inside jest.mock factories (Babel hoists the
// task import above const declarations); mocks retrieved via jest.requireMock.

jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { register: jest.fn() },
}));

jest.mock('@/lib/database/services/optimisation-plan-service', () => ({
  runOptimisationCycle: jest.fn(),
}));

// Load the task — triggers the registration side-effect.
import '../feedback-cycle-task';

const { AppScheduler: { register: mockRegister } } = jest.requireMock(
  '@/lib/scheduler/AppScheduler',
) as any;
const { runOptimisationCycle: mockRun } = jest.requireMock(
  '@/lib/database/services/optimisation-plan-service',
) as any;

const registeredDef = mockRegister.mock.calls[0]?.[0];

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    jobId: 'job-feedback-1',
    attempt: 1,
    signal: new AbortController().signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    ...overrides,
  };
}

describe('feedback-cycle-task registration', () => {
  it('registers with AppScheduler on module load', () => {
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('registers with name feedback-cycle', () => {
    expect(registeredDef.name).toBe('feedback-cycle');
  });

  it('has a daily frequency', () => {
    expect(registeredDef.frequency).toBe(24 * 60 * 60 * 1000);
  });

  it('is exclusive with a db-ready condition and no triggers', () => {
    expect(registeredDef.exclusive).toBe(true);
    expect(registeredDef.conditions.map((c: any) => c.type)).toContain('db-ready');
    expect(registeredDef.triggers).toEqual([]);
  });
});

describe('feedback-cycle-task handler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs the optimisation cycle and logs the outcome', async () => {
    mockRun.mockResolvedValue({ ran: true, autoCount: 2, reviewCount: 1 });
    const ctx = makeCtx();
    await registeredDef.handler(undefined, ctx);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('2 auto'));
  });

  it('logs a skip reason when the cycle does not run', async () => {
    mockRun.mockResolvedValue({ ran: false, reason: 'cooldown', autoCount: 0, reviewCount: 0 });
    const ctx = makeCtx();
    await registeredDef.handler(undefined, ctx);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('cooldown'));
  });

  it('propagates errors from the cycle', async () => {
    mockRun.mockRejectedValueOnce(new Error('boom'));
    await expect(registeredDef.handler(undefined, makeCtx())).rejects.toThrow('boom');
  });
});

export {};
