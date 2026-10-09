// Topic generation for a saved fact: one queued, isolated `topic_gen` job per fact (ux2 F1),
// cloud or on-device, and the user-initiated retry. The inference queue is NOT started unless a
// test says so, so the rows enqueued are what is asserted.
import { addFact, getFacts, getTopicsStatus } from '@/lib/database/services/fact-service';
import { getByFact } from '@/lib/database/services/topic-service';
import { beginTopicGeneration } from '@/lib/database/services/topic-generation-status-service';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { retryTopicGeneration, startTopicGeneration } from '@/lib/chat-tools/tool-handlers';
import { gatewayCalls, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, setProcessingMode } from '@/test/integration/chat/_helpers';
import { pollUntil, queuedJobs } from './kit';

jest.setTimeout(30_000);

beforeEach(async () => {
  resetChatModules();
  await setProcessingMode('cloud');
  await inferenceQueue.stop();
});

afterEach(async () => {
  await inferenceQueue.stop();
  jest.restoreAllMocks();
});

describe('startTopicGeneration', () => {
  it('cloud: one job per fact carrying its skill, wakes the queue, and makes no model call itself', async () => {
    const notify = jest.spyOn(inferenceQueue, 'notify');

    await startTopicGeneration([
      { id: 'f1', statement: 'Lives in Porto', skillId: 'topics/residence' },
      { id: 'f2', statement: 'Works as a nurse' },
    ]);

    expect(await queuedJobs()).toEqual([
      {
        type: 'topic_gen',
        status: 'pending',
        payload: { factId: 'f1', factStatement: 'Lives in Porto', useCloud: true, skillId: 'topics/residence' },
      },
      { type: 'topic_gen', status: 'pending', payload: { factId: 'f2', factStatement: 'Works as a nurse', useCloud: true } },
    ]);
    expect(notify).toHaveBeenCalled();
    // Resolves when the jobs are enqueued, not when generation is done: no inline batch call.
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('on-device: the same job, flagged useCloud false for the local engine', async () => {
    await setProcessingMode('on-device');

    await startTopicGeneration([{ id: 'f1', statement: 'Lives in Porto' }]);

    expect(await queuedJobs()).toEqual([
      { type: 'topic_gen', status: 'pending', payload: { factId: 'f1', factStatement: 'Lives in Porto', useCloud: false } },
    ]);
  });

  it('an empty list enqueues nothing', async () => {
    await startTopicGeneration([]);
    expect(await queuedJobs()).toEqual([]);
  });

  it('never enqueues a second job for a fact that already has one', async () => {
    await startTopicGeneration([{ id: 'f1', statement: 'Lives in Porto' }]);
    await startTopicGeneration([{ id: 'f1', statement: 'Lives in Porto' }]);
    expect(await queuedJobs()).toHaveLength(1);
  });

  it('two same-tick calls for one fact enqueue once', async () => {
    await Promise.all([
      startTopicGeneration([{ id: 'f1', statement: 'Lives in Porto' }]),
      startTopicGeneration([{ id: 'f1', statement: 'Lives in Porto' }]),
    ]);
    expect(await queuedJobs()).toHaveLength(1);
  });
});

describe('retryTopicGeneration', () => {
  it('clears the stored topicGenError, keeps other metadata, re-stamps pending and enqueues with the skill', async () => {
    const fact = await addFact('Works in AI', { topicGenError: ['boom'], topics: ['old'] }, undefined, {
      topicsStatus: 'error',
    });

    await retryTopicGeneration(fact.id, 'Works in AI', 'topics/profession');

    const [after] = await getFacts();
    expect(after.metadata).toEqual({ topics: ['old'] });
    expect(await getTopicsStatus(fact.id)).toBe('pending');
    expect(await queuedJobs()).toEqual([
      {
        type: 'topic_gen',
        status: 'pending',
        payload: { factId: fact.id, factStatement: 'Works in AI', useCloud: true, skillId: 'topics/profession' },
      },
    ]);
  });

  it('a double-tapped retry enqueues one job', async () => {
    const fact = await addFact('Works in AI');

    await Promise.all([retryTopicGeneration(fact.id, 'Works in AI'), retryTopicGeneration(fact.id, 'Works in AI')]);

    expect(await queuedJobs()).toHaveLength(1);
  });
});

describe('with the queue running', () => {
  it('cloud: the default responder answers the topic call, the topics exist and the fact settles done', async () => {
    await signInFixtureAccount();
    const fact = await addFact('Plays chess');
    await beginTopicGeneration([fact.id]);
    expect(await getTopicsStatus(fact.id)).toBe('pending');

    await startTopicGeneration([{ id: fact.id, statement: 'Plays chess' }]);
    await inferenceQueue.start();
    const status = await pollUntil(() => getTopicsStatus(fact.id), (v) => v === 'done');
    expect(status).toBe('done');
    const topics = await getByFact(fact.id);
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.every((t) => t.status === 'active')).toBe(true);
    expect(gatewayCalls().length).toBeGreaterThan(0);
  });
});
