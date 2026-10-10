// CH3 (ledger, chat): a cloud turn still running at New chat ends the NEXT conversation's turn.
//
// New chat is resetChatSession(): it disposes the engine and empties the shared cloud store, but a
// turn already running cannot be cancelled by `dispose` (alive = false only refuses new sends).
// When that old turn settles, its `finally` writes the SHARED store: status 'idle' and
// turnActive false. The new conversation's turn, still streaming, then reads as finished: the
// restart hold drops under it, the composer re-enables, and its row is written with the partial
// text it had at that moment and never again.
import { resetChatSession } from '@/lib/chat-session/chat-session';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { gatewayCalls, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, until } from '@/test/integration/chat/_helpers';
import { articleAgent, attachCloud, busy, cloud, settle, streamHolds } from './kit';

jest.setTimeout(90_000);

const A_CHUNKS = ['a1 ', 'a2 ', 'a3 ', 'a4 ', 'a5 ', 'a6.'];
const B_CHUNKS = ['b1 ', 'b2 ', 'b3 ', 'b4 ', 'b5 ', 'b6 ', 'b7 ', 'b8 ', 'b9 ', 'b10.'];
const B_FULL = B_CHUNKS.join('');

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  useFloatingChatStore.setState({ isExpanded: true });
  server.use(
    ...mockGateway((call) => {
      const asked = JSON.stringify(call.messages);
      return asked.includes('turn B')
        ? { chunks: B_CHUNKS, chunkDelayMs: 700 }
        : { chunks: A_CHUNKS, chunkDelayMs: 700 };
    }),
  );
});

const answerText = () => cloud().messages.find((m) => m.role === 'assistant')?.content ?? '';

/** Turn A runs slowly in conversation A. While it runs, New chat, then a slow turn B in B.
 *  Resolves when A has settled (the shared store reads idle again); B is still streaming on the wire. */
async function interleave() {
  const a = await attachCloud(articleAgent());
  a.engine.send('turn A');
  await until(() => answerText().length > 0, 10_000, 'A is streaming');

  resetChatSession();
  const b = await attachCloud(articleAgent());
  b.engine.send('turn B');
  expect(busy()).toBe(true);
  await until(() => answerText().length > 0, 10_000, 'B is streaming');
  expect(gatewayCalls('chat')).toHaveLength(2);

  // Both replies stream at the same cadence and A started first, so once B has delivered its
  // seventh chunk A's six have run out and A's turn has settled; B still has three to go.
  // (The shared store cannot tell us A settled: with the fix, A no longer writes it.)
  await until(() => answerText().includes('b7 '), 20_000, 'A settles');
  const bText = answerText();
  const drain = async () => {
    await until(() => answerText() === B_FULL, 30_000, 'B finishes on the wire');
    await new Promise((r) => setTimeout(r, 200));
  };
  return { b, bText, drain };
}

const storedAnswer = async (conversationId: string) => {
  let rows = await fetchMessagesForConversation(conversationId);
  for (let i = 0; i < 300 && !rows.some((r) => r.role === 'assistant'); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
    rows = await fetchMessagesForConversation(conversationId);
  }
  return rows.find((r) => r.role === 'assistant');
};

test("a turn still running at New chat does not end the next conversation's turn", async () => {
  const { b, drain } = await interleave();
  try {
    // A has settled; B is mid-stream and must still read as a running turn.
    expect(cloud().agentTurnState?.turnActive).toBe(true);
    expect(cloud().status).toBe('streaming');
    expect(streamHolds()).toBe(1);
    await drain();
    expect((await storedAnswer(b.conversationId))?.content).toBe(B_FULL);
  } finally {
    await drain();
  }
});
