// Removing facts. `handleDeleteUserFacts` is the real deleter (id, key or text resolution, an
// ambiguous handle refused); the model never reaches it on its own call: the loop answers with a
// card, and `confirmPendingDelete` runs the delete when the person taps Remove, with no model turn.
import { createTopics, getByFact } from '@/lib/database/services/topic-service';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { handleDeleteUserFacts } from '@/lib/chat-tools/tool-handlers';
import { confirmPendingDelete } from '@/components/custom/floating-chat/fact-choice-actions';
import { deriveThreadItems } from '@/components/custom/floating-chat/deriveThreadItems';
import type { ChatThreadItem } from '@/components/custom/floating-chat/types';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { gatewayCalls, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { hasToolResult, isRouteLeg, reply, resetChatModules, seedFacts, toolCall } from '@/test/integration/chat/_helpers';
import { attachCloud, settle as settleEngine, turnDone } from '@/test/integration/chat/cloud-engine/kit';
import { factNamed, factStatements, pollUntil } from './kit';

jest.setTimeout(60_000);

const factVersion = () => useFloatingChatStore.getState().factMutationVersion;

beforeEach(() => {
  resetChatModules();
});

describe('handleDeleteUserFacts: arguments', () => {
  it.each([
    ['missing', {}],
    ['empty', { fact_ids: [] }],
    ['not an array', { fact_ids: 'not-an-array' }],
  ])('fact_ids %s is an error and deletes nothing', async (_label, args) => {
    await seedFacts(['Lives in Amsterdam']);

    const result = await handleDeleteUserFacts(args);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(await getFacts()).toHaveLength(1);
  });
});

describe('handleDeleteUserFacts: resolving a handle', () => {
  it('deletes by exact id', async () => {
    const [fact] = await seedFacts(['Lives in Amsterdam']);

    const result = await handleDeleteUserFacts({ fact_ids: [fact.id] });

    expect(result).toMatchObject({ success: true, deletedCount: 1 });
    expect(await getFacts()).toEqual([]);
  });

  it('deletes by questionnaire attribute key when exactly one fact holds it', async () => {
    await seedFacts([
      { statement: 'Works as an engineer', attribute: 'profession: job role and industry' },
      'Plays chess',
    ]);

    const result = await handleDeleteUserFacts({ fact_ids: ['profession: job role and industry'] });

    expect(result).toMatchObject({ success: true, deletedCount: 1 });
    expect(await factStatements()).toEqual(['Plays chess']);
  });

  it('deletes by matching statement text, case aside', async () => {
    await seedFacts(['Lives in Amsterdam']);

    const result = await handleDeleteUserFacts({ fact_ids: ['lives in amsterdam'] });

    expect(result).toMatchObject({ success: true, deletedCount: 1 });
    expect(await getFacts()).toEqual([]);
  });

  it('strips [brackets] from the handle before matching', async () => {
    await seedFacts(['Works in AI']);

    const result = await handleDeleteUserFacts({ fact_ids: ['[Works in AI]'] });

    expect(result).toMatchObject({ success: true, deletedCount: 1 });
  });

  it('a handle matching nothing deletes nothing and says so', async () => {
    await seedFacts(['Lives in Amsterdam']);

    const result = await handleDeleteUserFacts({ fact_ids: ['nonexistent-fact'] });

    expect(result).toMatchObject({ success: true, deletedCount: 0, deletedStatements: [] });
    expect(await getFacts()).toHaveLength(1);
  });

  it('two handles for the same fact delete it once', async () => {
    await seedFacts(['Works in AI']);

    const result = await handleDeleteUserFacts({ fact_ids: ['Works in AI', 'works in ai'] });

    expect(result).toMatchObject({ success: true, deletedCount: 1 });
  });

  it('deletes several facts in one call and reports exactly their statements', async () => {
    await seedFacts(['Fact one', 'Fact two']);
    const ids = [(await factNamed('Fact one')).id, (await factNamed('Fact two')).id];

    const result = await handleDeleteUserFacts({ fact_ids: ids });

    expect(result).toMatchObject({ success: true, deletedCount: 2 });
    expect([...(result.deletedStatements as string[])].sort()).toEqual(['Fact one', 'Fact two']);
  });

  it('notifies the fact mutation after deleting, and not when nothing matched', async () => {
    const [fact] = await seedFacts(['Lives in Amsterdam']);
    const before = factVersion();

    await handleDeleteUserFacts({ fact_ids: ['nonexistent'] });
    expect(factVersion()).toBe(before);

    await handleDeleteUserFacts({ fact_ids: [fact.id] });
    expect(factVersion()).toBe(before + 1);
  });

  it('deleting a fact takes its topics with it', async () => {
    const [fact] = await seedFacts(['Plays chess']);
    await createTopics([{ factId: fact.id, text: 'Chess news', weight: 0.5 }]);

    await handleDeleteUserFacts({ fact_ids: [fact.id] });

    expect(await getByFact(fact.id)).toEqual([]);
  });
});

describe('handleDeleteUserFacts: an ambiguous handle is REFUSED, never guessed', () => {
  // A persona holding a residence and an origin that embed the same place, under one key. The old
  // lookup was last-wins and removed the oldest match: the origin fact vanished with the residence.
  const seedTwoUnderOneKey = () =>
    seedFacts([
      { statement: 'Expat from India living in Nieuw-West, Amsterdam, Netherlands, Europe', attribute: 'location: residence' },
      { statement: 'Lives in Rotterdam', attribute: 'location: residence' },
    ]);

  it('REFUSES an attribute that names two facts, and deletes nothing', async () => {
    await seedTwoUnderOneKey();

    const out = await handleDeleteUserFacts({ fact_ids: ['location: residence'] });

    expect(out.error).toMatch(/ambiguous/);
    expect((out.ambiguous as { candidates: unknown[] }[])[0].candidates).toHaveLength(2);
    expect(out.deletedCount).toBe(0);
    expect(await getFacts()).toHaveLength(2);
  });

  it('an exact id still deletes exactly that fact, even when an attribute collides', async () => {
    await seedTwoUnderOneKey();
    const target = await factNamed('Lives in Rotterdam');

    const out = await handleDeleteUserFacts({ fact_ids: [target.id] });

    expect(out.deletedStatements).toEqual(['Lives in Rotterdam']);
    expect((await getFacts()).map((f) => f.statement)).toEqual([
      'Expat from India living in Nieuw-West, Amsterdam, Netherlands, Europe',
    ]);
  });

  it('an unambiguous attribute still works, so the refusal is not blanket', async () => {
    await seedFacts([{ statement: 'Lives in Rotterdam', attribute: 'location: residence' }]);

    const out = await handleDeleteUserFacts({ fact_ids: ['location: residence'] });

    expect(out).toMatchObject({ success: true, deletedCount: 1 });
  });
});

describe('a delete asked for in chat', () => {
  const stateOf = (items: ChatThreadItem[]) => items.filter((i): i is Extract<ChatThreadItem, { kind: 'fact-card' }> => i.kind === 'fact-card');

  // The persona loop on the cloud engine: route to conversation/correction, call deleteUserFacts,
  // then answer once the call's result is in.
  async function askToRemove(factIds: string[]) {
    server.use(
      ...mockGateway((call) => {
        if (isRouteLeg(call)) return reply('Let me look.', toolCall('load_skill', { id: 'conversation/correction' }));
        if (hasToolResult(call, 'deleteUserFacts')) return 'The card lists what would go. Tap Remove to confirm.';
        return reply('', toolCall('deleteUserFacts', { fact_ids: factIds }));
      }),
    );
    const { engine, conversationId } = await attachCloud();
    engine.send('Please remove my chess fact');
    await turnDone();
    await settleEngine();
    return conversationId;
  }

  const thread = () =>
    deriveThreadItems({
      live: useCloudChatStore.getState().messages,
      history: [],
      introMessage: null,
      isStreaming: false,
      earlierConversationLabel: 'Earlier',
      toolCallResults: useFloatingChatStore.getState().toolCallResults,
    });

  beforeEach(async () => {
    await signInFixtureAccount();
  });

  it('the model\'s call deletes nothing: it stages a card naming exactly the facts it resolved', async () => {
    await seedFacts(['Plays chess', 'Lives in Porto']);
    const chess = await factNamed('Plays chess');

    await askToRemove([chess.id]);

    expect(await getFacts()).toHaveLength(2);
    const [card] = stateOf(thread()).filter((c) => c.action === 'deletePending');
    expect(card.factIds).toEqual([chess.id]);
    expect(card.statements).toEqual(['Plays chess']);
    expect(card.pendingDelete?.factIds).toEqual([chess.id]);
  });

  it('a key naming two facts resolves to neither: the card is never wider than what was meant', async () => {
    await seedFacts([
      { statement: 'Plays chess', attribute: 'hobbies' },
      { statement: 'Plays go', attribute: 'hobbies' },
    ]);

    await askToRemove(['hobbies']);

    expect(await getFacts()).toHaveLength(2);
    expect(stateOf(thread()).filter((c) => c.action === 'deletePending')).toEqual([]);
  });

  it('Remove deletes exactly the pending ids with no model call, and records what went', async () => {
    await seedFacts(['Plays chess', 'Lives in Porto']);
    const chess = await factNamed('Plays chess');
    const conversationId = await askToRemove([chess.id]);
    const calls = gatewayCalls().length;
    const [card] = stateOf(thread()).filter((c) => c.action === 'deletePending');

    await confirmPendingDelete(card.pendingDelete!, 'remove');

    expect(await factStatements()).toEqual(['Lives in Porto']);
    expect(gatewayCalls()).toHaveLength(calls);
    const key = card.pendingDelete!.resultKey;
    expect(useFloatingChatStore.getState().toolCallResults[key]).toMatchObject({
      deleteOutcome: 'removed',
      deletedStatements: ['Plays chess'],
      deletedCount: 1,
    });
    expect(stateOf(thread()).map((c) => c.action)).toContain('deleted');
    // The outcome also lands on the persisted row.
    const rows = await pollUntil(
      () => fetchMessagesForConversation(conversationId),
      (r) => r.some((m) => m.toolCalls?.some((t) => t.result?.deleteOutcome === 'removed')),
    );
    expect(rows.some((m) => m.toolCalls?.some((t) => t.result?.deleteOutcome === 'removed'))).toBe(true);
  });

  it('Keep deletes nothing and the card reads kept', async () => {
    await seedFacts(['Plays chess', 'Lives in Porto']);
    const chess = await factNamed('Plays chess');
    await askToRemove([chess.id]);
    const [card] = stateOf(thread()).filter((c) => c.action === 'deletePending');

    await confirmPendingDelete(card.pendingDelete!, 'keep');

    expect(await getFacts()).toHaveLength(2);
    expect(useFloatingChatStore.getState().toolCallResults[card.pendingDelete!.resultKey]).toMatchObject({ deleteOutcome: 'kept' });
    expect(stateOf(thread()).map((c) => c.action)).toContain('deleteKept');
  });
});
