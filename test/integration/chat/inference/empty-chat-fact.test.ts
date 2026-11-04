// A fact accepted in chat whose topic run completes empty (owner plan U8). Chat open: it is removed
// first, then Mera is told. Chat closed: nothing happens until the reader taps. Driven through the
// real handler and fact service; the session's note queue is the seam to the engine.
import { commitFactChoices } from '@/lib/chat-tools/fact-commit';
import { addFact, getFacts, updateFact } from '@/lib/database/services/fact-service';
import { handleTopicGenJob } from '@/lib/inference/handlers/topic-gen-handler';
import { removeFactFromTap } from '@/lib/chat-session/fact-removal';
import { pendingRemovedFacts, resetChatSession } from '@/lib/chat-session/chat-session';
import { countEmptyFactRemovals, wasFactRemoved } from '@/lib/database/services/persona-change-log-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { recordDecline } from '@/lib/database/services/topic-decline-service';
import { sweepTopicLifecycle } from '@/lib/database/services/topic-planning-service';
import { TOPICS_ASK_REMOVAL, TOPICS_FROM_CHAT } from '@/lib/database/services/topic-generation-status-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { cleanup, driveDone, prepare } from './kit';

const FACT = '30 year old male';
const HOME = 'location: neighborhood/area, city, and country (preserve specifics)';
const fromChat = { [TOPICS_FROM_CHAT]: true } as unknown as Record<string, string[]>;

beforeEach(async () => {
  await prepare();
  resetChatSession();
  useFloatingChatStore.setState({ isExpanded: true });
  server.use(...mockGateway(() => '[]'));
});
afterEach(async () => {
  useFloatingChatStore.setState({ isExpanded: false });
  resetChatSession();
  await cleanup();
});

const chatFact = (statement = FACT, attribute?: string) =>
  addFact(statement, fromChat, attribute ? { attribute } : undefined, { topicsStatus: 'pending' });
const run = (fact: { id: string; statement: string }) =>
  driveDone(handleTopicGenJob({ factId: fact.id, factStatement: fact.statement, useCloud: true }));
const stored = async (id: string) => (await driveDone(getFacts())).find((f) => f.id === id);
const flag = (fact?: { metadata?: unknown }) => (fact?.metadata as Record<string, unknown> | undefined)?.[TOPICS_ASK_REMOVAL];

describe('chat open', () => {
  it('removes the fact first, then queues one note, with no inbox row counted against the sweep', async () => {
    const fact = await chatFact();
    const out = await run(fact);

    expect(out.outcome).toBe('empty');
    expect(await stored(fact.id)).toBeUndefined();
    expect(pendingRemovedFacts()).toEqual([FACT]);
    expect(await wasFactRemoved(FACT)).toBe(true);
    expect(await countEmptyFactRemovals(0)).toBe(0);
  });

  it('a real model failure never removes: Retry stays', async () => {
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'nope' } })));
    const fact = await chatFact();
    expect((await run(fact)).outcome).toBe('error');
    expect((await stored(fact.id))?.topicsStatus).toBe('error');
    expect(pendingRemovedFacts()).toEqual([]);
  });

  it('a fact not accepted in chat stays on the quiet path', async () => {
    const fact = await addFact(FACT, undefined, undefined, { topicsStatus: 'pending' });
    await run(fact);
    expect(await stored(fact.id)).toBeTruthy();
    expect(flag(await stored(fact.id))).toBeUndefined();
    expect(pendingRemovedFacts()).toEqual([]);
  });

  it('a replacement carries no stamp, so it stays; a plain accept carries one', async () => {
    const old = await addFact('An older fact');
    const { savedFacts } = await driveDone(
      commitFactChoices([
        { statement: 'Replaces an older fact', replaces: old.id },
        { statement: 'A plain new fact' },
      ]),
    );
    const [replacement, plain] = savedFacts;
    const meta = async (id: string) => ((await stored(id))?.metadata ?? {}) as Record<string, unknown>;
    expect((await meta(replacement.id))[TOPICS_FROM_CHAT]).toBeUndefined();
    expect((await meta(plain.id))[TOPICS_FROM_CHAT]).toBe(true);

    await run(replacement);
    expect(await stored(replacement.id)).toBeTruthy();
    expect(pendingRemovedFacts()).not.toContain('Replaces an older fact');
  });

  it.each([
    ['a home fact', async () => chatFact('Lives in Hoorn, North Holland, Netherlands, EU', HOME)],
    [
      'a fact with stopped news',
      async () => {
        const f = await chatFact();
        return updateFact(f.id, { metadata: { ...f.metadata, news_stopped: true } as never });
      },
    ],
    [
      'a fact with user places',
      async () => {
        const f = await chatFact();
        return updateFact(f.id, { metadata: { ...f.metadata, places_by: 'user' } as never });
      },
    ],
  ])('keeps %s, quietly', async (_name, make) => {
    const fact = await make();
    await run(fact);
    expect(await stored(fact.id)).toBeTruthy();
    expect(flag(await stored(fact.id))).toBeUndefined();
    expect(pendingRemovedFacts()).toEqual([]);
  });

  it('keeps a fact with a declined topic, and a matching combo topic', async () => {
    const declined = await chatFact('Likes old maps');
    await recordDecline('old map auctions', declined.id);
    await run(declined);
    expect(await stored(declined.id)).toBeTruthy();

    const combo = await chatFact('Keeps pet rabbits');
    await createTopics([{ text: 'pet rabbits in Delhi', weight: 0.5, status: 'active', provenance: 'combo' }]);
    await run(combo);
    expect(await stored(combo.id)).toBeTruthy();
  });

  it('a re-added fact keeps its flag and stays, so there is no loop', async () => {
    const first = await chatFact();
    await run(first);
    const again = await chatFact();
    await run(again);
    expect(await stored(again.id)).toBeTruthy();
    expect(pendingRemovedFacts()).toEqual([FACT]);
  });
});

describe('chat closed', () => {
  beforeEach(() => useFloatingChatStore.setState({ isExpanded: false }));

  it('removes nothing, marks the fact and spends no further model call, also in the sweep', async () => {
    const fact = await chatFact();
    await run(fact);
    const calls = gatewayCalls('chat').length;

    expect(flag(await stored(fact.id))).toBe(true);
    expect(pendingRemovedFacts()).toEqual([]);
    await driveDone(sweepTopicLifecycle({ now: Date.now() + 2 * 3_600_000 }));
    expect(gatewayCalls('chat')).toHaveLength(calls);
  });

  it('a tap removes it once under a double tap and queues the note', async () => {
    const fact = await chatFact();
    await run(fact);

    const [a, b] = await Promise.all([removeFactFromTap(fact.id, FACT), removeFactFromTap(fact.id, FACT)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await stored(fact.id)).toBeUndefined();
    expect(pendingRemovedFacts()).toEqual([FACT]);
  });

  it('a tap on a fact that gained a topic keeps it and clears the mark', async () => {
    const fact = await chatFact();
    await run(fact);
    await createTopics([{ text: 'Mens health', weight: 0.5, status: 'active', factId: fact.id, provenance: 'manual' } as never]);

    expect(await removeFactFromTap(fact.id, FACT)).toBe(false);
    expect(await stored(fact.id)).toBeTruthy();
    expect(flag(await stored(fact.id))).toBeUndefined();
    expect(pendingRemovedFacts()).toEqual([]);
  });
});
