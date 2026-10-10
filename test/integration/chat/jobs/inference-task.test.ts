// The silent-push TaskManager task (lib/background/inference-task.ts) driven the way the OS drives
// it: the body registered with expo-task-manager is captured from the native mock and called with
// notification payloads. Behind it the REAL runBackgroundCycle, scoring pipeline, DB, limiter and
// gateway mock run, so the assertions are observable outcomes: which job ids the app polled, with
// which Authorization, which rows were scored, what the task returned.
//
// A push naming a request id advances exactly that batch; anything else (no id, an unknown id, a
// payload nobody can read) is a general tick that polls every waiting job. The push TYPE has no
// effect on the route; it only names the cycle in the error report, so the mapping is pinned
// through a fault injected on one call of the real pipeline (R23).
//
// Replaces lib/background/__tests__/inference-task.test.ts (21 tests).
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { INFERENCE_TASK, defineInferenceTask, ensureSilentPushTaskRegistered } from '@/lib/background/inference-task';
import { loadSuggestions } from '@/lib/database/services/article-suggestion-service';
import { invalidateJwtCache } from '@/lib/auth-client';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { __resetAuthReadQuarantineForTests, releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { HAS_LAUNCHED_SETTING_KEY, __resetInstallBoundaryForTests } from '@/lib/security/install-boundary';
import { setSetting } from '@/lib/database/services/setting-service';
import * as executionContext from '@/lib/llm/execution-context';
import logger from '@/lib/logger';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { server } from '@/test/helpers';
import {
  drive,
  gatewayPolls,
  ids,
  reasonJobCalls,
  resetCycleWorld,
  submitJobs,
  watchCookieAuthRequests,
  watchResultsGets,
} from './support';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

jest.setTimeout(90_000);

// Register once, at load: the per-test mock reset would otherwise clear the call that holds the body.
defineInferenceTask();
const defineCalls = (TaskManager.defineTask as jest.Mock).mock.calls.slice();
const taskBody = defineCalls[0][1] as (body: unknown) => Promise<unknown>;

// The shared native mock of expo-notifications has no registerTaskAsync; this file owns that edge.
const registerTaskAsync = jest.fn();
(Notifications as unknown as { registerTaskAsync: unknown }).registerTaskAsync = registerTaskAsync;

const iosPush = (data: Record<string, unknown>) => ({ data: { notification: { request: { content: { data } } } } });

const scored = async () =>
  (await loadSuggestions()).filter((s) => s.relevance !== null && s.relevance !== undefined && s.relevance > 0).length;

beforeEach(async () => {
  registerTaskAsync.mockResolvedValue(undefined);
  await resetCycleWorld();
});
afterEach(() => {
  server.events.removeAllListeners();
  jest.restoreAllMocks();
});

describe('registration', () => {
  it('defines the task under INFERENCE_TASK exactly once, however often it is asked', () => {
    expect(defineCalls).toHaveLength(1);
    expect(defineCalls[0][0]).toBe(INFERENCE_TASK);
    expect(INFERENCE_TASK).toBe('mera-inference-task');
    defineInferenceTask();
    defineInferenceTask();
    expect(TaskManager.defineTask).not.toHaveBeenCalled();
  });

  it('ensureSilentPushTaskRegistered registers the push wake for that task', async () => {
    await ensureSilentPushTaskRegistered();
    expect(registerTaskAsync).toHaveBeenCalledWith(INFERENCE_TASK);
  });

  it('a refused registration is reported, never thrown', async () => {
    const err = new Error('registration failed');
    registerTaskAsync.mockRejectedValueOnce(err);
    await expect(ensureSilentPushTaskRegistered()).resolves.toBeUndefined();
    expect(logger.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: expect.objectContaining({ service: 'inference-task', step: 'register-push' }) }),
    );
  });
});

describe('a wake that names a request id', () => {
  it('advances that batch: one results GET with the capability token, the relevance applied', async () => {
    const [first, second] = await submitJobs(ids(5, 'a'), ids(5, 'b'));
    gatewayPolls(0);
    const gets = watchResultsGets();

    const out = await drive(taskBody(iosPush({ type: 'inference-done', requestId: second })));

    expect(out).toBeUndefined();
    // Exactly the named job, not the other waiting one; a background wake authenticates with the token alone.
    expect(gets).toEqual([{ id: second, auth: `Bearer cap.${second}` }]);
    expect(gets.map((g) => g.id)).not.toContain(first);
    expect(await scored()).toBe(5);
  });

  it.each([
    ['the iOS notification shape', (id: string) => iosPush({ type: 'inference-done', requestId: id })],
    ['body.data.data', (id: string) => ({ data: { data: { type: 'inference-done', requestId: id } } })],
    ['body.data.dataString (Android JSON)', (id: string) => ({ data: { dataString: JSON.stringify({ type: 'inference-done', requestId: id }) } })],
    ['top-level body.data fields', (id: string) => ({ data: { type: 'inference-done', requestId: id } })],
  ])('reads the request id from %s', async (_label, shape) => {
    const [, second] = await submitJobs(ids(5, 'a'), ids(5, 'b'));
    gatewayPolls(0);
    const gets = watchResultsGets();
    await drive(taskBody(shape(second)));
    expect(gets.map((g) => g.id)).toEqual([second]);
  });
});

describe('a wake that names nothing usable is a general tick', () => {
  it.each([
    ['no request id (inference-done)', iosPush({ type: 'inference-done' })],
    ['an unknown type', iosPush({ type: 'unknown-type' })],
    ['process-clusters', iosPush({ type: 'process-clusters' })],
    ['a body with no data', {}],
    ['an empty data object', { data: {} }],
    ['dataString that is not JSON', { data: { dataString: 'not-valid-json' } }],
  ])('%s: ticks the waiting jobs, oldest first, with the capability token', async (_label, body) => {
    const jobs = await submitJobs(ids(5, 'a'), ids(5, 'b'));
    gatewayPolls(0);
    // A real wake comes long after the submits; the limiter has a slot free by then.
    await jest.advanceTimersByTimeAsync(2_000);
    const gets = watchResultsGets();

    await expect(drive(taskBody(body))).resolves.toBeUndefined();

    expect(gets.length).toBeGreaterThan(0);
    expect(gets[0].id).toBe(jobs[0]);
    expect(gets.every((g) => jobs.includes(g.id) && g.auth === `Bearer cap.${g.id}`)).toBe(true);
  });

  it('an id no batch carries also falls through to the general tick', async () => {
    const jobs = await submitJobs(ids(5, 'a'));
    gatewayPolls(0);
    await jest.advanceTimersByTimeAsync(2_000);
    const gets = watchResultsGets();
    await drive(taskBody(iosPush({ type: 'inference-done', requestId: 'f'.repeat(24) })));
    expect(gets.map((g) => g.id)).toEqual(jobs);
  });

  it('with nothing in flight it does no gateway work and still resolves', async () => {
    const gets = watchResultsGets();
    await expect(drive(taskBody(iosPush({ type: 'inference-done', requestId: 'a'.repeat(24) })))).resolves.toBeUndefined();
    expect(gets).toEqual([]);
    expect(logger.captureException).not.toHaveBeenCalled();
  });
});

describe('the push type names the cycle in the report', () => {
  it.each([
    ['phase1-done', 'phase1-done'],
    ['phase2-done', 'phase2-done'],
    ['inference-done', 'silent-push'],
    ['process-clusters', 'silent-push'],
    ['something-new', 'silent-push'],
    [undefined, 'silent-push'],
  ])('type %s runs as %s', async (type, reason) => {
    const boom = new Error('boom');
    jest.spyOn(pipeline, 'handlePush').mockRejectedValueOnce(boom);
    await expect(taskBody(iosPush({ type }))).resolves.toBeUndefined();
    expect(logger.captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ tags: expect.objectContaining({ service: 'run-background-cycle', reason }) }),
    );
  });

  it('an error outside the cycle\'s own handling is reported under the task and never thrown to the OS', async () => {
    const boom = new Error('background cycle error');
    jest.spyOn(executionContext, 'contextForCycleReason').mockImplementationOnce(() => {
      throw boom;
    });
    await expect(taskBody(iosPush({ type: 'inference-done' }))).resolves.toBeUndefined();
    expect(logger.captureException).toHaveBeenCalledWith(boom, expect.objectContaining({ tags: { service: 'inference-task' } }));
  });
});

describe('before the install boundary has run', () => {
  it('a wake collects with the capability token and asks the auth server for nothing with a cookie', async () => {
    const [id] = await submitJobs(ids(5, 'a'));
    gatewayPolls(0);
    // A cold process: the session cookie reads null until enforceInstallBoundary() releases the latch.
    __resetAuthReadQuarantineForTests();
    const cookieRequests = watchCookieAuthRequests();
    const gets = watchResultsGets();

    await drive(taskBody(iosPush({ type: 'inference-done', requestId: id })));

    expect(gets).toEqual([{ id, auth: `Bearer cap.${id}` }]);
    expect(cookieRequests).toEqual([]);
    expect(await scored()).toBe(5);
  });

  /** A wake that collects the relevance of one finished job; did it also send the reasons job? */
  async function wakeAndCountReasonJobs(cold: boolean, boundaryRan = false) {
    const [id] = await submitJobs(ids(5, 'a'));
    gatewayPolls(0);
    await jest.advanceTimersByTimeAsync(2_000);
    if (cold) {
      // A fresh process: no cached attestation or JWT, and the cookie reads null until the boundary runs.
      clearAttestationCache();
      invalidateJwtCache();
      __resetAuthReadQuarantineForTests();
      // A fresh process has not run the boundary yet, on an install that has launched before.
      __resetInstallBoundaryForTests();
      await setSetting(HAS_LAUNCHED_SETTING_KEY, '1');
      // What enforceInstallBoundary() does in its finally, once it has run.
      if (boundaryRan) releaseAuthReadQuarantine();
    }
    await drive(taskBody(iosPush({ type: 'inference-done', requestId: id })));
    // Only the wake's own work counts: no foreground tick helps it along.
    await jest.advanceTimersByTimeAsync(4_000);
    return reasonJobCalls().length;
  }

  it('control: a fresh process whose boundary has run submits the reasons job on the same wake', async () => {
    expect(await wakeAndCountReasonJobs(true, true)).toBeGreaterThan(0);
  });

  test('a cold silent-push wake submits the reasons job (enforceInstallBoundary runs first)', async () => {
    expect(await wakeAndCountReasonJobs(true)).toBeGreaterThan(0);
  });

});
