// push-token-check-task.test.ts — tests for push-token-check-task registration + handler

// All mock functions are defined INSIDE the jest.mock factories (not as module-level
// consts) to avoid the hoisting issue: Babel hoists `import '../push-token-check-task'`
// above both jest.mock() and const declarations, so module-level consts are still
// undefined when the mock factory's return values are called at module-load time.
// Tests access the mocks via jest.requireMock().

jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { register: jest.fn() },
}));

jest.mock('@/lib/notification-service', () => ({
  checkPushTokenRevocation: jest.fn(),
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
import '../push-token-check-task';

// Retrieve mock references after module load
const { AppScheduler: { register: mockRegister } } = jest.requireMock('@/lib/scheduler/AppScheduler') as any;
const { checkPushTokenRevocation: mockCheckPushTokenRevocation } = jest.requireMock('@/lib/notification-service') as any;

const registeredDef = mockRegister.mock.calls[0]?.[0];

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    jobId: 'job-push-check-1',
    attempt: 1,
    signal: new AbortController().signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    ...overrides,
  };
}

describe('push-token-check-task registration', () => {
  it('registers with AppScheduler on module load', () => {
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('registers with name push-token-check', () => {
    expect(registeredDef.name).toBe('push-token-check');
  });

  it('has app-foreground trigger', () => {
    expect(registeredDef.triggers).toContain('app-foreground');
  });

  it('has frequency of 1 hour', () => {
    expect(registeredDef.frequency).toBe(60 * 60 * 1000);
  });

  it('has authenticated condition', () => {
    const types = registeredDef.conditions.map((c: any) => c.type);
    expect(types).toContain('authenticated');
  });

  it('is exclusive', () => {
    expect(registeredDef.exclusive).toBe(true);
  });

  it('has timeout of 10 seconds', () => {
    expect(registeredDef.timeout).toBe(10_000);
  });

  it('has maxAttempts of 2', () => {
    expect(registeredDef.maxAttempts).toBe(2);
  });
});

describe('push-token-check-task handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckPushTokenRevocation.mockResolvedValue(undefined);
  });

  it('calls checkPushTokenRevocation', async () => {
    await registeredDef.handler(undefined, makeCtx());
    expect(mockCheckPushTokenRevocation).toHaveBeenCalledTimes(1);
  });

  it('resolves without error on success', async () => {
    await expect(registeredDef.handler(undefined, makeCtx())).resolves.toBeUndefined();
  });

  it('propagates errors from checkPushTokenRevocation', async () => {
    mockCheckPushTokenRevocation.mockRejectedValueOnce(new Error('token check failed'));

    await expect(registeredDef.handler(undefined, makeCtx())).rejects.toThrow(
      'token check failed',
    );
  });
});

export {};
