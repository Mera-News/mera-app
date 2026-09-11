// persona-hygiene-task.test.ts — the credential gate in front of a BILLED sweep.
//
// Mock functions live INSIDE the jest.mock factories for the hoisting reason
// push-token-check-task.test.ts documents: Babel hoists the task import above
// both jest.mock() and const declarations.

jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { register: jest.fn() },
}));

jest.mock('@/lib/auth-client', () => ({
  authClient: { getCookie: jest.fn() },
}));

jest.mock('@/lib/database/services/hygiene-service', () => ({
  runHygieneSweep: jest.fn(),
}));

jest.mock('@/lib/database/services/topic-topup-service', () => ({
  runTopicTopup: jest.fn(async () => ({ ran: false, appended: 0, considered: 0 })),
}));

jest.mock('@/lib/scheduler/background-idle', () => ({
  backgroundWorkIsIdle: jest.fn(() => true),
}));

import '../persona-hygiene-task';

const { AppScheduler: { register: mockRegister } } = jest.requireMock('@/lib/scheduler/AppScheduler') as any;
const { authClient: mockAuthClient } = jest.requireMock('@/lib/auth-client') as any;
const { runHygieneSweep: mockRunHygieneSweep } = jest.requireMock('@/lib/database/services/hygiene-service') as any;

const registeredDef = mockRegister.mock.calls[0]?.[0];

function makeCtx() {
  return {
    jobId: 'job-hygiene-1',
    attempt: 1,
    signal: new AbortController().signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    markNoOp: jest.fn(),
  };
}

describe('persona-hygiene-task registration', () => {
  it('registers as a weekly, trigger-less task', () => {
    expect(registeredDef.name).toBe('persona-hygiene');
    expect(registeredDef.frequency).toBe(7 * 24 * 60 * 60 * 1000);
    // `triggers: []` is load-bearing: it is why the AppScheduler tick gate
    // catches up on the interval rather than on the app-foreground trigger.
    expect(registeredDef.triggers).toEqual([]);
  });
});

describe('persona-hygiene-task — credential gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunHygieneSweep.mockResolvedValue({ ran: true, proposalCount: 0, sanitySkipped: false });
  });

  // The sweep contains a billed cloud batch that cannot succeed without a
  // credential, and letting it run would arm the weekly cooldown off a run that
  // did nothing.
  it('does not run the sweep when there is no local credential', async () => {
    mockAuthClient.getCookie.mockReturnValue('');
    const ctx = makeCtx();

    await registeredDef.handler(undefined, ctx);

    expect(mockRunHygieneSweep).not.toHaveBeenCalled();
    // markNoOp so `lastRun` is NOT stamped — the next tick retries as soon as a
    // credential exists. Nothing is billed on this path, so that is free.
    expect(ctx.markNoOp).toHaveBeenCalledTimes(1);
  });

  // A locked keychain (pre-first-unlock on a background wake) throws. For a
  // sweep that can simply run later, that is "no credential".
  it('treats a throwing keychain read as no credential', async () => {
    mockAuthClient.getCookie.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    const ctx = makeCtx();

    await registeredDef.handler(undefined, ctx);

    expect(mockRunHygieneSweep).not.toHaveBeenCalled();
    expect(ctx.markNoOp).toHaveBeenCalledTimes(1);
  });

  it('runs the sweep and does NOT markNoOp when a credential is present', async () => {
    mockAuthClient.getCookie.mockReturnValue('better-auth.session_token=abc');
    const ctx = makeCtx();

    await registeredDef.handler(undefined, ctx);

    expect(mockRunHygieneSweep).toHaveBeenCalledTimes(1);
    expect(ctx.markNoOp).not.toHaveBeenCalled();
  });

  // A credential that disappears MID-RUN is the sweep's problem, not the gate's:
  // lastRun is stamped normally (no markNoOp) and only the service-level
  // cooldown is withheld, so the weekly cadence holds without hammering.
  it('does NOT markNoOp when the sweep reports the audit was skipped', async () => {
    mockAuthClient.getCookie.mockReturnValue('better-auth.session_token=abc');
    mockRunHygieneSweep.mockResolvedValue({ ran: true, proposalCount: 0, sanitySkipped: true });
    const ctx = makeCtx();

    await registeredDef.handler(undefined, ctx);

    expect(ctx.markNoOp).not.toHaveBeenCalled();
  });
});

export {};
