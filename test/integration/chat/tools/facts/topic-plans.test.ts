// Save and Discard on a "Topics I'll track" card, and what each one tells Mera. The asymmetry is the
// feature: SAVE records a note and requests no turn (the user asked for silence); DISCARD records a
// note AND requests a turn (a rejection is owed a reply). Real facts, topics and the audited executor.
import * as factService from '@/lib/database/services/fact-service';
import { getFacts } from '@/lib/database/services/fact-service';
import * as topicService from '@/lib/database/services/topic-service';
import { createTopics, getByFact } from '@/lib/database/services/topic-service';
import { discardTopicPlan, saveTopicPlan } from '@/components/custom/floating-chat/topic-plan-actions';
import { hasReviewMarker, resolveTopicPlan } from '@/components/custom/floating-chat/topic-plan-resolution';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import '@/test/helpers';
import { resetChatModules, seedFacts } from '@/test/integration/chat/_helpers';

const STATEMENT = 'I follow Formula 1';
const store = () => useFloatingChatStore.getState();

/** A fact with one active topic and one the per-row X retired. */
async function seedPlan() {
  const [fact] = await seedFacts([STATEMENT]);
  await createTopics([
    { factId: fact.id, text: 'F1 race results', weight: 0.5, status: 'active' },
    { factId: fact.id, text: 'F1 merchandise', weight: 0.5, status: 'retired' },
  ]);
  return fact;
}

beforeEach(() => {
  resetChatModules();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('saveTopicPlan', () => {
  it('records what was kept and what the per-row X removed', async () => {
    const fact = await seedPlan();

    await saveTopicPlan(fact.id, STATEMENT);

    expect(store().topicPlanNotes).toEqual([
      expect.objectContaining({ kind: 'saved', statement: STATEMENT, kept: ['F1 race results'], removed: ['F1 merchandise'] }),
    ]);
  });

  // A save is recorded for LATER turns to read and starts nothing.
  it('requests NO model turn', async () => {
    const fact = await seedPlan();

    await saveTopicPlan(fact.id, STATEMENT);

    expect(store().topicPlanTurnRequest).toBeNull();
  });

  it('marks the plan reviewed on the fact (durable), settles the card and bumps the fact version', async () => {
    const fact = await seedPlan();
    const before = store().factMutationVersion;

    await saveTopicPlan(fact.id, STATEMENT);

    const [after] = await getFacts();
    expect(hasReviewMarker(after)).toBe(true);
    expect(store().settledTopicPlans[fact.id]).toBe(true);
    expect(store().factMutationVersion).toBe(before + 1);
    // Save changes no topic: every row is still there.
    expect(await getByFact(fact.id)).toHaveLength(2);
  });

  it('after a relaunch (the in-memory store is empty) the review marker still resolves the card as saved', async () => {
    const fact = await seedPlan();
    await saveTopicPlan(fact.id, STATEMENT);
    store().reset();

    const [after] = await getFacts();
    expect(resolveTopicPlan({ factId: fact.id, settled: store().settledTopicPlans, discarded: store().discardedTopicPlans, factsLoaded: true, fact: after })).toBe('saved');
  });

  it('looks the statement up when the caller has none ("Save all")', async () => {
    const fact = await seedPlan();

    await saveTopicPlan(fact.id);

    expect(store().topicPlanNotes[0]).toMatchObject({ kind: 'saved', statement: STATEMENT });
  });

  it('records no note, and does not settle the card, when the durable write fails', async () => {
    const fact = await seedPlan();
    jest.spyOn(factService, 'markTopicsReviewed').mockRejectedValueOnce(new Error('db'));

    await expect(saveTopicPlan(fact.id, 'x')).rejects.toThrow();

    // Telling the model something was kept when it was not is worse than silence.
    expect(store().topicPlanNotes).toEqual([]);
    expect(store().settledTopicPlans[fact.id]).toBeUndefined();
  });

  it('survives a failed topic snapshot without losing the save', async () => {
    const fact = await seedPlan();
    jest.spyOn(topicService, 'getByFact').mockRejectedValueOnce(new Error('db'));

    await saveTopicPlan(fact.id, STATEMENT);

    expect(hasReviewMarker((await getFacts())[0])).toBe(true);
    expect(store().topicPlanNotes[0]).toMatchObject({ kind: 'saved', kept: [], removed: [] });
  });
});

describe('discardTopicPlan', () => {
  it('records the rejection AND asks Mera to reply (the nonce moves)', async () => {
    const fact = await seedPlan();
    expect(store().topicPlanTurnRequest).toBeNull();

    await discardTopicPlan(fact.id, STATEMENT);

    expect(store().topicPlanNotes).toEqual([expect.objectContaining({ kind: 'discarded', statement: STATEMENT })]);
    expect(store().topicPlanTurnRequest).not.toBeNull();
  });

  // discard_fact destroys the row, so a lookup after the delete finds nothing and the note names no fact.
  it('resolves the statement BEFORE deleting the fact', async () => {
    const fact = await seedPlan();

    await discardTopicPlan(fact.id);

    expect(await getFacts()).toEqual([]);
    expect(store().topicPlanNotes[0]).toMatchObject({ kind: 'discarded', statement: STATEMENT });
  });

  it('deletes the fact and its topics through the audited executor, and marks the card discarded', async () => {
    const fact = await seedPlan();
    const before = store().factMutationVersion;

    const outcome = await discardTopicPlan(fact.id, STATEMENT);

    expect(outcome.applied).toBe(true);
    expect(outcome.changeLogId).toEqual(expect.any(String));
    expect(await getFacts()).toEqual([]);
    expect(await getByFact(fact.id)).toEqual([]);
    expect(store().discardedTopicPlans[fact.id]).toBe(true);
    expect(store().factMutationVersion).toBe(before + 1);
  });

  it('settles the card even when the fact was already gone', async () => {
    const outcome = await discardTopicPlan('already-gone', 'x');

    expect(outcome.applied).toBe(false);
    expect(store().discardedTopicPlans['already-gone']).toBe(true);
    // A fact that no longer exists resolves as discarded by construction, so it never blocks the input.
    expect(resolveTopicPlan({ factId: 'already-gone', settled: {}, discarded: {}, factsLoaded: true, fact: undefined })).toBe('discarded');
  });
});
