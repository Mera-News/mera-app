/* eslint-disable @typescript-eslint/no-require-imports */
// The queue on the phone's built-in model (Apple Foundation Models, Gemini Nano), the only on-device
// text engine since D37. Nano refuses background work and has a per-app quota, Apple throttles, and
// the model can be mid-download:
//   - on-device, nothing starts while the app is not active;
//   - "busy" and "unavailable" defer ANY job type (no attempt spent), and a topic job reaches the
//     queue with them instead of failing its fact ("please delete and retry").
// Real queue, real topic_gen handler and toolkit; the native module and the file system are faked.
import { addFact, getTopicsStatus } from '@/lib/database/services/fact-service';
import { getTrackedStoryById, trackStory } from '@/lib/database/services/tracked-story-service';
import { startTopicGeneration } from '@/lib/chat-tools/tool-handlers';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { setAppState } from '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { resetFileSystem } from '@/test/integration/chat/_helpers';
import { cleanup, driveDone, driveUntil, enqueueJob, jobRow, jobRows, prepare, setMode, tick, untilJob } from './kit';

/** Drives until the row carries a deferral or failure message. */
const untilMessage = (id: string) => driveUntil(async () => !!(await jobRow(id))?.errorMessage, `job ${id} message`, 10_000);

jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

beforeEach(async () => {
  resetFileSystem();
  await disposeModel();
  installOnDeviceLlm();
  await prepare();
  useMeraProtocolStore.getState().setModelState('ready');
  await setMode('on-device');
});
afterEach(async () => {
  setAppState('active');
  await cleanup();
});

describe('the foreground gate', () => {
  it('on the built-in model a job enqueued in the background waits, and runs on the return', async () => {
    const handler = jest.fn(async () => ({}));
    __setJobHandlerForTests('persona_summary', handler);
    setAppState('background');
    const id = await enqueueJob('persona_summary', {});
    await inferenceQueue.start();
    inferenceQueue.notify();
    await tick(60_000);
    expect(handler).not.toHaveBeenCalled();
    expect((await jobRow(id))?.attempts).toBe(0);

    setAppState('active');
    expect((await untilJob(id, ['done']))?.status).toBe('done');
  });

  it('cloud mode runs in the background at once', async () => {
    await setMode('cloud');
    const handler = jest.fn(async () => ({}));
    __setJobHandlerForTests('persona_summary', handler);
    setAppState('background');
    const id = await enqueueJob('persona_summary', {});
    await inferenceQueue.start();
    inferenceQueue.notify();
    expect((await untilJob(id, ['done'], 5_000))?.status).toBe('done');
  });
});

describe('busy and unavailable defer, never fail', () => {
  const pendingFact = (statement: string) => addFact(statement, undefined, undefined, { topicsStatus: 'pending' });

  it.each(['ERR_AFM_BUSY', 'ERR_AFM_UNAVAILABLE'] as const)(
    '%s on a topic job: the job goes back to pending with no attempt spent, the fact keeps waiting, and it runs later',
    async (code) => {
      const fact = await driveDone(pendingFact('Plays chess'));
      await driveDone(startTopicGeneration([{ id: fact.id, statement: 'Plays chess' }]));
      const [job] = await jobRows('topic_gen');
      installOnDeviceLlm({ reply: { error: code } });

      await inferenceQueue.start();
      await untilMessage(job.id);
      const deferred = await jobRow(job.id);
      expect(deferred).toMatchObject({ status: 'pending', attempts: 0 });
      expect(deferred?.errorMessage).toContain(code);
      expect(await getTopicsStatus(fact.id)).toBe('pending');
      // Busy stops the job at its one call: no retry inside the job.
      expect(onDeviceLlmCalls()).toHaveLength(1);

      // A return to the foreground lifts the deferral at once.
      installOnDeviceLlm({ reply: '{"topics":["Chess openings"]}' });
      setAppState('background');
      setAppState('active');
      expect((await untilJob(job.id, ['done']))?.status).toBe('done');
      expect(await getTopicsStatus(fact.id)).toBe('done');
    },
    30_000,
  );

  it('any other engine error is still the fact\'s own failure', async () => {
    const fact = await driveDone(pendingFact('Plays chess'));
    await driveDone(startTopicGeneration([{ id: fact.id, statement: 'Plays chess' }]));
    installOnDeviceLlm({ reply: { error: 'ERR_AFM_CONTEXT' } });

    await inferenceQueue.start();
    const [job] = await jobRows('topic_gen');
    await untilJob(job.id, ['done']);
    expect(await getTopicsStatus(fact.id)).toBe('error');
  });

  it('busy on a tracked-story migrate: the job waits with no attempt spent, the story stays legacy, then migrates', async () => {
    const story = await driveDone(trackStory({ articleId: 'a1', title: 'Floods hit Assam', originSurface: 'feed' }));
    installOnDeviceLlm({ reply: { error: 'ERR_AFM_BUSY' } });
    const id = await enqueueJob('tracked_story_migrate', { trackedStoryId: story.id, titles: ['Floods hit Assam'] });

    await inferenceQueue.start();
    await untilMessage(id);
    expect(await jobRow(id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await getTrackedStoryById(story.id))?.topicId ?? null).toBeNull();

    installOnDeviceLlm({ reply: '{"label":"Assam floods","search":"assam floods"}' });
    setAppState('background');
    setAppState('active');
    expect((await untilJob(id, ['done']))?.status).toBe('done');
    expect((await getTrackedStoryById(story.id))?.llmHeadline).toBe('Assam floods');
  }, 30_000);

  it('busy defers a job type the queue does not otherwise defer', async () => {
    const { OnDeviceLlmError } = jest.requireActual('@/modules/mera-on-device-llm') as typeof import('@/modules/mera-on-device-llm');
    let calls = 0;
    __setJobHandlerForTests('persona_summary', async () => {
      calls += 1;
      if (calls === 1) throw new OnDeviceLlmError('ERR_AFM_BUSY');
      return {};
    });
    const id = await enqueueJob('persona_summary', {});
    await inferenceQueue.start();
    await untilMessage(id);
    expect((await jobRow(id))).toMatchObject({ status: 'pending', attempts: 0 });
    setAppState('background');
    setAppState('active');
    expect((await untilJob(id, ['done']))?.status).toBe('done');
    expect(calls).toBe(2);
  }, 30_000);
});
