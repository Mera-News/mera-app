// The fact-choice cards, tapped the way the UI taps them: stage through the real handler, derive the
// thread, take the card the deriver gives (it carries resultKey and the staged baseResult), commit,
// resolve, derive again. The store starts EMPTY: it holds overrides only, never the staged blob.
import { getFacts } from '@/lib/database/services/fact-service';
import * as conversations from '@/lib/database/services/conversation-service';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import {
  factChoiceGroupId,
  readGroupResolutions,
  readPendingGroups,
  unresolvedGroups,
  type FactChoiceResolution,
} from '@/lib/chat-tools/fact-choice-resolution';
import { commitFactChoices } from '@/lib/chat-tools/fact-commit';
import { commitSaveAsWritten, resolveGroup, resolveGroups } from '@/components/custom/floating-chat/fact-choice-actions';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { bulkOf, cardsOf, kindsOf, MSG, pollUntil, queuedJobs, stageTurn, threadFor } from './kit';

const FARMER = 'Works as a farmer in Hoorn, Netherlands, Europe';
const PARENTS = 'Parents live in Malaga, Spain, Europe';
const HOME = 'Lives in Hoorn, Netherlands, Europe';
const THREE = [HOME, FARMER, PARENTS];

const overrides = () => useFloatingChatStore.getState().toolCallResults;
const dismissed = (options: string[]): FactChoiceResolution => ({ status: 'dismissed', options, questionnaireAttribute: null });
const savedFrom = (statement: string, id: string): FactChoiceResolution => ({
  status: 'saved',
  statements: [statement],
  savedFacts: [{ id, statement }],
  conflicts: [],
});

/** The persisted tool result of the staged message, read back through the conversation service. */
async function persistedResult(conversationId: string): Promise<Record<string, unknown>> {
  const [row] = await fetchMessagesForConversation(conversationId);
  return row.toolCalls![0].result!;
}

beforeEach(() => {
  resetChatModules();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('staging', () => {
  it('two facts stage as two cards plus a bulk row', async () => {
    const { staged } = await stageTurn([FARMER, PARENTS]);
    expect(kindsOf(threadFor(staged))).toEqual(['message', 'fact-choice-card', 'fact-choice-card', 'fact-choice-bulk-row']);
  });

  it('carries topic_skill_id from the tool arguments to both commit sites: the card and the bulk row', async () => {
    const { staged } = await stageTurn([
      { statement: 'Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU', topic_skill_id: 'topics/residence' },
      { statement: 'Interested in privacy safe AI', topic_skill_id: 'topics/interest' },
    ]);

    const items = threadFor(staged);
    expect(cardsOf(items).map((c) => c.topicSkillId)).toEqual(['topics/residence', 'topics/interest']);
    expect(bulkOf(items)!.groups.map((g) => g.topicSkillId)).toEqual(['topics/residence', 'topics/interest']);
  });

  it('degrades to a null guideline when the turn routed nowhere, keeping the shipped prompt', async () => {
    const { staged } = await stageTurn([FARMER]);
    expect(cardsOf(threadFor(staged))[0].topicSkillId).toBeNull();
  });
});

describe('the first tap on an EMPTY store', () => {
  it('accepting card 1 keeps card 0 and card 2, shows card 1 saved, and N cards stay N', async () => {
    const { staged } = await stageTurn(THREE);
    expect(overrides()).toEqual({});
    const card = cardsOf(threadFor(staged))[1];

    const { savedFacts } = await commitFactChoices([{ statement: card.options[0] }]);
    resolveGroup(card.resultKey, card.groupId, savedFrom(card.options[0], savedFacts[0].id), card.baseResult);

    const blob = overrides()[card.resultKey];
    expect(readPendingGroups(blob)).toHaveLength(3);
    expect(unresolvedGroups(blob).map((g) => g.index)).toEqual([0, 2]);
    // The deriver still emits the two pending cards, and a saved card + its topics card in line.
    expect(kindsOf(threadFor(staged))).toEqual([
      'message',
      'fact-choice-card',
      'fact-card',
      'chat-topics-card',
      'fact-choice-card',
      'fact-choice-bulk-row',
    ]);
    expect((await getFacts()).map((f) => f.statement)).toEqual([FARMER]);
  });

  it('skipping the first card leaves the spine whole, and the card is drawn dismissed in place', async () => {
    const { staged } = await stageTurn(THREE);
    const [first] = cardsOf(threadFor(staged));

    resolveGroup(first.resultKey, first.groupId, dismissed(first.options), first.baseResult);

    expect(readPendingGroups(overrides()[first.resultKey])).toHaveLength(3);
    const cards = cardsOf(threadFor(staged));
    expect(cards.map((c) => c.dismissed)).toEqual([true, false, false]);
    expect(cards[0].options).toEqual(first.options);
  });

  it('dismissing the only card leaves a dismissed card, not a gap', async () => {
    const { staged } = await stageTurn([FARMER]);
    const [card] = cardsOf(threadFor(staged));

    resolveGroup(card.resultKey, card.groupId, dismissed(card.options), card.baseResult);

    const items = threadFor(staged);
    expect(kindsOf(items)).toEqual(['message', 'fact-choice-card']);
    expect(cardsOf(items)[0].dismissed).toBe(true);
  });

  it('Add all resolves all three in one pass and writes the legacy fully-resolved shape', async () => {
    const { staged } = await stageTurn(THREE);
    const bulk = bulkOf(threadFor(staged))!;

    const { savedFacts } = await commitFactChoices(bulk.groups.map((g) => ({ statement: g.options[0] })));
    resolveGroups(
      bulk.resultKey,
      bulk.groups.map((g, i) => ({ groupId: g.groupId, resolution: savedFrom(g.options[0], savedFacts[i].id) })),
      bulk.baseResult,
    );

    const blob = overrides()[bulk.resultKey];
    expect(readPendingGroups(blob)).toHaveLength(3);
    expect(unresolvedGroups(blob)).toEqual([]);
    // An OTA rollback reads this as a finished turn: no pendingFacts, the aggregate counts.
    expect(blob.pendingFacts).toBeUndefined();
    expect(blob.staged).toBe(false);
    expect(blob.factsSaved).toBe(3);
    expect(blob.savedFacts).toHaveLength(3);
    const items = threadFor(staged);
    expect(items.filter((i) => i.kind === 'fact-card')).toHaveLength(3);
    expect(items.filter((i) => i.kind === 'chat-topics-card')).toHaveLength(3);
    expect(cardsOf(items)).toEqual([]);
  });

  it('Skip all dismisses every group and saves nothing', async () => {
    const { staged } = await stageTurn(THREE);
    const bulk = bulkOf(threadFor(staged))!;

    resolveGroups(
      bulk.resultKey,
      bulk.groups.map((g) => ({ groupId: g.groupId, resolution: dismissed(g.options) })),
      bulk.baseResult,
    );

    const blob = overrides()[bulk.resultKey];
    expect(unresolvedGroups(blob)).toEqual([]);
    expect(blob.factsSaved).toBe(0);
    expect(blob.savedFacts).toEqual([]);
    expect(await getFacts()).toEqual([]);
    expect(cardsOf(threadFor(staged)).map((c) => c.dismissed)).toEqual([true, true, true]);
  });
});

describe('several taps into the same blob', () => {
  it('a second resolve keeps the first (each reads the live store, not a render-time value)', async () => {
    const { staged, key } = await stageTurn(THREE);
    const [a, , c] = cardsOf(threadFor(staged));

    resolveGroup(key, a.groupId, savedFrom(a.options[0], 'f0'), staged);
    resolveGroup(key, c.groupId, savedFrom(c.options[0], 'f2'), staged);

    expect(Object.keys(readGroupResolutions(overrides()[key]) ?? {}).sort()).toEqual([a.groupId, c.groupId].sort());
    expect(unresolvedGroups(overrides()[key]).map((g) => g.index)).toEqual([1]);
  });

  it('Add all keeps a group an earlier single tap resolved', async () => {
    const { staged, key } = await stageTurn(THREE);
    const groups = cardsOf(threadFor(staged));
    resolveGroup(key, groups[1].groupId, savedFrom(groups[1].options[0], 'f1'), staged);

    // The bulk row only ever carries the groups still pending.
    const bulk = bulkOf(threadFor(staged))!;
    expect(bulk.groups).toHaveLength(2);
    resolveGroups(
      key,
      bulk.groups.map((g) => ({ groupId: g.groupId, resolution: savedFrom(g.options[0], `f-${g.groupIndex}`) })),
      staged,
    );

    expect(Object.keys(readGroupResolutions(overrides()[key]) ?? {})).toHaveLength(3);
    expect(overrides()[key].savedFacts).toHaveLength(3);
  });
});

describe('Undo', () => {
  it('removes the entry and returns the group to pending, in its own position', async () => {
    const { staged, key } = await stageTurn(THREE);
    const [first] = cardsOf(threadFor(staged));

    resolveGroup(key, first.groupId, dismissed(first.options), staged);
    expect(unresolvedGroups(overrides()[key]).map((g) => g.index)).toEqual([1, 2]);

    resolveGroup(key, first.groupId, undefined, staged);
    expect(unresolvedGroups(overrides()[key]).map((g) => g.index)).toEqual([0, 1, 2]);
    expect(cardsOf(threadFor(staged)).map((c) => [c.groupIndex, c.dismissed])).toEqual([
      [0, false],
      [1, false],
      [2, false],
    ]);
  });

  it('a skipped card is removed once a later user message exists; before that it keeps its Undo', async () => {
    const { staged, key } = await stageTurn(THREE);
    const [first] = cardsOf(threadFor(staged));
    resolveGroup(key, first.groupId, dismissed(first.options), staged);

    expect(cardsOf(threadFor(staged)).filter((c) => c.dismissed)).toHaveLength(1);
    expect(cardsOf(threadFor(staged, { followedByUser: true })).filter((c) => c.dismissed)).toHaveLength(0);
  });

  it('Undo after the fully-resolved rewrite still restores the card (the spine is parked)', async () => {
    const { staged, key } = await stageTurn([FARMER]);
    const [card] = cardsOf(threadFor(staged));
    resolveGroup(key, card.groupId, dismissed(card.options), staged);
    expect(overrides()[key].pendingFacts).toBeUndefined();

    resolveGroup(key, card.groupId, undefined, staged);

    expect(cardsOf(threadFor(staged)).map((c) => c.dismissed)).toEqual([false]);
  });
});

describe('the durable half', () => {
  it('writes the MERGED blob onto the persisted message row, not just this group', async () => {
    const { staged, conversationId, key } = await stageTurn(THREE);
    const [a, b] = cardsOf(threadFor(staged));

    resolveGroup(key, a.groupId, savedFrom(a.options[0], 'f0'), staged);
    resolveGroup(key, b.groupId, dismissed(b.options), staged);

    const persisted = await pollUntil(
      () => persistedResult(conversationId),
      (r) => Object.keys(readGroupResolutions(r) ?? {}).length === 2,
    );
    expect(persisted).toEqual(overrides()[key]);
    expect(readPendingGroups(persisted)).toHaveLength(3);
  });

  it('resolveGroups patches the row once for the whole batch, with one store write', async () => {
    const { staged, conversationId, key } = await stageTurn(THREE);
    const patch = jest.spyOn(conversations, 'patchMessageToolCallResult');
    let storeWrites = 0;
    const unsub = useFloatingChatStore.subscribe((s, prev) => {
      if (s.toolCallResults !== prev.toolCallResults) storeWrites += 1;
    });
    const groups = cardsOf(threadFor(staged));

    resolveGroups(
      key,
      groups.map((g) => ({ groupId: g.groupId, resolution: savedFrom(g.options[0], `f${g.groupIndex}`) })),
      staged,
    );
    unsub();

    expect(storeWrites).toBe(1);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0].slice(0, 2)).toEqual([MSG, 0]);
    const persisted = await pollUntil(
      () => persistedResult(conversationId),
      (r) => r.staged === false,
    );
    expect(persisted.factsSaved).toBe(3);
  });

  it('a tap before the message row exists lands in the store and never throws', async () => {
    const { staged } = await stageTurn([FARMER, PARENTS]);
    const [card] = cardsOf(threadFor(staged));
    // The assistant message persists only once the turn finalises: a fast tap can come first.
    const early = `not-yet-persisted::0`;

    expect(() => resolveGroup(early, card.groupId, dismissed(card.options), staged)).not.toThrow();

    expect(unresolvedGroups(overrides()[early]).map((g) => g.index)).toEqual([1]);
  });

  it('a durable write that rejects never throws into the tap', async () => {
    const { staged, key } = await stageTurn([FARMER, PARENTS]);
    const [card] = cardsOf(threadFor(staged));
    const patch = jest.spyOn(conversations, 'patchMessageToolCallResult').mockRejectedValueOnce(new Error('db locked'));

    expect(() => resolveGroup(key, card.groupId, dismissed(card.options), staged)).not.toThrow();
    await Promise.resolve();

    expect(patch).toHaveBeenCalledTimes(1);
    expect(unresolvedGroups(overrides()[key]).map((g) => g.index)).toEqual([1]);
  });
});

describe('Save as I wrote it', () => {
  it('commits the sentence with its key and topic guideline, and records it on the offering call', async () => {
    const SENTENCE = 'Lives in Zzqq';
    const { staged, conversationId, key } = await stageTurn([FARMER]);
    const baseResult = { ...staged, saveAsWritten: { statement: SENTENCE } };

    await commitSaveAsWritten({
      resultKey: key,
      baseResult,
      entry: {
        statement: SENTENCE,
        questionnaire_attribute: 'location: neighborhood/area, city, and country (preserve specifics)',
        topic_skill_id: 'topics/residence',
      },
    });

    const [fact] = await getFacts();
    expect(fact).toMatchObject({
      statement: SENTENCE,
      questionnaireAttribute: 'location: neighborhood/area, city, and country (preserve specifics)',
    });
    expect((await queuedJobs('topic_gen'))[0].payload).toMatchObject({ factId: fact.id, skillId: 'topics/residence' });
    expect(overrides()[key]).toEqual({ ...baseResult, saveAsWrittenSaved: [{ id: fact.id, statement: SENTENCE }] });
    const persisted = await pollUntil(
      () => persistedResult(conversationId),
      (r) => r.saveAsWrittenSaved !== undefined,
    );
    expect(persisted.saveAsWrittenSaved).toEqual([{ id: fact.id, statement: SENTENCE }]);
  });

  it('an offer with no attribute and no skill commits a bare statement', async () => {
    await commitSaveAsWritten({ resultKey: 'm::0', baseResult: {}, entry: { statement: 'Plays chess' } });

    const [fact] = await getFacts();
    expect(fact.questionnaireAttribute).toBeUndefined();
    expect((await queuedJobs('topic_gen'))[0].payload).not.toHaveProperty('skillId');
  });
});

it('group ids are stable across a re-derive (a resolution written for a card is found for it)', async () => {
  const { staged } = await stageTurn([HOME]);
  expect(cardsOf(threadFor(staged))[0].groupId).toBe(factChoiceGroupId(0, [HOME]));
});
