// The deferred combination pass (ux2 F3): one batched cloud call per claimed group of same-pass
// facts. The real handler runs over the real combo-pass-service rows and the gateway mock's batch
// route. The queue owns the head job (marked running before the handler runs, settled from its
// return or throw), so each test marks the head running the way the queue does.
//
// Replaces lib/inference/__tests__/topic-combo-handler.test.ts (all 10 `it`): claims siblings up to
// the gateway concurrency in ONE batched call; caps supporting facts at 25 newest first; dedupes
// against the device, the declined list and across the batch; on-device mode drops the pass; a
// deleted fact still settles its job; an offline/credential-less failure DEFERS the siblings and
// rethrows; any other failure gives them back with the error; a per-call error fails that sibling
// alone; a per-call error on the head applies the siblings then throws; ux2 F6 drops a topic that
// does not name its fact.
import { addFact, deleteFact, getFacts } from '@/lib/database/services/fact-service';
import { enqueueComboPass } from '@/lib/database/services/combo-pass-service';
import { createTopics, getByFact } from '@/lib/database/services/topic-service';
import { recordDecline } from '@/lib/database/services/topic-decline-service';
import { handleTopicComboJob } from '@/lib/inference/handlers/topic-combo-handler';
import { isDeferrableError } from '@/lib/inference/job-defer';
import * as cloudComplete from '@/lib/llm/cloudComplete';
import { COMBO_PASS_TOPIC_SYSTEM_PROMPT } from '@/lib/news-harness/prompts/persona-prompts';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { cleanup, driveDone, jobRow, leaveRunning, prepare, spendAttempts, tick, watchBodies, setMode } from './kit';

beforeEach(async () => {
  await prepare();
});
afterEach(cleanup);

/** Adds facts oldest first with a clock step between, so `getFacts()` (newest first) is the reverse. */
async function seed(statements: string[]): Promise<{ id: string; statement: string }[]> {
  const out: { id: string; statement: string }[] = [];
  for (const statement of statements) {
    out.push(await addFact(statement));
    await tick(5);
  }
  return out;
}

/** Queues a pass for `factIds`; returns jobId by fact id. Row order is not relied on. */
async function queuePass(factIds: string[], passId = 'pass-1') {
  const { jobIds } = await enqueueComboPass(factIds, passId);
  const byFact = new Map<string, string>();
  for (const id of jobIds) byFact.set(String((await jobRow(id))?.payload.factId), id);
  return { passId, jobIds, jobOf: (factId: string) => byFact.get(factId)! };
}

/** Runs the handler as the queue would: head marked running first. */
async function runHead(jobId: string, factId: string, passId = 'pass-1') {
  await leaveRunning(jobId);
  return driveDone(handleTopicComboJob({ factId, passId }, { jobId }));
}

/** Replies by the fact the combo prompt is about: `{ 'Works as a nurse': [...topics] }`. */
function answers(byFact: Record<string, string[]>) {
  server.use(
    ...mockGateway((call) => {
      const fact = /Fact: "([^"]+)"/.exec(call.messages[1].content)?.[1] ?? '';
      return JSON.stringify(byFact[fact] ?? []);
    }),
  );
}

const comboTexts = async (factId: string) =>
  (await getByFact(factId)).filter((t) => t.provenance === 'combo').map((t) => t.text);

const NURSE = 'Works as a nurse';
const PORTO = 'Lives in Porto, Portugal, EU';
const INDIA = 'From India';

describe('one batched call', () => {
  it('claims same-pass siblings and sends them in ONE batch with the combo prompt, newest supporting facts first, thinking off', async () => {
    const [india, porto, nurse] = await seed([INDIA, PORTO, NURSE]);
    answers({ [NURSE]: ['Portugal nurse pay dispute'], [PORTO]: ['Porto India flights'] });
    const bodies = watchBodies('/v1/chat/completions/batch');
    const { jobOf, jobIds } = await queuePass([nurse.id, porto.id]);

    const out = await runHead(jobOf(nurse.id), nurse.id);

    expect(out).toEqual({ applied: 2 });
    expect(bodies.count()).toBe(1);
    const [body] = await bodies.bodies();
    expect(body.requests).toHaveLength(2);
    expect(body.requests.every((r: { max_tokens: number; temperature: number; chat_template_kwargs: object }) =>
      r.max_tokens === 400 && r.temperature === 0.3 && JSON.stringify(r.chat_template_kwargs) === '{"enable_thinking":false}')).toBe(true);
    const calls = gatewayCalls('batch');
    expect(calls.every((c) => c.messages[0].content === COMBO_PASS_TOPIC_SYSTEM_PROMPT)).toBe(true);
    const nurseCall = calls.find((c) => c.messages[1].content.includes(`Fact: "${NURSE}"`))!;
    expect(nurseCall.messages[1].content).toBe(
      `Fact: "${NURSE}"\nOther user facts: ${PORTO}; ${INDIA}\nGenerate at most 4 topics`,
    );
    expect(nurseCall.messages[1].content).not.toMatch(/User location/);
    expect(await comboTexts(nurse.id)).toEqual(['Portugal nurse pay dispute']);
    expect(await comboTexts(porto.id)).toEqual(['Porto India flights']);
    expect(await comboTexts(india.id)).toEqual([]);
    for (const id of jobIds) expect((await jobRow(id))?.status).toBe('done');
  });

  it('claims at most 7 siblings with the head: 8 in the batch, the rest left pending', async () => {
    const facts = await seed(Array.from({ length: 10 }, (_, i) => `Fact number ${i}`));
    const bodies = watchBodies('/v1/chat/completions/batch');
    const { jobOf, jobIds } = await queuePass(facts.map((f) => f.id));

    await runHead(jobOf(facts[0].id), facts[0].id);

    const [body] = await bodies.bodies();
    expect(body.requests).toHaveLength(8);
    const rows = await Promise.all(jobIds.map((id) => jobRow(id)));
    // The head and the 7 claimed siblings are applied (each apply settles its own job); 2 were never claimed.
    expect(rows.filter((r) => r?.status === 'done')).toHaveLength(8);
    expect(rows.filter((r) => r?.status === 'pending' && r.attempts === 0)).toHaveLength(2);
  });

  it('caps the supporting facts at 25, newest first', async () => {
    const facts = await seed(['Fact zero', ...Array.from({ length: 30 }, (_, i) => `Support ${i}`)]);
    const { jobOf } = await queuePass([facts[0].id]);

    await runHead(jobOf(facts[0].id), facts[0].id);

    const prompt = gatewayCalls('batch')[0].messages[1].content;
    expect(prompt).toContain('Other user facts: Support 29; Support 28;');
    expect(prompt).toContain('Support 5');
    expect(prompt).not.toContain('Support 4;');
    expect(prompt.match(/Support \d+/g)).toHaveLength(25);
  });
});

describe('what is written', () => {
  it('dedupes against every topic on the device, the declined list, and across the batch', async () => {
    const [india, porto, nurse] = await seed([INDIA, PORTO, NURSE]);
    await createTopics([{ factId: india.id, text: 'Portugal nurse pay dispute', weight: 1, provenance: 'llm' }]);
    await recordDecline('India nurse voting rights', null);
    answers({
      [NURSE]: ['Portugal nurse pay dispute', 'India nurse voting rights', 'Porto nurse India recruitment'],
      [PORTO]: ['Porto nurse recruitment India', 'Porto India direct flights'],
    });
    const { jobOf } = await queuePass([nurse.id, porto.id]);

    await runHead(jobOf(nurse.id), nurse.id);

    expect(await comboTexts(nurse.id)).toEqual(['Porto nurse India recruitment']);
    expect(await comboTexts(porto.id)).toEqual(['Porto India direct flights']);
  });

  it('ux2 F6: drops a combination topic that does not name its own fact', async () => {
    const [, , nurse] = await seed([INDIA, PORTO, NURSE]);
    answers({ [NURSE]: ['Portugal nurse pay dispute', 'Porto India direct flights'] });
    const { jobOf } = await queuePass([nurse.id]);

    await runHead(jobOf(nurse.id), nurse.id);

    expect(await comboTexts(nurse.id)).toEqual(['Portugal nurse pay dispute']);
  });
});

describe('nothing to combine', () => {
  it('a fact deleted since the pass was queued is a no-op that still settles its job, with no gateway call', async () => {
    const [, , nurse] = await seed([INDIA, PORTO, NURSE]);
    const { jobOf } = await queuePass([nurse.id]);
    await deleteFact(nurse.id);

    const out = await runHead(jobOf(nurse.id), nurse.id);

    expect(out).toEqual({ applied: 0 });
    expect(gatewayCalls()).toHaveLength(0);
    expect((await jobRow(jobOf(nurse.id)))?.status).toBe('done');
  });

  it('a lone fact has nothing to combine with: settled, no gateway call', async () => {
    const [only] = await seed([NURSE]);
    const { jobOf } = await queuePass([only.id]);

    await runHead(jobOf(only.id), only.id);

    expect(gatewayCalls()).toHaveLength(0);
    expect((await jobRow(jobOf(only.id)))?.status).toBe('done');
  });

  it('on-device mode runs no pass and drops the pending combo jobs', async () => {
    const [, porto, nurse] = await seed([INDIA, PORTO, NURSE]);
    const { jobOf } = await queuePass([nurse.id, porto.id]);
    await setMode('on-device');

    const out = await runHead(jobOf(nurse.id), nurse.id);

    expect(out).toEqual({ applied: 0 });
    expect(gatewayCalls()).toHaveLength(0);
    // The sibling was pending and is dropped; the head is running, so it finishes by the queue.
    expect(await jobRow(jobOf(porto.id))).toBeNull();
    expect((await jobRow(jobOf(nurse.id)))?.status).toBe('running');
  });
});

describe('a failure that takes the whole batch', () => {
  it('a gateway 503 DEFERS every claimed sibling (attempt given back) and rethrows a deferrable error for the head', async () => {
    const facts = await seed(Array.from({ length: 10 }, (_, i) => `Fact number ${i}`));
    server.use(...mockGateway(() => ({ status: 503, body: { error: 'busy' } })));
    const { jobOf, jobIds } = await queuePass(facts.map((f) => f.id));
    const head = jobOf(facts[0].id);

    const failed = runHead(head, facts[0].id);
    const caught = failed.catch((e: unknown) => e);
    const err = (await caught) as Error;

    expect(err.message).toMatch(/E2EE batch failed: 503/);
    expect(isDeferrableError(err)).toBe(true);
    const siblings = (await Promise.all(jobIds.filter((id) => id !== head).map((id) => jobRow(id))))!;
    expect(siblings.every((r) => r?.status === 'pending' && r.attempts === 0)).toBe(true);
    expect(siblings.filter((r) => r?.errorMessage === 'deferred')).toHaveLength(7);
    // Never claimed: no error written, no attempt spent.
    expect(siblings.filter((r) => r?.errorMessage === null)).toHaveLength(2);
    expect(await comboTexts(facts[1].id)).toEqual([]);
  });

  it('any other failure gives the siblings back WITH the error, the claim\'s attempt kept', async () => {
    const [india, porto, nurse] = await seed([INDIA, PORTO, NURSE]);
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'nope' } })));
    const { jobOf } = await queuePass([nurse.id, porto.id, india.id]);

    const err = (await runHead(jobOf(nurse.id), nurse.id).catch((e: unknown) => e)) as Error;

    expect(err.message).toMatch(/E2EE batch failed: 400/);
    expect(isDeferrableError(err)).toBe(false);
    for (const f of [porto, india]) {
      expect(await jobRow(jobOf(f.id))).toMatchObject({
        status: 'pending',
        attempts: 1,
        errorMessage: expect.stringContaining('E2EE batch failed: 400'),
      });
    }
  });

  it('a sibling given back at its attempt limit is destroyed, like any failed job', async () => {
    const [, porto, nurse] = await seed([INDIA, PORTO, NURSE]);
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'nope' } })));
    const { jobOf } = await queuePass([nurse.id, porto.id]);
    // Two earlier tries already spent: the claim makes the third.
    await spendAttempts(jobOf(porto.id), 2);

    await runHead(jobOf(nurse.id), nurse.id).catch(() => undefined);

    expect(await jobRow(jobOf(porto.id))).toBeNull();
  });
});

describe('a failure on one call of the batch', () => {
  // The gateway mock fails one item of a batch with a perItem fault (its result row carries the error).
  const failFact = (fact: string, error: string, ok: Record<string, string>) =>
    server.use(
      ...mockGateway((call) => {
        const name = /Fact: "([^"]+)"/.exec(call.messages[1].content)?.[1] ?? '';
        return name === fact ? { status: 502, body: { error }, perItem: true } : (ok[name] ?? '[]');
      }),
    );

  it('fails that sibling alone; the head still applies', async () => {
    const [, porto, nurse] = await seed([INDIA, PORTO, NURSE]);
    const { jobOf } = await queuePass([nurse.id, porto.id]);
    failFact(PORTO, 'E2EE decrypt failed', { [NURSE]: '["Portugal nurse pay dispute"]' });

    await runHead(jobOf(nurse.id), nurse.id);

    expect(await comboTexts(nurse.id)).toEqual(['Portugal nurse pay dispute']);
    expect(await jobRow(jobOf(porto.id))).toMatchObject({ status: 'pending', attempts: 1, errorMessage: 'E2EE decrypt failed' });
  });

  it('on the head: the siblings are applied, then the head throws for the queue to settle', async () => {
    const [, porto, nurse] = await seed([INDIA, PORTO, NURSE]);
    const { jobOf } = await queuePass([nurse.id, porto.id]);
    failFact(NURSE, 'timeout', { [PORTO]: '["Porto India direct flights"]' });

    await expect(runHead(jobOf(nurse.id), nurse.id)).rejects.toThrow('timeout');

    expect(await comboTexts(porto.id)).toEqual(['Porto India direct flights']);
    expect((await jobRow(jobOf(porto.id)))?.status).toBe('done');
    expect((await jobRow(jobOf(nurse.id)))?.status).toBe('running');
  });

  // The mock answers every call, so a missing result is injected on the client's batch result (R23: a spy, restored in cleanup).
  const batchResult = (id: string, output: string) => ({ id, output });

  it('a call the batch returns nothing for fails that fact alone', async () => {
    const [, porto, nurse] = await seed([INDIA, PORTO, NURSE]);
    const { jobOf } = await queuePass([nurse.id, porto.id]);
    jest.spyOn(cloudComplete, 'cloudBatchComplete').mockResolvedValueOnce([
      batchResult(jobOf(nurse.id), '["Portugal nurse pay dispute"]'),
    ]);

    await runHead(jobOf(nurse.id), nurse.id);

    expect(await jobRow(jobOf(porto.id))).toMatchObject({ status: 'pending', errorMessage: 'no result for this fact' });
    expect((await getFacts()).length).toBe(3);
  });
});
