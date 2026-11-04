// The turn that tells the reader a fact was removed: one tool-free leg, no user bubble, the note
// never in the persisted thread or <recent>, waiting behind a busy turn, one reply for several.
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import {
  noteRemovedFact,
  flushRemovedFacts,
  retryChatTurn,
  canRetryChatTurn,
  pendingRemovedFacts,
  resetChatSession,
} from '@/lib/chat-session/chat-session';
import { __resetForTests as resetFallback } from '@/lib/llm/model-fallback';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { gatewayCalls, mockGateway, server, signInFixtureAccount, type GatewayCall } from '@/test/helpers';
import { resetChatModules, until } from '@/test/integration/chat/_helpers';
import { attachCloud, busy, cloud, settle, turnDone } from './kit';

jest.setTimeout(60_000);
afterEach(settle);

const GOOD = 'I removed "30 year old male" because I couldn\'t turn it into news topics. What would you like me to save instead?';

beforeEach(async () => {
  resetChatModules();
  resetFallback();
  await signInFixtureAccount();
  resetChatSession();
  useFloatingChatStore.setState({ isExpanded: true, proposal: null });
});

const lastSystem = (c: GatewayCall) => c.messages.find((m) => m.role === 'system')?.content ?? '';

describe('telling the reader', () => {
  it('sends one tool-free call, writes one assistant bubble and no user row', async () => {
    server.use(...mockGateway(() => GOOD));
    const { conversationId } = await attachCloud();
    noteRemovedFact('30 year old male');
    await flushRemovedFacts();
    await turnDone();

    const calls = gatewayCalls('chat');
    expect(calls).toHaveLength(1);
    expect(lastSystem(calls[0])).not.toContain('<name>');
    expect(cloud().messages.map((m) => [m.role, m.content])).toEqual([['assistant', GOOD]]);
    expect(cloud().wireMessages).toEqual([]);
    await settle();
    const rows = await fetchMessagesForConversation(conversationId);
    expect(rows.map((r) => r.role)).toEqual(['assistant']);
    expect(pendingRemovedFacts()).toEqual([]);
  });

  it('never puts the note in <recent>, and the next turn sees the question', async () => {
    server.use(...mockGateway(() => GOOD));
    const { engine } = await attachCloud();
    noteRemovedFact('30 year old male');
    await flushRemovedFacts();
    await turnDone();

    engine.send('I am a nurse');
    await turnDone();
    const next = gatewayCalls('chat')[1];
    const text = next.messages.map((m) => m.content).join('\n');
    expect(text).not.toContain('They said: \n');
    expect(text).not.toContain('Mera produced no news topics');
    expect(text).toContain('What would you like me to save instead?');
  });

  it('names several facts in one reply', async () => {
    const both = 'I removed "A fact here" and "B fact there" because I found no news topics. What should I save instead?';
    server.use(...mockGateway(() => both));
    await attachCloud();
    noteRemovedFact('A fact here');
    noteRemovedFact('B fact there');
    await flushRemovedFacts();
    await turnDone();
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(cloud().messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('waits behind a busy turn', async () => {
    server.use(...mockGateway(() => ({ chunks: ['Slow.'], headerDelayMs: 800 })));
    const { engine } = await attachCloud();
    engine.send('hello');
    await until(() => busy(), 2000, 'busy');
    noteRemovedFact('30 year old male');
    await flushRemovedFacts();
    expect(pendingRemovedFacts()).toEqual(['30 year old male']);
    server.use(...mockGateway(() => GOOD));
    await until(() => pendingRemovedFacts().length === 0, 20_000, 'note fired after the turn');
    await turnDone();
    expect(cloud().messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(cloud().messages.some((m) => m.content === GOOD)).toBe(true);
  });

  it('a reply that does not name the fact is replaced by the fixed line', async () => {
    server.use(...mockGateway(() => 'I removed something. What now?'));
    await attachCloud();
    noteRemovedFact('30 year old male');
    await flushRemovedFacts();
    await turnDone();
    const reply = cloud().messages.find((m) => m.role === 'assistant')?.content ?? '';
    expect(reply).toContain('"30 year old male"');
  });

  it('a failed reply offers Retry, which sends the note again', async () => {
    let fail = true;
    server.use(...mockGateway(() => (fail ? { status: 400, body: { error: 'nope' } } : GOOD)));
    await attachCloud();
    noteRemovedFact('30 year old male');
    await flushRemovedFacts();
    await turnDone();
    expect(canRetryChatTurn()).toBe(true);

    fail = false;
    retryChatTurn();
    await turnDone();
    expect(cloud().error).toBeNull();
    expect(cloud().messages.map((m) => m.content)).toEqual([GOOD]);
  });
});
