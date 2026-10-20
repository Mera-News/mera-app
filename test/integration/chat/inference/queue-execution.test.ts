// Running a job: what the queue does with a handler's result, its failures (an Error, a thrown
// string, a thrown nothing, a native crash), the llama context reset (Kev's context: the text runs
// on the built-in model since D37), and a job type this bundle cannot run. Rows are real; the handler is the queue's own seam for the one type under test.
//
// Replaces from lib/inference/__tests__/InferenceQueue.test.ts: executes a topic_gen job; marks the
// job failed when the handler throws; resets the llama context on an empty-message error; unknown
// job type; resetContext error after a native crash; a thrown string; the null-error fallback.
import { decide, disposeModel, RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import logger from '@/lib/logger';
import { completeLocal } from '@/lib/llm/completeLocal';
import { installLlama, llamaReleases, resetFileSystem, until } from '@/test/integration/chat/_helpers';
import { llamaCalls, llamaLoads } from '@/test/helpers/llama';
import { installOnDeviceLlm } from '@/test/helpers/on-device-llm';
import { cleanup, enqueueJob, hold, jobRow, prepare, tick, untilJob } from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

const initLlama = () => (jest.requireMock('llama.rn') as { initLlama: jest.Mock }).initLlama;
/** Kev resident, as after a scoring pass. */
const kevResident = () => decide({ state: {}, questions: { rel: { type: 'score' } } } as never);

beforeEach(async () => {
  resetFileSystem();
  await disposeModel();
  await prepare();
});
afterEach(cleanup);

/** A handler whose first call fails with `thrown`, then parks so the row can be read mid-retry. */
function failOnce(thrown: unknown) {
  const parked = hold();
  let calls = 0;
  const handler = jest.fn(async (..._args: unknown[]) => {
    if (++calls === 1) throw thrown;
    return parked.handler();
  });
  return { handler, release: parked.release };
}

describe('a handler that succeeds', () => {
  it('gets the stored payload and its own job id, and its result is stored on the done row', async () => {
    const handler = jest.fn(async () => ({ topics: ['topicA'] }));
    __setJobHandlerForTests('topic_gen', handler);
    const id = await enqueueJob('topic_gen', { factId: 'f1', factStatement: 'test' });

    await inferenceQueue.start();
    const row = await untilJob(id, ['done']);

    expect(handler).toHaveBeenCalledWith({ factId: 'f1', factStatement: 'test' }, { jobId: id });
    expect(row).toMatchObject({ status: 'done', attempts: 1, result: { topics: ['topicA'] } });
  });

  it('serves the higher priority first, then the oldest', async () => {
    const order: string[] = [];
    for (const type of ['persona_summary', 'topic_gen'] as const) {
      __setJobHandlerForTests(type, async (payload) => {
        order.push(`${type}:${(payload as { n: string }).n}`);
        return {};
      });
    }
    await enqueueJob('persona_summary', { n: 'a' });
    await tick(5);
    await enqueueJob('persona_summary', { n: 'b' });
    await tick(5);
    const last = await enqueueJob('topic_gen', { n: 'c' });

    await inferenceQueue.start();
    await untilJob(last, ['done']);
    await tick(0);

    expect(order).toEqual(['topic_gen:c', 'persona_summary:a', 'persona_summary:b']);
  });
});

describe('a handler that fails', () => {
  it('gives the job back pending with its message and the attempt counted, then destroys it at the limit', async () => {
    const handler = jest.fn(async () => {
      throw new Error('inference crashed');
    });
    __setJobHandlerForTests('persona_summary', handler);
    const id = await enqueueJob('persona_summary', {});

    await inferenceQueue.start();
    await untilJob(id, ['gone']);

    // maxAttempts is 3 and a failure is retried at once: three runs, then the row is destroyed.
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['an Error', new Error('inference crashed'), 'inference crashed'],
    ['a thrown string', 'string error', 'string error'],
    ['a thrown null', null, 'Native crash (no error message)'],
  ])('%s is stored as the error message of the retried row', async (_label, thrown, message) => {
    const { handler, release } = failOnce(thrown);
    __setJobHandlerForTests('persona_summary', handler);
    const id = await enqueueJob('persona_summary', {});

    await inferenceQueue.start();
    await untilJob(id, ['running']);
    await tick(0);
    await untilJob(id, ['running']);

    // Second run in flight: the first attempt's failure is on the row.
    expect(await jobRow(id)).toMatchObject({ status: 'running', attempts: 2, errorMessage: message });
    release();
    await untilJob(id, ['done']);
  });

  it('a failure with a message leaves the llama context alone', async () => {
    installLlama([]);
    await kevResident();
    __setJobHandlerForTests('persona_summary', async () => {
      throw new Error('plain failure');
    });
    const id = await enqueueJob('persona_summary', {}, { maxAttempts: 1 });

    await inferenceQueue.start();
    await untilJob(id, ['gone']);

    expect(llamaReleases()).toBe(0);
  });

  it('a native crash (no message) releases Kev\'s context; the next text job runs on the built-in model', async () => {
    installLlama([]);
    installOnDeviceLlm({ reply: 'x' });
    await kevResident();
    expect(initLlama()).toHaveBeenCalledTimes(1);
    __setJobHandlerForTests('persona_summary', async () => {
      throw new Error('');
    });
    const crashing = await enqueueJob('persona_summary', {}, { maxAttempts: 1 });
    await inferenceQueue.start();
    await untilJob(crashing, ['gone']);
    await until(() => llamaReleases() === 1, 5000, 'context release');
    // Releasing is all the reset does: no reload until a job needs the model.
    expect(initLlama()).toHaveBeenCalledTimes(1);

    __setJobHandlerForTests('story_headline', async () => ({ answer: await completeLocal({ systemPrompt: 's', prompt: 'p' }) }));
    const after = await enqueueJob('story_headline', {});
    inferenceQueue.notify();
    const row = await untilJob(after, ['done']);
    expect(row).toMatchObject({ result: { answer: 'x' } });
    // The text job needs no llama.rn model: Kev is not reloaded for it.
    expect(llamaLoads()).toEqual([RELEVANCE_MODEL.modelId]);
    expect(llamaCalls()).toHaveLength(0);
  });

  it('a context reset that itself fails is logged and the queue carries on with the next job', async () => {
    const error = jest.spyOn(logger, 'error');
    // The resident context refuses to release: the reset after the crash fails.
    installLlama([]);
    const installed = initLlama().getMockImplementation()!;
    initLlama().mockImplementationOnce(async (p: unknown) => {
      const ctx = await installed(p);
      ctx.release = async () => {
        throw new Error('context reset failed');
      };
      return ctx;
    });
    await kevResident();
    __setJobHandlerForTests('persona_summary', async () => {
      throw new Error('');
    });
    const crashing = await enqueueJob('persona_summary', {}, { maxAttempts: 1 });
    const next = jest.fn(async () => ({}));
    __setJobHandlerForTests('story_headline', next);
    const after = await enqueueJob('story_headline', {});

    await inferenceQueue.start();
    await untilJob(after, ['done']);
    await untilJob(crashing, ['gone']);
    await until(() => error.mock.calls.some((c) => c[0] === '[InferenceQueue] Context reset failed'), 5000, 'reset failure log');

    expect(await jobRow(crashing)).toBeNull();
    expect(error).toHaveBeenCalledWith('[InferenceQueue] Context reset failed', expect.any(Error));
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('a job after a scoring pass', () => {
  it('a topic_gen job runs on the built-in model and Kev stays resident', async () => {
    installLlama([]);
    installOnDeviceLlm({ reply: 'topics' });
    await kevResident();
    __setJobHandlerForTests('topic_gen', async () => ({ answer: await completeLocal({ systemPrompt: 's', prompt: 'p' }) }));
    const id = await enqueueJob('topic_gen', {});

    await inferenceQueue.start();
    const row = await untilJob(id, ['done']);

    expect(row).toMatchObject({ result: { answer: 'topics' } });
    expect(llamaLoads()).toEqual([RELEVANCE_MODEL.modelId]);
    expect(llamaCalls()).toHaveLength(0);
  });
});

describe('a job type this bundle cannot run (an OTA rollback)', () => {
  it('counts an attempt each pass and is destroyed at the limit, so it can neither spin forever nor block the queue', async () => {
    const error = jest.spyOn(logger, 'error');
    const real = jest.fn(async () => ({}));
    for (const t of ['topic_gen', 'persona_summary', 'tracked_story_migrate', 'topic_combo'] as const) {
      __setJobHandlerForTests(t, real);
    }
    const unknown = await enqueueJob('rolled_back_type' as never, { n: 1 }, { priority: 5 });
    const behind = jest.fn(async () => ({}));
    __setJobHandlerForTests('story_headline', behind);
    const later = await enqueueJob('story_headline', {});

    await inferenceQueue.start();
    await untilJob(later, ['done']);

    expect(await jobRow(unknown)).toBeNull();
    expect(real).not.toHaveBeenCalled();
    const unknownLogs = error.mock.calls.filter((c) => c[0] === '[InferenceQueue] Unknown job type');
    expect(unknownLogs).toHaveLength(3);
    expect(unknownLogs[0][1]).toMatchObject({ jobType: 'rolled_back_type', jobId: unknown });
    expect(behind).toHaveBeenCalledTimes(1);
  });
});
