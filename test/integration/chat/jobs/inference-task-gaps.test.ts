// Payload shapes of the silent-push task (lib/background/inference-task.ts) that the legacy suite
// reached and inference-task.test.ts does not: the flat `body.data` shape with only one of its two
// fields. Same drive as that file: the body registered with expo-task-manager is called with a
// payload, and the real cycle, pipeline, DB and gateway mock answer.
import * as TaskManager from 'expo-task-manager';
import { defineInferenceTask } from '@/lib/background/inference-task';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { drive, gatewayPolls, ids, resetCycleWorld, submitJobs, watchResultsGets } from './support';

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
const taskBody = (TaskManager.defineTask as jest.Mock).mock.calls[0][1] as (body: unknown) => Promise<unknown>;

beforeEach(resetCycleWorld);
afterEach(() => jest.restoreAllMocks());

describe('the flat body.data shape with one field', () => {
  it('a type and no request id is a general tick: waiting jobs polled oldest first', async () => {
    const jobs = await submitJobs(ids(5, 'a'), ids(5, 'b'));
    gatewayPolls(0);
    await jest.advanceTimersByTimeAsync(2_000);
    const gets = watchResultsGets();
    // An unknown id also ticks, so the polls cannot tell "no id" from a bad one: read what the cycle was handed.
    const handlePush = jest.spyOn(pipeline, 'handlePush');

    await drive(taskBody({ data: { type: 'inference-done' } }));

    expect(handlePush).toHaveBeenCalledWith(undefined, expect.anything());
    expect(gets[0].id).toBe(jobs[0]);
    expect(gets.every((g) => jobs.includes(g.id) && g.auth === `Bearer cap.${g.id}`)).toBe(true);
  });

  it('a request id and no type advances exactly that batch', async () => {
    const [first, second] = await submitJobs(ids(5, 'a'), ids(5, 'b'));
    gatewayPolls(0);
    const gets = watchResultsGets();

    await drive(taskBody({ data: { requestId: second } }));

    expect(gets).toEqual([{ id: second, auth: `Bearer cap.${second}` }]);
    expect(gets.map((g) => g.id)).not.toContain(first);
  });
});
