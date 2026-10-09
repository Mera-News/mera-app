// commitFactChoices: the WRITE half of propose-then-save, against the real fact and topic tables.
// Nothing runs until a card is tapped; these tests are the tap.
import { getFacts, getTopicsStatus } from '@/lib/database/services/fact-service';
import { runGeoDerivationSweep } from '@/lib/database/services/geo-derivation-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { createTopics, getByFact } from '@/lib/database/services/topic-service';
import { commitFactChoices } from '@/lib/chat-tools/fact-commit';
import { skillIds } from '@/lib/mera-harness';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import logger from '@/lib/logger';
import { gatewayCalls, signInFixtureAccount } from '@/test/helpers';
import { resetDatabase } from '@/test/helpers/db';
import { resetChatModules, seedFacts, setProcessingMode } from '@/test/integration/chat/_helpers';
import { pollUntil, queuedJobs, settle } from './kit';

jest.setTimeout(30_000);

const LOCATION = 'location: neighborhood/area, city, and country';
const GEO_RAN_KEY = 'geo_derivation_last_run_at';
const factVersion = () => useFloatingChatStore.getState().factMutationVersion;

beforeEach(async () => {
  resetChatModules();
  await setProcessingMode('cloud');
  await signInFixtureAccount();
});

// The geo sweep a commit fires is one module-wide in-flight run: let it end before the next test's
// database reset, or the next test joins a run that reads an emptied table and stamps nothing.
afterEach(async () => {
  await runGeoDerivationSweep();
});

describe('commitFactChoices', () => {
  it('writes the chosen reading, reports it back and stamps the fact pending before its job exists', async () => {
    const result = await commitFactChoices([{ statement: 'Lives in Amsterdam' }]);

    const [fact] = await getFacts();
    expect(fact.statement).toBe('Lives in Amsterdam');
    expect(result.savedFacts).toEqual([{ id: fact.id, statement: 'Lives in Amsterdam' }]);
    // addFact otherwise leaves the column NULL, which renders as done while generation is ahead.
    expect(await getTopicsStatus(fact.id)).toBe('pending');
  });

  it('passes the questionnaire attribute through: residence anchors every later topic run', async () => {
    await commitFactChoices([{ statement: 'Lives in Amsterdam', questionnaire: { attribute: LOCATION } }]);

    const [fact] = await getFacts();
    expect(fact.questionnaireAttribute).toBe(LOCATION);
  });

  it('an N-fact commit enqueues one isolated topic job per fact, in order', async () => {
    const { savedFacts } = await commitFactChoices([{ statement: 'A fact' }, { statement: 'B fact' }]);

    // The jobs are enqueued off the commit (fire-and-forget), so wait for them.
    const jobs = await pollUntil(() => queuedJobs('topic_gen'), (j) => j.length === 2);
    expect(jobs.map((j) => j.payload)).toEqual([
      { factId: savedFacts[0].id, factStatement: 'A fact', useCloud: true },
      { factId: savedFacts[1].id, factStatement: 'B fact', useCloud: true },
    ]);
  });

  it('stamps the topic skill on the job only when the choice carries one', async () => {
    const { savedFacts } = await commitFactChoices([
      { statement: 'Lives in Porto', skillId: 'topics/residence' },
      { statement: 'Plays chess' },
    ]);

    const jobs = await pollUntil(() => queuedJobs('topic_gen'), (j) => j.length === 2);
    expect(jobs[0].payload).toEqual({
      factId: savedFacts[0].id,
      factStatement: 'Lives in Porto',
      useCloud: true,
      skillId: 'topics/residence',
    });
    expect(jobs[1].payload).not.toHaveProperty('skillId');
  });

  it('the loop only stamps a registered guideline: conversation/correction has no topics leaf', () => {
    const ids = skillIds();
    expect(ids).toContain('topics/residence');
    expect(ids).not.toContain('topics/correction');
  });

  it('notifies the fact mutation once, after every write', async () => {
    const before = factVersion();

    await commitFactChoices([{ statement: 'A fact' }, { statement: 'B fact' }]);

    expect(factVersion()).toBe(before + 1);
  });

  it('kicks off the geo-derivation sweep after a real write', async () => {
    expect(await getSetting(GEO_RAN_KEY)).toBeNull();

    await commitFactChoices([{ statement: 'Lives in Amsterdam, Netherlands', questionnaire: { attribute: LOCATION } }]);

    // The sweep is fire-and-forget and stamps its cooldown key when it ran.
    expect(await pollUntil(() => getSetting(GEO_RAN_KEY), (v) => v !== null)).not.toBeNull();
  });

  it('a geo sweep that dies is a warning, never an error at the tap', async () => {
    const warn = jest.spyOn(logger, 'warn');

    const result = await commitFactChoices([{ statement: 'Lives in Amsterdam, Netherlands', questionnaire: { attribute: LOCATION } }]);
    // The tables go out from under the in-flight sweep.
    await resetDatabase();

    const warnings = await pollUntil(
      async () => warn.mock.calls.filter(([m]) => m === '[fact-commit] Geo derivation failed'),
      (calls) => calls.length > 0,
    );
    expect(warnings).toHaveLength(1);
    expect(result.savedFacts).toHaveLength(1);
  });

  it('an empty commit does nothing at all', async () => {
    const before = factVersion();

    const result = await commitFactChoices([]);
    await settle();

    expect(result).toEqual({ savedFacts: [], conflicts: [] });
    expect(await getFacts()).toEqual([]);
    expect(await queuedJobs()).toEqual([]);
    expect(await getSetting(GEO_RAN_KEY)).toBeNull();
    expect(factVersion()).toBe(before);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('a blank statement is not a choice', async () => {
    const result = await commitFactChoices([{ statement: '   ' }]);
    expect(result).toEqual({ savedFacts: [], conflicts: [] });
    expect(await getFacts()).toEqual([]);
  });

  // A double tap, or a card resurrected after a failed durable write.
  it('is idempotent: an existing statement is reported, not re-added, and gets no second topic run', async () => {
    const [existing] = await seedFacts(['Lives  in AMSTERDAM']);

    const result = await commitFactChoices([{ statement: 'lives in amsterdam' }]);
    await settle();

    expect(result.savedFacts).toEqual([{ id: existing.id, statement: 'lives in amsterdam' }]);
    expect(await getFacts()).toHaveLength(1);
    expect(await queuedJobs()).toEqual([]);
    expect(await getSetting(GEO_RAN_KEY)).toBeNull();
  });

  it('surfaces a conflict against a same-subject existing fact', async () => {
    const [old] = await seedFacts([{ statement: 'Lives in Berlin, Germany', attribute: 'location: residence' }]);

    const result = await commitFactChoices([
      { statement: 'Lives in Amsterdam, Netherlands', questionnaire: { attribute: 'location: residence' } },
    ]);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      newFactId: result.savedFacts[0].id,
      existingFactId: old.id,
      existingStatement: 'Lives in Berlin, Germany',
    });
  });

  // Conflict detection runs against the pre-batch bank, so two facts from one message never conflict.
  it('never raises a conflict against a sibling committed from the same turn', async () => {
    const [sibling] = await seedFacts([{ statement: 'Lives in Berlin, Germany', attribute: 'location: residence' }]);

    const result = await commitFactChoices(
      [{ statement: 'Lives in Amsterdam, Netherlands', questionnaire: { attribute: 'location: residence' } }],
      { excludeFactIds: [sibling.id] },
    );

    expect(result.conflicts).toEqual([]);
  });
});

describe('commitFactChoices with `replaces`', () => {
  it('replaces in ONE write: the old fact and its topics are gone, the new fact is pending, none is added twice', async () => {
    const [old] = await seedFacts(['Lives in Amsterdam']);
    await createTopics([
      { factId: old.id, text: 'Amsterdam news', weight: 0.5 },
      { factId: old.id, text: 'Amsterdam transport', weight: 0.5 },
    ]);
    expect(await getByFact(old.id)).toHaveLength(2);

    const result = await commitFactChoices([{ statement: 'Lives in Berlin', replaces: old.id }]);

    const facts = await getFacts();
    expect(facts.map((f) => f.statement)).toEqual(['Lives in Berlin']);
    expect(facts[0].id).not.toBe(old.id);
    expect(result.savedFacts).toEqual([{ id: facts[0].id, statement: 'Lives in Berlin' }]);
    expect(await getByFact(old.id)).toEqual([]);
    expect(await getTopicsStatus(facts[0].id)).toBe('pending');
    const jobs = await pollUntil(() => queuedJobs('topic_gen'), (j) => j.length === 1);
    expect(jobs.map((j) => j.payload.factId)).toEqual([facts[0].id]);
  });

  it('does NOT raise a conflict card against the row it just replaced', async () => {
    const [old] = await seedFacts([{ statement: 'Lives in Amsterdam', attribute: 'location: residence' }]);

    const result = await commitFactChoices([
      { statement: 'Lives in Berlin', replaces: old.id, questionnaire: { attribute: 'location: residence' } },
    ]);

    expect(result.conflicts).toEqual([]);
  });

  it('a replaces id that no longer exists degrades to a plain add, never a throw', async () => {
    const result = await commitFactChoices([{ statement: 'Lives in Berlin', replaces: 'gone-id' }]);

    expect((await getFacts()).map((f) => f.statement)).toEqual(['Lives in Berlin']);
    expect(result.savedFacts).toHaveLength(1);
  });

  it('keep both: a plain add leaves the old fact and its topics untouched', async () => {
    const [old] = await seedFacts(['Lives in Amsterdam']);
    await createTopics([{ factId: old.id, text: 'Amsterdam news', weight: 0.5 }]);

    await commitFactChoices([{ statement: 'Likes cycling' }]);

    expect((await getFacts()).map((f) => f.statement).sort()).toEqual(['Likes cycling', 'Lives in Amsterdam']);
    expect(await getByFact(old.id)).toHaveLength(1);
  });
});
