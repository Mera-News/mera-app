// THE STOP BUTTON AND A TOOL CALL (items 8 and 9 of the hand-off): a cancelled stream never executes
// a half-parsed call, and a Stop between the persona loop's forced leg and its re-ask runs neither
// the re-ask nor the calls.
//
// Not repeated here, held elsewhere:
//  - Stop mid-text with the call chunk NOT yet arrived (the call bytes are never in the parser):
//    cloud-engine/stop.test.ts > "mid-stream", and streaming/stop.test.ts > "stop mid-stream".
//    The tests below put the opening half of a <tool_call> in the SAME chunk as the visible text,
//    so the abort lands on a call the parser is holding.
//  - the adapter's Stop with no call in play: tools/agents/agent-port-deps.test.ts > "makeAgentDeps honours Stop".
//
// Timing: the strict clock, driven in small steps with a real event-loop turn per step. After a
// Stop, 40 s of virtual time pass and the call count is read again: no hedge, retry or later leg.
import { stopChatTurn } from '@/lib/chat-session/chat-session';
import { makeAgentDeps } from '@/lib/chat-tools/agent-device-port';
import { getFacts } from '@/lib/database/services/fact-service';
import { PersonaUpdateAgent } from '@/lib/llm/agents/PersonaUpdateAgent';
import * as cloudCompleteModule from '@/lib/llm/cloudComplete';
import { CallerAbortError, cloudChatStream, type CloudChatStreamRequest, type SseEvent } from '@/lib/llm/cloudComplete';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { REQUIRED_TOOL_REASK } from '@/lib/llm/text-tool-protocol';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import {
  advanceUntil,
  advanceUntilDone,
  defaultResponder,
  FIXTURE_ACCOUNT,
  gatewayCalls,
  mockGateway,
  server,
  signInFixtureAccount,
  useStrictClock,
  type GatewayCall,
} from '@/test/helpers';
import { isRouteLeg, reply, resetChatModules, toolCall } from '@/test/integration/chat/_helpers';
import { attachCloud, busy, cloud, noteAgent, settle, textOf } from './kit';

jest.setTimeout(60_000);

const SAVING = 'Saving. ';
// Visible text, then the OPENING HALF of a call, in one chunk. A second chunk (never sent: the stream
// stalls first) would have closed it.
const HALF_CALL = (name: string, param: string) => `${SAVING}<tool_call>\n<function=${name}>\n<parameter=${param}>\nhal`;
const REST = 'f done\n</parameter>\n</function>\n</tool_call>';
const stalledOn = (head: string) => ({ chunks: [head, REST], stallAfter: 1 });

let executed: { name: string; input: unknown }[];
let spy: jest.SpyInstance | undefined;

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  useStrictClock('2026-10-09T12:00:00Z');
  executed = [];
});
afterEach(async () => {
  spy?.mockRestore();
  spy = undefined;
  jest.useRealTimers();
  await settle();
});

const idleAfterStop = async () => {
  await advanceUntil(() => !busy(), 30_000);
  // Past the 10 s hedge delay and the limiter spacing: nothing more may be sent.
  await jest.advanceTimersByTimeAsync(40_000);
};
const chatCalls = (): GatewayCall[] => gatewayCalls('chat');
const lastContent = (c: GatewayCall) => c.messages[c.messages.length - 1].content;

describe('item 8: Stop with a call half-parsed', () => {
  it('stream level: CallerAbortError, no tool-call-delta, and no tag text in any text-delta', async () => {
    server.use(...mockGateway(() => stalledOn(HALF_CALL('recordNote', 'note'))));
    const stop = new AbortController();
    const events: SseEvent[] = [];
    const outcome = (async () => {
      for await (const e of cloudChatStream({
        model: SMALL_MODEL,
        messages: [{ role: 'user', content: 'Save my note' }],
        tools: [noteAgent([]).getToolDefinitions!()[0]],
        signal: stop.signal,
      })) {
        events.push(e);
        if (e.type === 'text-delta') stop.abort();
      }
    })().then(() => null, (err: unknown) => err);

    await advanceUntil(() => events.length > 0);
    await jest.advanceTimersByTimeAsync(30_000);

    expect(await outcome).toBeInstanceOf(CallerAbortError);
    expect(events.filter((e) => e.type === 'tool-call-delta')).toEqual([]);
    expect(events.filter((e) => e.type === 'finish')).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['text-delta']);
    expect(textOf(events)).toBe(SAVING);
    for (const e of events) if (e.type === 'text-delta') expect(e.delta).not.toMatch(/[<>]|tool_call|function/);
    expect(chatCalls()).toHaveLength(1);
    expect(chatCalls()[0].aborted).toBe(true);
  });

  it('single-shot engine: the partial text stays as stopped, the tool is never run, no further call is sent', async () => {
    server.use(...mockGateway(() => stalledOn(HALF_CALL('recordNote', 'note'))));
    const { engine } = await attachCloud(noteAgent(executed));
    engine.send('Save my note');
    await advanceUntil(() => (cloud().messages.find((m) => m.role === 'assistant')?.content ?? '').includes('Saving'));

    stopChatTurn();
    await idleAfterStop();

    const bubble = cloud().messages.find((m) => m.role === 'assistant');
    expect(bubble).toMatchObject({ stopped: true });
    expect(bubble?.content.trim()).toBe('Saving.');
    expect(bubble?.toolCalls).toBeUndefined();
    expect(executed).toEqual([]);
    expect(cloud().error).toBeNull();
    // One call, cut by the Stop; nothing further is sent.
    expect(chatCalls()).toHaveLength(1);
    expect(chatCalls()[0].aborted).toBe(true);
    expect(chatCalls().some((c) => c.messages.some((m) => m.content === REQUIRED_TOOL_REASK))).toBe(false);
    expect(busy()).toBe(false);
  });

  it('persona loop: the half call on the route leg is never run, so no skill loads and no second leg is sent', async () => {
    server.use(...mockGateway(stallFirst(HALF_CALL('load_skill', 'id'))));
    const { engine } = await attachCloud(personaAgentFor());
    engine.send('I follow Formula 1 racing');
    await advanceUntil(() => (cloud().messages.find((m) => m.id.endsWith('-ack'))?.content ?? '').includes('Saving'));

    stopChatTurn();
    await idleAfterStop();

    const ack = cloud().messages.find((m) => m.id.endsWith('-ack'));
    expect(ack).toMatchObject({ stopped: true });
    expect(ack?.content.trim()).toBe('Saving.');
    expect(cloud().messages.every((m) => m.toolCalls === undefined)).toBe(true);
    expect(cloud().error).toBeNull();
    expect(chatCalls()).toHaveLength(1);
    expect(chatCalls()[0].aborted).toBe(true);
    expect(useFloatingChatStore.getState().proposal).toBeNull();
    expect(await getFacts()).toEqual([]);
  });

  it('persona loop: a saveExtractedFacts call still in flight on the next leg never lands, and nothing is staged', async () => {
    // Leg 0 routes to facts/interest as the default responder does; leg 1 answers with a full call,
    // but only after 5 s of silence, and the reader presses Stop inside that window.
    server.use(
      ...mockGateway((call) =>
        isRouteLeg(call)
          ? defaultResponder(call)
          : {
              chunks: [
                reply(
                  'Saving that now.',
                  toolCall('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows Formula 1 racing' }] }),
                ),
              ],
              headerDelayMs: 5000,
            },
      ),
    );
    const { engine } = await attachCloud(personaAgentFor());
    engine.send('I follow Formula 1 racing');
    await advanceUntil(() => chatCalls().length === 2);
    expect(chatCalls().map(isRouteLeg)).toEqual([true, false]);

    stopChatTurn();
    await idleAfterStop();

    expect(chatCalls()).toHaveLength(2);
    expect(chatCalls()[1].aborted).toBe(true);
    const everyCall = cloud().messages.flatMap((m) => m.toolCalls ?? []);
    expect(everyCall.map((c) => c.name)).not.toContain('saveExtractedFacts');
    expect(cloud().messages.every((m) => m.toolCalls === undefined)).toBe(true);
    expect(cloud().messages.some((m) => m.content.includes('Saving that now'))).toBe(false);
    expect(useFloatingChatStore.getState().proposal).toBeNull();
    expect(await getFacts()).toEqual([]);
    expect(cloud().error).toBeNull();
  });
});

describe('item 9: Stop between the forced leg and its re-ask', () => {
  const real = cloudCompleteModule.cloudChatStream;

  /** Wraps the REAL cloudChatStream (R23b): yields everything, and once the FIRST forced call's
   *  generator has finished, fires `afterFirstForced`. The Stop lands exactly in the gap between the
   *  forced leg and its re-ask. Returns the list of requests the wrapper saw. */
  function wrapForced(afterFirstForced: () => void): CloudChatStreamRequest[] {
    const seen: CloudChatStreamRequest[] = [];
    let fired = false;
    spy = jest.spyOn(cloudCompleteModule, 'cloudChatStream').mockImplementation((req: CloudChatStreamRequest) => {
      seen.push(req);
      return (async function* () {
        yield* real(req);
        if (req.toolChoice === 'required' && !fired) {
          fired = true;
          afterFirstForced();
        }
      })();
    });
    return seen;
  }

  const SAVE_TOOL = {
    type: 'function' as const,
    function: { name: 'saveExtractedFacts', description: 'Offer facts', parameters: { type: 'object' as const, properties: {} } },
  };
  const base = { role: 'tool' as const, model: 'BIG', systemPrompt: 's', messages: [{ role: 'user' as const, content: 'm' }] };

  it('agent adapter: the forced leg answers with no call, the Stop lands, and no re-ask is sent', async () => {
    server.use(...mockGateway(() => 'no call'));
    const stop = new AbortController();
    const seen = wrapForced(() => stop.abort());
    const deps = makeAgentDeps('msg', jest.fn(), undefined, stop.signal);

    const out = await advanceUntilDone(deps.callModel({ ...base, tools: [SAVE_TOOL], toolChoice: 'required' }));

    expect(seen).toHaveLength(1);
    expect(chatCalls()).toHaveLength(1);
    expect(lastContent(chatCalls()[0])).toBe('m');
    expect(out.toolCalls).toEqual([]);
    expect(out.content).toBe('no call');
    // Past the Stop, a tool the loop would run answers "stopped" and touches nothing.
    await expect(deps.tools.saveExtractedFacts({ extracted_user_information: ['Lives in Porto'] })).resolves.toEqual({ error: 'stopped' });
    expect(await getFacts()).toEqual([]);
  });

  it('agent adapter, control: with no Stop the same wrapper sees the re-ask (so the wrapper counts both legs)', async () => {
    server.use(...mockGateway(() => 'no call'));
    const stop = new AbortController();
    const seen = wrapForced(() => undefined);
    const deps = makeAgentDeps('msg', jest.fn(), undefined, stop.signal);

    await advanceUntilDone(deps.callModel({ ...base, tools: [SAVE_TOOL], toolChoice: 'required' }));

    expect(seen).toHaveLength(2);
    expect(chatCalls()).toHaveLength(2);
    expect(lastContent(chatCalls()[1])).toBe(REQUIRED_TOOL_REASK);
  });
});

// --- drivers -------------------------------------------------------------------------------

/** Leg 0 (the route leg) is the stalled reply; later legs answer by default. */
function stallFirst(head: string) {
  return (call: GatewayCall) => (call.route === 'chat' && call.index === 0 ? stalledOn(head) : defaultResponder(call));
}

const personaAgentFor = () => new PersonaUpdateAgent(FIXTURE_ACCOUNT.userId, 'CONFIG');
