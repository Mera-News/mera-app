// inference-recover-task.test.ts — tests for inference-recover-task registration + handler

// All mock functions are defined INSIDE the jest.mock factories (not as module-level
// consts) to avoid the hoisting issue: Babel hoists `import '../inference-recover-task'`
// above both jest.mock() and const declarations, so module-level consts are still
// undefined when the mock factory's return values are called at module-load time.
// Tests access the mocks via jest.requireMock().

jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { register: jest.fn() },
}));

jest.mock('@/lib/services/cycle-state-machine', () => ({
  recoverCycle: jest.fn(),
}));

// The task now imports two DB services, and `lib/database/index` opens SQLite
// at IMPORT time — so without these the jest worker dies with
// "Cannot read properties of undefined (reading 'initializeJSI')", naming none
// of these files.
jest.mock('@/lib/database/services/fact-service', () => ({
  rescueStalePendingTopicFacts: jest.fn(async () => 0),
}));
jest.mock('@/lib/database/services/topic-decline-service', () => ({
  flushPendingDeletes: jest.fn(async () => 0),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    captureException: jest.fn(),
  },
}));

// Load the task — triggers registration side-effect
import '../inference-recover-task';

// Retrieve mock references after module load
const { AppScheduler: { register: mockRegister } } = jest.requireMock('@/lib/scheduler/AppScheduler') as any;
const { recoverCycle: mockRecoverCycle } = jest.requireMock('@/lib/services/cycle-state-machine') as any;

const registeredDef = mockRegister.mock.calls[0]?.[0];

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    jobId: 'job-recover-1',
    attempt: 1,
    signal: new AbortController().signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    markNoOp: jest.fn(),
    ...overrides,
  };
}

describe('inference-recover-task registration', () => {
  it('registers with AppScheduler on module load', () => {
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('registers with name inference-recover', () => {
    expect(registeredDef.name).toBe('inference-recover');
  });

  it('has app-foreground trigger', () => {
    expect(registeredDef.triggers).toContain('app-foreground');
  });

  it('has frequency of 0 (event-driven only)', () => {
    expect(registeredDef.frequency).toBe(0);
  });

  it('is gated on db-ready ONLY', () => {
    const types = registeredDef.conditions.map((c: any) => c.type);
    expect(types).toEqual(['db-ready']);
  });

  it('is deliberately NOT gated on authenticated or network, so a wedged local run can self-heal during a needsReauth / offline window', () => {
    const types = registeredDef.conditions.map((c: any) => c.type);
    expect(types).not.toContain('authenticated');
    expect(types).not.toContain('network');
  });

  it('is exclusive', () => {
    expect(registeredDef.exclusive).toBe(true);
  });

  it('has maxAttempts of 1', () => {
    expect(registeredDef.maxAttempts).toBe(1);
  });
});

describe('inference-recover-task handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecoverCycle.mockResolvedValue('idle');
  });

  it('calls recoverCycle', async () => {
    const ctx = makeCtx();
    await registeredDef.handler(undefined, ctx);
    expect(mockRecoverCycle).toHaveBeenCalledTimes(1);
  });

  it('rescues stale pending facts AND flushes staged topic deletes', async () => {
    // This task carries the "app start and every foreground" half of both
    // contracts. InferenceQueue.start() is NOT a reliable cold-start hook —
    // in on-device mode it waits for the model to load — and a component must
    // never own the staged-delete timer.
    const { rescueStalePendingTopicFacts } = jest.requireMock(
      '@/lib/database/services/fact-service',
    ) as any;
    const { flushPendingDeletes } = jest.requireMock(
      '@/lib/database/services/topic-decline-service',
    ) as any;

    await registeredDef.handler(undefined, makeCtx());

    expect(rescueStalePendingTopicFacts).toHaveBeenCalledTimes(1);
    expect(flushPendingDeletes).toHaveBeenCalledTimes(1);
  });

  it('never calls ctx.markNoOp — a routine skip there is a silent 5s loop', async () => {
    // "nothing to rescue, nothing staged" is the NORMAL state on most
    // devices. Suppressing the lastRun stamp for it would re-fire this task
    // every tick forever, and nothing else catches that: the failure backoff
    // arms only after a FAILURE, and a no-op is not one.
    const ctx = makeCtx();
    await registeredDef.handler(undefined, ctx);
    expect(ctx.markNoOp).not.toHaveBeenCalled();
  });

  it('logs recovering cycle message before calling recoverCycle', async () => {
    const ctx = makeCtx();
    await registeredDef.handler(undefined, ctx);
    expect(ctx.log).toHaveBeenCalledWith('recovering cycle');
  });

  it('propagates errors from recoverCycle', async () => {
    mockRecoverCycle.mockRejectedValueOnce(new Error('cycle recovery failed'));

    await expect(registeredDef.handler(undefined, makeCtx())).rejects.toThrow(
      'cycle recovery failed',
    );
  });

  it('succeeds when recoverCycle returns non-idle state', async () => {
    mockRecoverCycle.mockResolvedValue('waiting-for-reason');
    await expect(registeredDef.handler(undefined, makeCtx())).resolves.toBeUndefined();
  });
});

export {};
