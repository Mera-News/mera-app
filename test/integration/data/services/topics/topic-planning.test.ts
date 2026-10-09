// "Generate more topics" for one fact: cloud mode runs the real topic_gen handler inline against the
// gateway mock, on-device mode enqueues an append job on the real `inference_jobs` table. The mode
// is read from the Mera Protocol store, as the widget does.
//
// Replaces topic-planning-service.test.ts (all 5 `it`): cloud runs inline as an append and reports
// how many it added; never sends an exclusion snapshot; cloud failure is "skipped" and never throws;
// on-device enqueues an append job; on-device skips when a job is already pending for the fact.
//
// Not carried over: "`inferenceQueue.notify` was called" asserts a mock (the queue is the real
// singleton and nothing observable differs between a woken and an unwoken idle loop; the chat area's
// queue tests own the wake). "`handleTopicGenJob` was called with these args" is replaced by what the
// handler did: the rows it appended and what the gateway was shown.
import { addFact, getTopicsStatus } from '@/lib/database/services/fact-service';
import { generateMoreTopicsForFact } from '@/lib/database/services/topic-planning-service';
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { recordDecline } from '@/lib/database/services/topic-decline-service';
import { getByFact } from '@/lib/database/services/topic-service';
import { advanceUntilDone, gatewayCalls, mockGateway, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';

import {
  cleanupTopics,
  failTableQuery,
  jobRows,
  metadataTopics,
  resetCloudMemory,
  resetTopicsMemory,
  seedFact,
  setMode,
} from './support';

const T0 = Date.parse('2026-10-09T10:00:00Z');
const STATEMENT = 'Works as a paediatric nurse';

beforeEach(async () => {
  resetTopicsMemory();
  resetCloudMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
});
afterEach(cleanupTopics);

const reply = (text: string) => server.use(...mockGateway(() => text));
const run = (...args: Parameters<typeof generateMoreTopicsForFact>) => advanceUntilDone(generateMoreTopicsForFact(...args));
const texts = async (factId: string) => (await getByFact(factId)).map((t) => t.text).sort();

describe('cloud mode: the append runs inline', () => {
  it('appends the new topics to the fact, keeps the ones it had, mirrors them into the metadata list, and reports how many it added', async () => {
    const { fact } = await seedFact(STATEMENT, ['Paediatric nurse housing']);
    reply('["Paediatric nursing pay", "Paediatric ward staffing"]');

    const outcome = await run(fact.id, STATEMENT, { count: 5 });

    expect(outcome).toEqual({ mode: 'inline', added: 2 });
    expect(await texts(fact.id)).toEqual(['Paediatric nurse housing', 'Paediatric nursing pay', 'Paediatric ward staffing']);
    expect(await metadataTopics(fact.id)).toEqual([
      'Paediatric nurse housing',
      'Paediatric nursing pay',
      'Paediatric ward staffing',
    ]);
    expect(await getTopicsStatus(fact.id)).toBe('done');
    expect(gatewayCalls('chat')).toHaveLength(1);
  });

  it('sends no exclusion snapshot: the job reads the fact\'s own topics and every declined topic when it RUNS', async () => {
    const { fact } = await seedFact(STATEMENT, ['Paediatric nurse housing']);
    await recordDecline('Paediatric ward gossip', null);
    reply('["Paediatric nursing pay"]');

    await run(fact.id, STATEMENT);

    const user = gatewayCalls('chat')[0].messages[1].content;
    expect(user).toContain('Paediatric nurse housing');
    expect(user).toContain('paediatric ward gossip');
  });

  it('a generate-more that finds nothing new adds nothing and leaves the fact as it was', async () => {
    const { fact } = await seedFact(STATEMENT, ['Paediatric nursing pay']);
    reply('["paediatric   NURSING pay"]');

    const outcome = await run(fact.id, STATEMENT);

    expect(outcome).toEqual({ mode: 'inline', added: 0 });
    expect(await texts(fact.id)).toEqual(['Paediatric nursing pay']);
    expect(await getTopicsStatus(fact.id)).toBe('done');
  });

  it('a gateway refusal adds nothing and does not throw', async () => {
    const { fact } = await seedFact(STATEMENT, ['Paediatric nurse housing']);
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'nope' } })));

    const outcome = await run(fact.id, STATEMENT);

    expect(outcome).toMatchObject({ added: 0 });
    expect(await texts(fact.id)).toEqual(['Paediatric nurse housing']);
  });

  it('is "skipped", never a throw, when the handler itself fails', async () => {
    const { fact } = await seedFact(STATEMENT, ['Paediatric nurse housing']);
    failTableQuery('facts');

    await expect(run(fact.id, STATEMENT)).resolves.toEqual({ mode: 'skipped', added: 0 });
  });

  it('enqueues nothing: cloud mode never touches the job table', async () => {
    const { fact } = await seedFact(STATEMENT, ['Paediatric nurse housing']);
    reply('["Paediatric nursing pay"]');

    await run(fact.id, STATEMENT);

    expect(await jobRows()).toEqual([]);
  });
});

describe('on-device mode: an append job on the persistent queue', () => {
  beforeEach(async () => {
    await setMode('on-device');
  });

  it('enqueues one pending topic_gen append job carrying the fact, the isolated-call options and no exclusion snapshot, and calls no model', async () => {
    const { fact } = await seedFact(STATEMENT, ['Paediatric nurse housing']);

    const outcome = await run(fact.id, STATEMENT, { skillId: 'topics/profession', count: 5 });

    expect(outcome).toEqual({ mode: 'queued', added: 0 });
    const rows = await jobRows('topic_gen');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', priority: 10, attempts: 0 });
    expect(rows[0].payload).toEqual({
      factId: fact.id,
      factStatement: STATEMENT,
      useCloud: false,
      mode: 'append',
      skillId: 'topics/profession',
      totalCount: 5,
    });
    expect(gatewayCalls()).toHaveLength(0);
    expect(await texts(fact.id)).toEqual(['Paediatric nurse housing']);
  });

  it('leaves out the options it was not given', async () => {
    const { fact } = await seedFact(STATEMENT, []);

    await run(fact.id, STATEMENT);

    expect((await jobRows('topic_gen'))[0].payload).toEqual({
      factId: fact.id,
      factStatement: STATEMENT,
      useCloud: false,
      mode: 'append',
    });
  });

  it('skips when a job for the fact is already pending or running, and still queues another fact', async () => {
    const { fact } = await seedFact(STATEMENT, ['Paediatric nurse housing']);
    const other = await addFact('Plays chess');

    expect(await run(fact.id, STATEMENT)).toEqual({ mode: 'queued', added: 0 });
    expect(await run(fact.id, STATEMENT)).toEqual({ mode: 'skipped', added: 0 });
    expect(await jobRows('topic_gen')).toHaveLength(1);

    expect(await run(other.id, 'Plays chess')).toEqual({ mode: 'queued', added: 0 });
    expect((await jobRows('topic_gen')).map((j) => j.payload.factId).sort()).toEqual([fact.id, other.id].sort());
  });

  it('a job already queued by another path counts too', async () => {
    const { fact } = await seedFact(STATEMENT, []);
    await enqueueJob('topic_gen', { factId: fact.id, factStatement: STATEMENT, useCloud: false });

    expect(await run(fact.id, STATEMENT)).toEqual({ mode: 'skipped', added: 0 });
    expect(await jobRows('topic_gen')).toHaveLength(1);
  });
});
