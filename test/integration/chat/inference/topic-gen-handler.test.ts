// The topic_gen job, ISOLATED per fact (ux2 F1): one fact at a time, never another fact, never a
// location line. Cloud runs the skill core through the gateway mock; on-device runs the local
// engine against the scripted llama.rn. Jobs are enqueued through the app's own entry points
// (`startTopicGeneration`, `generateMoreTopicsForFact`) and the handler is the real one.
//
// Replaces lib/inference/__tests__/topic-gen-handler.test.ts (all 15 `it`):
//   cloud: this fact only; guideline from the attribute; a named skill kept; exclusions (own +
//   declined, read at run time); never mints a declined or owned topic; append that finds nothing
//   settles; empty first run fails; empty run reaches Sentry fingerprinted without persona text; a
//   filter that eats everything; an empty append is not reported; a throw records a failure;
//   deleted fact is a no-op. On-device: no location and no other facts; first run with nothing
//   usable settles as an error. ux2 F6: only non-combo own topics listed.
import { addFact, getFacts, getTopicsStatus, deleteFact } from '@/lib/database/services/fact-service';
import { generateMoreTopicsForFact } from '@/lib/database/services/topic-planning-service';
import { createTopics, getByFact } from '@/lib/database/services/topic-service';
import { recordDecline } from '@/lib/database/services/topic-decline-service';
import { startTopicGeneration } from '@/lib/chat-tools/tool-handlers';
import { handleTopicGenJob } from '@/lib/inference/handlers/topic-gen-handler';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { SMALL_MODEL } from '@/lib/llm/constants';
import logger from '@/lib/logger';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { TOPIC_CALL_MAX_TOKENS, loadSkill } from '@/lib/mera-harness';
import { EMPTY_RETRY_NUDGE } from '@/lib/mera-harness/core/topic-call';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { installLlama, llamaCalls, resetFileSystem } from '@/test/integration/chat/_helpers';
import { cleanup, driveDone, jobRows, prepare, untilJob, watchBodies, setMode } from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

const HOME = 'location: neighborhood/area, city, and country (preserve specifics)';
const JOB = 'Works as a paediatric nurse';

beforeEach(async () => {
  resetFileSystem();
  await disposeModel();
  useMeraProtocolStore.getState().setModelState('downloaded');
  installLlama([]); // a clean call log: llamaCalls() counts this test's completions only
  await prepare();
});
afterEach(cleanup);

/** Adds a fact stamped pending, the way a commit does, and returns it. */
const pendingFact = (statement: string, attribute?: string) =>
  addFact(statement, undefined, attribute ? { attribute } : undefined, { topicsStatus: 'pending' });

const reply = (text: string) => server.use(...mockGateway(() => text));
const run = (payload: Parameters<typeof handleTopicGenJob>[0]) => driveDone(handleTopicGenJob(payload));
// Sorted: rows minted in one write share a created_at, so the read order is not a fact.
const texts = async (factId: string) => (await getByFact(factId)).map((t) => t.text).sort();

describe('cloud: the skill core, isolated', () => {
  it('makes ONE terminal call for THIS fact only: the small model, 600 tokens, no other fact, no location line', async () => {
    await pendingFact('Lives in Alkmaar, North Holland, Netherlands, EU', HOME);
    const nurse = await pendingFact(JOB, 'profession: job role and industry');
    await pendingFact('From India', 'background: country of origin');
    const bodies = watchBodies('/v1/chat/completions');
    reply('["Paediatric nursing pay", "Paediatric ward staffing"]');

    const out = await run({ factId: nurse.id, factStatement: JOB, useCloud: true });

    expect(out.topics).toEqual(['Paediatric nursing pay', 'Paediatric ward staffing']);
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(gatewayCalls('batch')).toHaveLength(0);
    const [body] = await bodies.bodies();
    expect(body).toMatchObject({ model: SMALL_MODEL, max_tokens: TOPIC_CALL_MAX_TOKENS, stream: false });
    expect(TOPIC_CALL_MAX_TOKENS).toBe(600);
    const [, user] = gatewayCalls('chat')[0].messages;
    expect(user.content).toContain('paediatric nurse');
    expect(user.content).not.toMatch(/Alkmaar|India|Other user facts|User location/);
  });

  it('settles done and mints the topics as active, weighted rows, and tells the fact UI', async () => {
    const fact = await pendingFact(JOB, 'profession: job role and industry');
    reply('["Paediatric nursing pay", "Paediatric ward staffing"]');
    const before = useFloatingChatStore.getState().factMutationVersion;

    await run({ factId: fact.id, factStatement: JOB, useCloud: true });

    expect(await getTopicsStatus(fact.id)).toBe('done');
    const rows = await getByFact(fact.id);
    expect(rows.map((t) => [t.text, t.status, t.provenance]).sort()).toEqual([
      ['Paediatric nursing pay', 'active', 'llm'],
      ['Paediatric ward staffing', 'active', 'llm'],
    ]);
    expect(rows.every((t) => t.weight > 0)).toBe(true);
    expect(useFloatingChatStore.getState().factMutationVersion).toBe(before + 1);
  });

  it('derives the guideline from the attribute when the payload names none', async () => {
    const fact = await pendingFact('Lives in Alkmaar, North Holland, Netherlands, EU', HOME);
    await run({ factId: fact.id, factStatement: fact.statement, useCloud: true });
    expect(gatewayCalls('chat')[0].messages[0].content).toMatch(/Residence ladders further/);
  });

  it('keeps a skill the chat turn named, over the attribute', async () => {
    const fact = await pendingFact('From India', HOME);
    await run({ factId: fact.id, factStatement: 'From India', useCloud: true, skillId: 'topics/origin' });
    expect(gatewayCalls('chat')[0].messages[0].content).toBe(loadSkill('topics/origin'));
  });

  it('a skill id this bundle does not know falls back to the generic guideline instead of failing', async () => {
    const fact = await pendingFact('Plays chess');
    await run({ factId: fact.id, factStatement: 'Plays chess', useCloud: true, skillId: 'topics/from-a-newer-build' });
    expect(gatewayCalls('chat')[0].messages[0].content).toBe(loadSkill('topics/generic'));
    expect(await getTopicsStatus(fact.id)).toBe('done');
  });

  it('lists THIS fact\'s own non-combo topics and every declined topic as already covered', async () => {
    const fact = await pendingFact('Lives in Alkmaar, North Holland, Netherlands, EU', HOME);
    await createTopics([
      { factId: fact.id, text: 'Alkmaar cheese market', weight: 1, provenance: 'llm' },
      // Combo rows name OTHER facts' subjects: shown to an isolated call they pull it off its fact.
      { factId: fact.id, text: 'Alkmaar nurse housing', weight: 1, provenance: 'combo' },
    ]);
    await recordDecline('Alkmaar weather', null);

    await run({ factId: fact.id, factStatement: fact.statement, useCloud: true });

    const user = gatewayCalls('chat')[0].messages[1].content;
    expect(user).toContain('Alkmaar cheese market');
    expect(user).toContain('alkmaar weather');
    expect(user).not.toContain('Alkmaar nurse housing');
  });

  it('reads the exclusion lists when the job RUNS, not when it was queued', async () => {
    const fact = await pendingFact('Plays chess');
    await driveDone(startTopicGeneration([{ id: fact.id, statement: 'Plays chess' }]));
    // After the enqueue, before the run: the person declines a topic and another run adds one.
    await recordDecline('Chess openings', fact.id);
    await createTopics([{ factId: fact.id, text: 'Chess endgames', weight: 1, provenance: 'llm' }]);
    const [job] = await jobRows('topic_gen');
    expect(job.payload).not.toHaveProperty('excludeTopics');

    await inferenceQueue.start();
    await untilJob(job.id, ['done']);

    const user = gatewayCalls('chat')[0].messages[1].content;
    expect(user).toContain('chess openings');
    expect(user).toContain('Chess endgames');
  });

  it('never mints a declined topic, or one the fact already owns (case and spacing folded)', async () => {
    const fact = await pendingFact('Lives in Alkmaar, North Holland, Netherlands, EU', HOME);
    await createTopics([{ factId: fact.id, text: 'Alkmaar news', weight: 1, provenance: 'llm' }]);
    await recordDecline('Alkmaar street safety', null);
    reply('["alkmaar   NEWS", "ALKMAAR Street  Safety", "North Holland dyke works"]');

    const out = await run({ factId: fact.id, factStatement: fact.statement, useCloud: true, mode: 'append' });

    expect(out.topics).toEqual(['North Holland dyke works']);
    expect(await texts(fact.id)).toEqual(['Alkmaar news', 'North Holland dyke works']);
  });

  // Intended: the declined-topic veto is an exact match on normalized_text, which folds case and
  // whitespace only. Near-duplicates are the similarity filter's job, not the veto's. Pinned so a
  // normaliser merge (P4) cannot start stripping punctuation here unnoticed.
  it('a punctuation variant of a declined topic is NOT vetoed (exact match on case and whitespace only)', async () => {
    const fact = await pendingFact(JOB, 'profession: job role and industry');
    await recordDecline('alkmaar street safety', null);
    reply('["Alkmaar, street safety!"]');

    const out = await run({ factId: fact.id, factStatement: JOB, useCloud: true });

    expect(out.topics).toEqual(['Alkmaar, street safety!']);
    expect(await texts(fact.id)).toEqual(['Alkmaar, street safety!']);
  });

  it('"Generate more" that finds nothing new settles done and reports nothing', async () => {
    const captured = jest.spyOn(logger, 'captureMessage');
    const fact = await pendingFact('Lives in Alkmaar, North Holland, Netherlands, EU', HOME);
    await createTopics([
      { factId: fact.id, text: 'Alkmaar news', weight: 1, provenance: 'llm' },
      { factId: fact.id, text: 'Alkmaar street safety', weight: 1, provenance: 'llm' },
    ]);
    reply('["Alkmaar news", "Alkmaar street safety"]');

    const out = await driveDone(generateMoreTopicsForFact(fact.id, fact.statement, { skillId: 'topics/residence' }));

    expect(out).toEqual({ mode: 'inline', added: 0 });
    expect(await getTopicsStatus(fact.id)).toBe('done');
    expect((await getFacts())[0].metadata?.topicGenError).toBeUndefined();
    expect(captured).not.toHaveBeenCalled();
  });

  it('an empty append run is not reported and settles', async () => {
    const captured = jest.spyOn(logger, 'captureMessage');
    const fact = await pendingFact(JOB, 'profession: job role and industry');
    reply('[]');

    await run({ factId: fact.id, factStatement: JOB, useCloud: true, mode: 'append' });

    expect(captured).not.toHaveBeenCalled();
    expect(await getTopicsStatus(fact.id)).toBe('done');
  });

  describe('a first run that yields nothing', () => {
    it('retries once with the nudge and then on the generic guideline, and only then records a failure the card can retry', async () => {
      const fact = await pendingFact(JOB, 'profession: job role and industry');
      reply('[]');

      const out = await run({ factId: fact.id, factStatement: JOB, useCloud: true });

      expect(out.topics).toEqual([]);
      const calls = gatewayCalls('chat');
      expect(calls).toHaveLength(3);
      expect(calls[0].messages[1].content).not.toContain(EMPTY_RETRY_NUDGE);
      expect(calls[1].messages[1].content).toContain(EMPTY_RETRY_NUDGE);
      expect(calls[1].messages[0].content).toBe(calls[0].messages[0].content);
      expect(calls[2].messages[0].content).toBe(loadSkill('topics/generic'));
      expect(await getTopicsStatus(fact.id)).toBe('error');
      expect((await getFacts())[0].metadata?.topicGenError).toEqual(['Topic generation returned no usable topics']);
      expect(await getByFact(fact.id)).toEqual([]);
    });

    it('is reported to Sentry fingerprinted, with the skill and counts and no persona text', async () => {
      const captured = jest.spyOn(logger, 'captureMessage');
      const fact = await pendingFact(JOB, 'profession: job role and industry');
      reply('[]');

      await run({ factId: fact.id, factStatement: JOB, useCloud: true });

      expect(captured).toHaveBeenCalledTimes(1);
      const [, opts] = captured.mock.calls[0] as [string, { fingerprint: string[]; extra: Record<string, unknown> }];
      expect(opts.fingerprint).toEqual(['topic-gen-failed', 'empty']);
      expect(opts.extra).toMatchObject({ coreReturned: 0, afterFresh: 0, skillId: 'topics/profession', veto: 0, filter: 0 });
      expect(JSON.stringify(captured.mock.calls)).not.toMatch(/nurse/i);
    });

    it('tells a filter that ate everything from an empty answer', async () => {
      const captured = jest.spyOn(logger, 'captureMessage');
      const fact = await pendingFact('Lives in Alkmaar, North Holland, Netherlands, EU', HOME);
      await recordDecline('Alkmaar news', null);
      await recordDecline('Alkmaar street safety', null);
      reply('["Alkmaar news", "Alkmaar street safety"]');

      await run({ factId: fact.id, factStatement: fact.statement, useCloud: true });

      expect(captured.mock.calls[0][1]).toMatchObject({ extra: { coreReturned: 0, afterFresh: 0, veto: 2 } });
      expect(JSON.stringify(captured.mock.calls)).not.toMatch(/alkmaar/i);
      expect(await getTopicsStatus(fact.id)).toBe('error');
      // The model was answering, so no retry ladder: one call.
      expect(gatewayCalls('chat')).toHaveLength(1);
    });
  });

  describe('a transport failure', () => {
    // 400 is not retried by the transport, so one chat call here is the core's own "a transport
    // error is not retried" rule rather than authFetch giving up.
    const refuse = () => server.use(...mockGateway(() => ({ status: 400, body: { error: 'nope' } })));

    it('records a failure instead of leaving pending, and reaches Sentry as a throw', async () => {
      const captured = jest.spyOn(logger, 'captureException');
      const fact = await pendingFact(JOB, 'profession: job role and industry');
      refuse();

      const out = await run({ factId: fact.id, factStatement: JOB, useCloud: true });

      expect(out.topics).toEqual([]);
      expect(gatewayCalls('chat')).toHaveLength(1);
      expect(await getTopicsStatus(fact.id)).toBe('error');
      expect((await getFacts())[0].metadata?.topicGenError?.[0]).toContain('E2EE completion failed: 400');
      expect(captured).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ fingerprint: ['topic-gen-failed', 'threw'], level: 'warning' }),
      );
    });

    it('an append run that throws still settles as an error but is not reported', async () => {
      const captured = jest.spyOn(logger, 'captureException');
      const fact = await pendingFact(JOB, 'profession: job role and industry');
      refuse();

      await run({ factId: fact.id, factStatement: JOB, useCloud: true, mode: 'append' });

      expect(await getTopicsStatus(fact.id)).toBe('error');
      expect(captured).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fingerprint: ['topic-gen-failed', 'threw'] }));
    });
  });

  it('a fact deleted before its job ran is a no-op: no model call, no status write, the job completes', async () => {
    const gone = await pendingFact('Plays chess');
    const other = await pendingFact('Plays go');
    await driveDone(startTopicGeneration([{ id: gone.id, statement: 'Plays chess' }]));
    await deleteFact(gone.id);
    const [job] = await jobRows('topic_gen');

    await inferenceQueue.start();
    const row = await untilJob(job.id, ['done']);

    expect(row).toMatchObject({ status: 'done', attempts: 1, result: { topics: [] } });
    expect(gatewayCalls()).toHaveLength(0);
    expect(await getTopicsStatus(other.id)).toBe('pending');
  });
});

describe('through the queue', () => {
  it('startTopicGeneration then a started queue: the job completes with its topics and the fact settles done', async () => {
    const fact = await pendingFact('Plays chess');
    await driveDone(startTopicGeneration([{ id: fact.id, statement: 'Plays chess' }]));
    const [job] = await jobRows('topic_gen');
    expect(job.payload).toEqual({ factId: fact.id, factStatement: 'Plays chess', useCloud: true });

    await inferenceQueue.start();
    const row = await untilJob(job.id, ['done']);

    expect(row?.result?.topics).toEqual(['Plays chess news', 'Plays chess results']);
    expect(await getTopicsStatus(fact.id)).toBe('done');
    expect(await texts(fact.id)).toEqual(['Plays chess news', 'Plays chess results']);
  });
});

describe('on-device: the local engine, isolated too', () => {
  beforeEach(async () => {
    await setMode('on-device');
  });

  it('passes no location and no other facts, lists own and declined topics, mints rows, settles done, makes zero gateway calls', async () => {
    const nurse = await pendingFact(JOB, 'profession: job role and industry');
    await pendingFact('Lives in Porto, Portugal, EU', HOME);
    await createTopics([{ factId: nurse.id, text: 'Paediatric wards', weight: 1, provenance: 'llm' }]);
    await recordDecline('Nurse pay', null);
    installLlama(['["Nurse staffing"]']);

    const out = await run({ factId: nurse.id, factStatement: JOB, useCloud: false });

    expect(out.topics).toEqual(['Nurse staffing']);
    const user = llamaCalls()[0].messages.at(-1)!.content;
    expect(user).toContain('paediatric nurse');
    expect(user).toContain('Paediatric wards');
    expect(user.toLowerCase()).toContain('nurse pay');
    expect(user).not.toMatch(/Porto|User location|Other user facts/);
    expect(await texts(nurse.id)).toEqual(['Nurse staffing', 'Paediatric wards']);
    expect((await getFacts()).find((f) => f.id === nurse.id)?.metadata?.topics).toEqual(['Nurse staffing']);
    expect(await getTopicsStatus(nurse.id)).toBe('done');
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('a job queued in cloud mode (useCloud true) runs its LOCAL branch once the mode is on-device, with zero gateway calls', async () => {
    const fact = await pendingFact('Plays chess');
    await setMode('cloud');
    await driveDone(startTopicGeneration([{ id: fact.id, statement: 'Plays chess' }]));
    const [job] = await jobRows('topic_gen');
    expect(job.payload.useCloud).toBe(true);
    await setMode('on-device');
    installLlama(['["Chess openings"]']);

    await inferenceQueue.start();
    await untilJob(job.id, ['done']);

    expect(llamaCalls()).toHaveLength(1);
    expect(gatewayCalls()).toHaveLength(0);
    expect(await texts(fact.id)).toEqual(['Chess openings']);
    expect(await getTopicsStatus(fact.id)).toBe('done');
  });

  it('a first run with nothing usable settles as an ERROR (Retry), never an empty done, and is reported with its own fingerprint', async () => {
    const captured = jest.spyOn(logger, 'captureMessage');
    const fact = await pendingFact(JOB, 'profession: job role and industry');
    installLlama(['[]']);

    const out = await run({ factId: fact.id, factStatement: JOB, useCloud: false });

    expect(out.topics).toEqual([]);
    expect(await getTopicsStatus(fact.id)).toBe('error');
    expect(await getByFact(fact.id)).toEqual([]);
    expect(captured.mock.calls[0][1]).toMatchObject({ fingerprint: ['topic-gen-failed', 'empty', 'on-device'] });
  });

  it('"Generate more" is queued as an append job and merges into the fact\'s topics', async () => {
    const fact = await pendingFact(JOB, 'profession: job role and industry');
    await createTopics([{ factId: fact.id, text: 'Paediatric wards', weight: 1, provenance: 'llm' }]);
    installLlama(['["Nurse staffing"]']);

    const out = await generateMoreTopicsForFact(fact.id, JOB);
    expect(out).toEqual({ mode: 'queued', added: 0 });
    const [job] = await jobRows('topic_gen');
    expect(job.payload).toMatchObject({ useCloud: false, mode: 'append' });

    await inferenceQueue.start();
    await untilJob(job.id, ['done']);

    expect(await texts(fact.id)).toEqual(['Nurse staffing', 'Paediatric wards']);
    expect(await getTopicsStatus(fact.id)).toBe('done');
  });

  it('an append run with nothing new settles instead of failing', async () => {
    const fact = await pendingFact(JOB, 'profession: job role and industry');
    await createTopics([{ factId: fact.id, text: 'Paediatric wards', weight: 1, provenance: 'llm' }]);
    installLlama(['["paediatric wards"]']);

    await run({ factId: fact.id, factStatement: JOB, useCloud: false, mode: 'append' });

    expect(await getTopicsStatus(fact.id)).toBe('done');
    expect(await texts(fact.id)).toEqual(['Paediatric wards']);
  });
});
