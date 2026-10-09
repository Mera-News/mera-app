// The combination pass end to end, once: `enqueueComboPass` writes the jobs, the REAL
// InferenceQueue claims them, the real `topic_combo` handler makes one batched call per fact against
// the gateway mock (sealed both ways), `applyComboTopicsForFact` writes the diff, and the queue's
// end-of-pass check fires the feed sync. The queue's own scheduling (defer gates, backoff, drop on
// on-device) is the chat area's seam (test/integration/chat/inference); this pins what the pass
// leaves in the facts and topics tables.
//
// Driven under a strict clock: the queue's loop, the limiter and the gateway all wait on timers or
// macrotasks, so a wait is always "advance a little, give the event loop real turns, look again".
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { enqueueComboPass } from '@/lib/database/services/combo-pass-service';
import { recordDecline } from '@/lib/database/services/topic-decline-service';
import { createTopics, getByFact } from '@/lib/database/services/topic-service';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { COMBO_PASS_TOPIC_SYSTEM_PROMPT } from '@/lib/news-harness/prompts/persona-prompts';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { gatewayCalls, mockGateway, server, signInFixtureAccount, useStrictClock } from '@/test/helpers';

import {
  cleanupTopics,
  jobRows,
  metadataTopics,
  resetCloudMemory,
  resetTopicsMemory,
  setMode,
} from './support';

const realTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function turns(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await realTurn();
}

/** Steps fake time until `cond` holds; throws after `maxMs` of fake time. */
async function driveUntil(cond: () => boolean | Promise<boolean>, label: string, maxMs = 60_000, stepMs = 25) {
  for (let t = 0; t <= maxMs; t += stepMs) {
    await turns(2);
    if (await cond()) return;
    await jest.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error(`driveUntil: ${label} not met within ${maxMs}ms of fake time`);
}

/** Drives fake time until `promise` settles. */
async function driveDone<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await driveUntil(() => done, 'promise');
  return promise;
}

/** Stops the queue, jumping fake time so a loop parked in a sleep or a gateway call can leave. */
async function stopQueue(): Promise<void> {
  let stopped = false;
  const pending = inferenceQueue.stop().then(() => (stopped = true));
  for (let i = 0; i < 40 && !stopped; i++) {
    await jest.advanceTimersByTimeAsync(5_000);
    await turns(3);
  }
  await pending;
}

const feedSync = { finished: 0 };

beforeAll(() => {
  AppScheduler.register({
    name: 'feed-sync',
    displayName: 'feed-sync (stand-in)',
    frequency: 0,
    handler: async () => {
      feedSync.finished += 1;
    },
  });
});

beforeEach(async () => {
  resetTopicsMemory();
  resetCloudMemory();
  AppScheduler.dispose();
  feedSync.finished = 0;
  inferenceQueue.__resetTypeGatesForTests();
  await signInFixtureAccount();
  await setMode('cloud');
});

afterEach(async () => {
  await stopQueue();
  inferenceQueue.__resetTypeGatesForTests();
  cleanupTopics();
});

it('enqueue -> real queue -> topic_combo handler -> gateway -> combo rows + metadata + jobs done -> feed sync', async () => {
  const nurse = await addFact('Works as a paediatric nurse');
  const porto = await addFact('Lives in Porto, Portugal');
  // Isolated topics a chat saved earlier: the pass must leave them alone.
  const [nurseIsolated] = await createTopics([
    { factId: nurse.id, text: 'Paediatric nursing pay', weight: 0.75, provenance: 'llm' },
  ]);
  const [portoIsolated] = await createTopics([{ factId: porto.id, text: 'Porto weather', weight: 0.75, provenance: 'llm' }]);
  await recordDecline('Paediatric nurse shortages', nurse.id);

  const seen: string[] = [];
  server.use(
    ...mockGateway((call) => {
      const user = call.messages.find((m) => m.role === 'user')?.content ?? '';
      const statement = /^Fact: "([^"]+)"/m.exec(user)?.[1] ?? '';
      seen.push(statement);
      if (statement.includes('nurse')) return JSON.stringify(['Paediatric nurse pay in Porto', 'Paediatric nurse shortages']);
      if (statement.includes('Porto')) return JSON.stringify(['Porto rent for nurses']);
      return '[]';
    }),
  );
  const { jobIds } = await enqueueComboPass([nurse.id, porto.id], 'pass-e2e');
  useStrictClock(Date.now());

  await driveDone(inferenceQueue.start());
  await driveUntil(
    async () => (await jobRows('topic_combo')).length === 2 && (await jobRows('topic_combo')).every((j) => j.status === 'done'),
    'both jobs done',
  );
  await driveUntil(() => feedSync.finished === 1, 'the end-of-pass feed sync');

  // The gateway saw one combo call per fact, with the combo system prompt.
  expect(seen.sort()).toEqual(['Lives in Porto, Portugal', 'Works as a paediatric nurse']);
  for (const call of gatewayCalls('batch')) expect(call.messages[0].content).toBe(COMBO_PASS_TOPIC_SYSTEM_PROMPT);

  // The new combo rows, per fact, with the combo seed weight; a declined text was vetoed.
  const nurseRows = await getByFact(nurse.id);
  const portoRows = await getByFact(porto.id);
  const comboOf = (rows: typeof nurseRows) => rows.filter((r) => r.provenance === 'combo');
  expect(comboOf(nurseRows).map((r) => [r.text, r.status, r.weight])).toEqual([
    ['Paediatric nurse pay in Porto', 'active', DEFAULT_HARNESS_CONFIG.topicGen.topupTopicWeight],
  ]);
  expect(comboOf(portoRows).map((r) => [r.text, r.status, r.weight])).toEqual([
    ['Porto rent for nurses', 'active', DEFAULT_HARNESS_CONFIG.topicGen.topupTopicWeight],
  ]);
  // The isolated rows are untouched.
  expect(nurseRows.find((r) => r.id === nurseIsolated.id)).toMatchObject({ provenance: 'llm', weight: 0.75, status: 'active' });
  expect(portoRows.find((r) => r.id === portoIsolated.id)).toMatchObject({ provenance: 'llm', weight: 0.75, status: 'active' });

  // The second topic reader moved with the table.
  expect(await metadataTopics(nurse.id)).toEqual(['Paediatric nursing pay', 'Paediatric nurse pay in Porto']);
  expect(await metadataTopics(porto.id)).toEqual(['Porto weather', 'Porto rent for nurses']);

  // Every job is done, with its result, and the facts are all still there.
  const jobs = await jobRows('topic_combo');
  expect(jobs.map((j) => j.id).sort()).toEqual([...jobIds].sort());
  expect(jobs.map((j) => j.status)).toEqual(['done', 'done']);
  expect((await getFacts()).map((f) => f.id).sort()).toEqual([nurse.id, porto.id].sort());
});
