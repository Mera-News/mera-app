// The SINGLE-SHOT FORCED PASS on the cloud engine (items 6, 7 and 10 of the hand-off): the
// coverage of the dropped lib/hooks/__tests__/useCloudPersonaChat.test.tsx forced-leg assertions.
//
// `tool_choice: 'required'` has no text form, so the CALLER re-asks once (REQUIRED_TOOL_REASK) and
// the pass is a step nobody watches, so it is sent buffered (`stream: false`). Today no shipped
// agent reaches this path (the persona agent has forced tools but runs the loop), so a TEST AGENT
// drives it: a plain IAgent passed through attachChatSession, with one harmless tool in both
// getToolDefinitions() and getForcedExtractionTools().
//
// Not repeated here, held elsewhere:
//  - the harness adapter's re-ask, once only, and not on an auto leg:
//    tools/agents/agent-port-deps.test.ts > "a forced leg (tool_choice required) ..."
//  - the persona loop's stream flags (only the route leg streams): cloud-engine/session.test.ts
//  - tool calls parsed out of the text, streamed and buffered: streaming/tool-text.test.ts
//
// Timing: the strict clock, so the limiter's 1 s spacing per call costs no wall time, and a
// "nothing more is sent" window is real virtual time.
import { REQUIRED_TOOL_REASK } from '@/lib/llm/text-tool-protocol';
import { advanceUntil, gatewayCalls, mockGateway, server, signInFixtureAccount, useStrictClock } from '@/test/helpers';
import { resetChatModules, toolCall } from '@/test/integration/chat/_helpers';
import { attachCloud, busy, cloud, forcedPassAgent, settle } from './kit';

jest.setTimeout(60_000);

const REQUIRED_LINE = 'This reply must contain at least one <tool_call>.';
const PROSE = 'Noted, thanks for telling me about Porto.';
const NOTE = 'SENTINEL_NOTE_4c1e90ab';

let executed: { name: string; input: unknown }[];

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  useStrictClock('2026-10-09T12:00:00Z');
  executed = [];
});
afterEach(async () => {
  jest.useRealTimers();
  await settle();
});

/** Sends one message and runs the turn, the forced tail included, to its end. */
async function runTurn(): Promise<void> {
  const { engine } = await attachCloud(forcedPassAgent(executed));
  engine.send('I live in Porto');
  expect(busy()).toBe(true);
  await advanceUntil(() => !busy());
  // Past the 10 s hedge delay and the limiter spacing: nothing more is sent after the turn ends.
  await jest.advanceTimersByTimeAsync(40_000);
}

describe('a prose first pass with no tool call', () => {
  it('runs the forced pass and ONE re-ask, buffered, with the required line, and nothing after', async () => {
    server.use(...mockGateway(() => PROSE));

    await runTurn();

    const calls = gatewayCalls('chat');
    expect(calls).toHaveLength(3);
    // Item 6: the first pass is the one the reader watches; the forced pass and its re-ask are not.
    expect(calls.map((c) => c.stream)).toEqual([true, false, false]);
    // The tool schema rides in every call's system prompt, as text; only the forced calls demand a call.
    for (const c of calls) expect(c.messages[0].content).toContain('<name>recordNote</name>');
    expect(calls.map((c) => c.messages[0].content.includes(REQUIRED_LINE))).toEqual([false, true, true]);
    // Item 7: the re-ask is the protocol line, appended last, as a user turn, and changes nothing else.
    const lastOf = (i: number) => calls[i].messages[calls[i].messages.length - 1];
    expect(lastOf(0)).toEqual({ role: 'user', content: 'I live in Porto' });
    // The forced pass reads the wire as the reader saw it: the user turn, then the reply they were shown.
    expect(calls[1].messages.slice(1)).toEqual([
      { role: 'user', content: 'I live in Porto' },
      { role: 'assistant', content: PROSE },
    ]);
    expect(lastOf(2)).toEqual({ role: 'user', content: REQUIRED_TOOL_REASK });
    expect(calls[2].messages.slice(0, -1)).toEqual(calls[1].messages);
    // No call came back, so nothing ran, and the forced text never reached the bubble.
    expect(executed).toEqual([]);
    const assistants = cloud().messages.filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.content)).toEqual([PROSE]);
    expect(assistants[0].toolCalls).toBeUndefined();
    expect(busy()).toBe(false);
    expect(cloud().status).toBe('idle');
    expect(cloud().error).toBeNull();
  });

  it('a call on the forced pass runs once, with no re-ask and no further pass', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? PROSE : toolCall('recordNote', { note: NOTE }))));

    await runTurn();

    const calls = gatewayCalls('chat');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.stream)).toEqual([true, false]);
    expect(calls[1].messages[0].content).toContain(REQUIRED_LINE);
    for (const c of calls) expect(c.messages.some((m) => m.content === REQUIRED_TOOL_REASK)).toBe(false);
    expect(executed).toEqual([{ name: 'recordNote', input: { note: NOTE } }]);
    // The call renders on the visible bubble, whose text is the first pass's.
    const bubble = cloud().messages.find((m) => m.role === 'assistant');
    expect(bubble?.content).toBe(PROSE);
    expect(bubble?.toolCalls).toEqual([
      expect.objectContaining({ name: 'recordNote', status: 'done', result: { recorded: true } }),
    ]);
    expect(busy()).toBe(false);
  });

  it('the re-ask answering with a call runs it once and stops', async () => {
    server.use(...mockGateway((c) => (c.index < 2 ? PROSE : toolCall('recordNote', { note: NOTE }))));

    await runTurn();

    const calls = gatewayCalls('chat');
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.stream)).toEqual([true, false, false]);
    expect(calls[2].messages[calls[2].messages.length - 1].content).toBe(REQUIRED_TOOL_REASK);
    expect(executed).toEqual([{ name: 'recordNote', input: { note: NOTE } }]);
    expect(busy()).toBe(false);
  });
});

describe('a first pass that already carries a call', () => {
  it('owes no forced pass: one streamed call, the tool runs once', async () => {
    server.use(...mockGateway(() => `${PROSE}\n${toolCall('recordNote', { note: NOTE })}`));

    await runTurn();

    const calls = gatewayCalls('chat');
    expect(calls).toHaveLength(1);
    expect(calls[0].stream).toBe(true);
    expect(calls[0].messages[0].content).not.toContain(REQUIRED_LINE);
    expect(executed).toEqual([{ name: 'recordNote', input: { note: NOTE } }]);
  });
});
