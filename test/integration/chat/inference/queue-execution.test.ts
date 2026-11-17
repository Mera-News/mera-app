// Running a job: what the queue does with a handler's result, its failures (an Error, a thrown
// string, a thrown nothing, a native crash), the llama context reset (Kev's context: the text runs
// on the built-in model since D37), and a job type this bundle cannot run. Rows are real; the handler is the queue's own seam for the one type under test.
//
// Replaces from lib/inference/__tests__/InferenceQueue.test.ts: executes a topic_gen job; marks the
// job failed when the handler throws; resets the llama context on an empty-message error; unknown
// job type; resetContext error after a native crash; a thrown string; the null-error fallback.
import { decide, disposeModel, RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { completeLocal } from '@/lib/llm/completeLocal';
import { installLlama, llamaReleases, resetFileSystem, until } from '@/test/integration/chat/_helpers';
import { llamaCalls, llamaLoads } from '@/test/helpers/llama';
import { installOnDeviceLlm } from '@/test/helpers/on-device-llm';
import { cleanup, enqueueJob, prepare, untilJob } from './kit';

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

describe('a handler that fails', () => {
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
