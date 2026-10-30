// The device adapter `makeAgentDeps` / `callModelViaCloud` against the gateway mock: real E2EE both
// ways, real limiter, real tool handlers on the real database. What the model side received comes
// from `gatewayCalls()`; what a tool did from rows and recorded requests.
import { makeAgentDeps } from '@/lib/chat-tools/agent-device-port';
import { REQUIRED_TOOL_REASK } from '@/lib/llm/text-tool-protocol';
import { createAgentState, runAgentTurn, type AgentModelRequest } from '@/lib/mera-harness';
import type { LiveTool } from '@/lib/llm/chat-phase-store';
import { gatewayCalls, mockGateway, mockGql, server, signInFixtureAccount, type GatewayCall } from '@/test/helpers';
import { reply, resetChatModules, seedFacts, setWebSearchInChat, toolCall } from '@/test/integration/chat/_helpers';

jest.setTimeout(30_000);

const SAVE_TOOL = {
  type: 'function',
  function: { name: 'saveExtractedFacts', description: 'Offer facts', parameters: { type: 'object', properties: {} } },
};
const base: AgentModelRequest = { role: 'tool', model: 'BIG', systemPrompt: 's', messages: [{ role: 'user', content: 'm' }] };

/** Counts the HTTP requests whose path ends with `suffix`. */
function countRequests(suffix: string): () => number {
  let n = 0;
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname.endsWith(suffix)) n += 1;
  });
  return () => n;
}

const lastMessage = (call: GatewayCall) => call.messages[call.messages.length - 1];

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});
afterEach(() => server.events.removeAllListeners());

// ux1 C1: every leg's text streamed into the acknowledgement bubble.
describe('makeAgentDeps streams only the leg the loop marks', () => {
  it('forwards deltas for streamToUser legs only, and sends the other legs as one envelope', async () => {
    server.use(...mockGateway(() => 'hi'));
    const onDelta = jest.fn();
    const deps = makeAgentDeps('msg', onDelta);

    const quiet = await deps.callModel({ ...base });
    expect(onDelta).not.toHaveBeenCalled();
    expect(quiet.content).toBe('hi');

    const watched = await deps.callModel({ ...base, streamToUser: true });
    expect(onDelta).toHaveBeenCalledWith({ content: 'hi' });
    expect(watched.content).toBe('hi');

    // Only the watched leg streams on the wire.
    expect(gatewayCalls('chat').map((c) => c.stream)).toEqual([false, true]);
  });

  it('puts the tier word through to a real model id: BIG never reaches the provider', async () => {
    server.use(...mockGateway(() => 'ok'));
    const deps = makeAgentDeps('msg', jest.fn());

    const out = await deps.callModel({ ...base, model: 'BIG' });

    const sent = gatewayCalls('chat')[0].model;
    expect(sent).not.toBe('BIG');
    expect(out.modelSent).toBe(sent);
  });

  it('maps every tool call the model wrote into the result, with its raw arguments', async () => {
    server.use(...mockGateway(() => reply('Noted.', toolCall('find_similar_facts', { kind: 'residence' }))));
    const deps = makeAgentDeps('msg', jest.fn());

    const out = await deps.callModel({ ...base, tools: [SAVE_TOOL] });

    expect(out.content.trim()).toBe('Noted.');
    expect(out.toolCalls.map((c) => c.name)).toEqual(['find_similar_facts']);
    expect(out.toolCalls[0].argumentsRaw).toContain('residence');
    expect(out.error).toBeNull();
  });
});

describe('a forced leg (tool_choice required) with no call back is re-asked ONCE', () => {
  const call = toolCall('saveExtractedFacts', { extracted_user_information: [] });

  it('re-asks with the re-ask line last, and returns the second answer', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? 'no call' : call)));
    const deps = makeAgentDeps('msg', jest.fn());

    const out = await deps.callModel({ ...base, tools: [SAVE_TOOL], toolChoice: 'required' });

    const calls = gatewayCalls('chat');
    expect(calls).toHaveLength(2);
    expect(lastMessage(calls[0])).toEqual({ role: 'user', content: 'm' });
    expect(lastMessage(calls[1])).toEqual({ role: 'user', content: REQUIRED_TOOL_REASK });
    expect(out.toolCalls.map((c) => c.name)).toEqual(['saveExtractedFacts']);
  });

  it('never re-asks twice, and never re-asks an auto leg', async () => {
    server.use(...mockGateway(() => 'no call'));
    const deps = makeAgentDeps('msg', jest.fn());

    await deps.callModel({ ...base, tools: [SAVE_TOOL], toolChoice: 'required' });
    expect(gatewayCalls('chat')).toHaveLength(2);

    await deps.callModel({ ...base, tools: [SAVE_TOOL], toolChoice: 'auto' });
    expect(gatewayCalls('chat')).toHaveLength(3);
  });

  it('does not re-ask when the first answer already carries a call', async () => {
    server.use(...mockGateway(() => call));
    await makeAgentDeps('msg', jest.fn()).callModel({ ...base, tools: [SAVE_TOOL], toolChoice: 'required' });
    expect(gatewayCalls('chat')).toHaveLength(1);
  });
});

describe('hindifix A: explainMera through the device port', () => {
  it('offers explainMera and answers from the real reference text, with no network', async () => {
    const requests = countRequests('/graphql');
    const deps = makeAgentDeps('how does mera handle my data', jest.fn());
    const out = await deps.tools.explainMera?.({ topics: ['plans_and_limits'] });
    const sections = (out as { sections: { topic: string; text: string }[] }).sections;
    expect(sections.map((x) => x.topic)).toEqual(['plans_and_limits']);
    expect(sections[0].text).toContain('2 MB');
    expect(requests()).toBe(0);
    expect(gatewayCalls('chat')).toEqual([]);
  });

  it('answers "stopped" after Stop', async () => {
    const stop = new AbortController();
    const deps = makeAgentDeps('msg', jest.fn(), undefined, stop.signal);
    stop.abort();
    await expect(deps.tools.explainMera?.({ topics: ['what_is_mera'] })).resolves.toEqual({ error: 'stopped' });
  });
});

describe('ux2 D10: web search through the device port', () => {
  it('offers webSearch while the setting is on and runs it on the device: one gateway search per query', async () => {
    await setWebSearchInChat(true);
    const deps = makeAgentDeps('what is porto santo', jest.fn());
    expect(typeof deps.tools.webSearch).toBe('function');

    const out = await deps.tools.webSearch?.({ queries: ['Porto Santo'] });

    expect(gatewayCalls('web-search').map((c) => c.messages[0].content)).toEqual(['Porto Santo']);
    expect(out).toMatchObject({ searched: true });
  });

  it('fans queries out in ONE request', async () => {
    await setWebSearchInChat(true);
    const requests = countRequests('/v1/web-search');
    const deps = makeAgentDeps('compare', jest.fn());

    const out = await deps.tools.webSearch?.({ queries: ['porto santo', 'vila baleira'] });

    expect(requests()).toBe(1);
    expect(gatewayCalls('web-search').map((c) => c.messages[0].content)).toEqual(['porto santo', 'vila baleira']);
    expect(out).toMatchObject({ searched: true });
    expect((out as { searches: unknown[] }).searches).toHaveLength(2);
  });

  it('narrates the wait with the webSearch phase before the search is sent', async () => {
    await setWebSearchInChat(true);
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/v1/web-search')) seen.push('request');
    });
    const deps = makeAgentDeps('what is porto santo', jest.fn(), (p) => seen.push(String(p)));

    await deps.tools.webSearch?.({ queries: ['Porto Santo'] });

    expect(seen).toEqual(['webSearch', 'request']);
  });

  it('offers no webSearch when the setting is off, so the loop never declares it', async () => {
    await setWebSearchInChat(false);
    const deps = makeAgentDeps('what is porto santo', jest.fn());
    expect(deps.tools.webSearch).toBeUndefined();
  });

  it('GATE 2: a port built while the setting was on still sends nothing once it is switched off', async () => {
    await setWebSearchInChat(true);
    const deps = makeAgentDeps('what is porto santo', jest.fn());
    await setWebSearchInChat(false);

    const out = await deps.tools.webSearch?.({ queries: ['Porto Santo'] });

    expect(out).toMatchObject({ searched: false });
    expect(gatewayCalls('web-search')).toEqual([]);
  });
});

// THE STOP BUTTON. Once the signal aborts, no model call or tool starts: the loop sees a resolved
// error and ends the turn with no further legs.
describe('makeAgentDeps honours Stop', () => {
  it('a model call after Stop never reaches the network', async () => {
    const requests = countRequests('/v1/chat/completions');
    const stop = new AbortController();
    const deps = makeAgentDeps('msg', jest.fn(), undefined, stop.signal);
    stop.abort();

    const out = await deps.callModel(base);

    expect(out).toMatchObject({ error: 'stopped', content: '', toolCalls: [] });
    expect(requests()).toBe(0);
    expect(gatewayCalls()).toEqual([]);
  });

  it('a stream cut by Stop resolves as stopped instead of throwing', async () => {
    server.use(...mockGateway(() => ({ chunks: ['par', 'tial', ' more'], chunkDelayMs: 40 })));
    const stop = new AbortController();
    const seen: string[] = [];
    const deps = makeAgentDeps(
      'msg',
      (d) => {
        if (d.content) seen.push(d.content);
        stop.abort();
      },
      undefined,
      stop.signal,
    );

    await expect(deps.callModel({ ...base, streamToUser: true })).resolves.toMatchObject({ error: 'stopped' });
    // The first delta landed; the turn was cut before the tail.
    expect(seen.join('')).not.toContain('more');
  });

  it('tools run until Stop and answer "stopped" without touching the device after', async () => {
    await setWebSearchInChat(true);
    await seedFacts(['Lives in Berlin, Germany, EU']);
    const placeRequests = countRequests('/graphql');
    const stop = new AbortController();
    const deps = makeAgentDeps('msg', jest.fn(), undefined, stop.signal);

    const before = await deps.tools.findSimilarFacts({});
    expect(before.candidates.map((c) => c.statement)).toEqual(['Lives in Berlin, Germany, EU']);

    stop.abort();
    const requestsAtStop = placeRequests();

    await expect(deps.tools.findSimilarFacts({})).resolves.toEqual({ error: 'stopped' });
    await expect(deps.tools.lookupPlace({ query: 'Porto' })).resolves.toEqual({ error: 'stopped' });
    await expect(deps.tools.saveExtractedFacts({ extracted_user_information: ['Lives in Porto'] })).resolves.toEqual({ error: 'stopped' });
    await expect(deps.tools.deleteUserFacts({ fact_ids: ['f1'] })).resolves.toEqual({ error: 'stopped' });
    await expect(deps.tools.webSearch?.({ queries: ['Porto'] })).resolves.toEqual({ error: 'stopped' });
    expect(placeRequests()).toBe(requestsAtStop);
    expect(gatewayCalls('web-search')).toEqual([]);
  });

  it('the real loop runs no second leg and stages nothing once Stop lands in leg one', async () => {
    server.use(...mockGateway(() => reply('One moment.', toolCall('load_skill', { id: 'facts/residence' }))));
    const stop = new AbortController();
    const deps = makeAgentDeps('I moved to Porto', jest.fn(), undefined, stop.signal);
    // The reader presses Stop while the first leg is ending.
    const callModel = deps.callModel;
    deps.callModel = async (req) => {
      const out = await callModel(req);
      stop.abort();
      return out;
    };
    const state = createAgentState({
      surface: 'CONFIG',
      languageName: 'English',
      facts: [{ id: 'f1', statement: 'Lives in Amsterdam', attribute: 'location: residence' }],
    });

    const out = await runAgentTurn({ state, userMessage: 'I moved to Porto', deps });

    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(out.proposals).toHaveLength(0);
  });
});

// hindifix: the app never passed its language into the loop, so every reply was
// told only to "match the user's language" instead of being pinned to the app's.
describe('buildAgentPersona pins the app language', () => {
  it.each([
    ['hi', 'Hindi'],
    ['zh-CN', 'Chinese (Simplified)'],
    ['en', 'English'],
  ])('app language %s reaches the loop as %s', async (code, name) => {
    const { useAppLanguageStore } = require('@/lib/stores/app-language-store') as typeof import('@/lib/stores/app-language-store');
    const { buildAgentPersona } = require('@/lib/chat-tools/agent-device-port') as typeof import('@/lib/chat-tools/agent-device-port');
    useAppLanguageStore.setState({ appLanguage: code });

    const persona = await buildAgentPersona('persona-ONBOARDING');

    expect(persona.languageName).toBe(name);
  });

  it('the pinned language is in the system prompt the gateway receives', async () => {
    server.use(...mockGateway(() => 'ok'));
    const { useAppLanguageStore } = require('@/lib/stores/app-language-store') as typeof import('@/lib/stores/app-language-store');
    const { buildAgentPersona } = require('@/lib/chat-tools/agent-device-port') as typeof import('@/lib/chat-tools/agent-device-port');
    useAppLanguageStore.setState({ appLanguage: 'hi' });

    const state = createAgentState(await buildAgentPersona('persona-ONBOARDING'));
    await runAgentTurn({ state, userMessage: 'नमस्ते', deps: makeAgentDeps('नमस्ते', jest.fn()) });

    expect(gatewayCalls('chat')[0].messages[0].content).toContain('**Hindi**');
  });
});

// The live tool row: the port brackets every device tool with start and end, under the CONTRACT
// name the step labels key on, so the strip can rest on the phone while the tool really runs.
describe('onTool: the tool the phone is running', () => {
  function recorder() {
    const events: string[] = [];
    const tools: LiveTool[] = [];
    const onTool = (event: 'start' | 'end', tool: LiveTool) => {
      events.push(`${event}:${tool.toolName}:${tool.kind}`);
      tools.push(tool);
    };
    return { events, tools, onTool };
  }

  it('brackets each device tool with start and end under its contract name and kind', async () => {
    await setWebSearchInChat(true);
    server.use(mockGql('PlaceSearch', () => ({ placeSearch: [] })));
    const { events, onTool } = recorder();
    const deps = makeAgentDeps('msg', jest.fn(), undefined, undefined, undefined, onTool);

    await deps.tools.findSimilarFacts({});
    await deps.tools.lookupPlace({ query: 'Porto' });
    await deps.tools.saveExtractedFacts({ extracted_user_information: [] });
    await deps.tools.deleteUserFacts({ fact_ids: [] });
    await deps.tools.webSearch?.({ queries: ['Porto'] });

    expect(events).toEqual([
      'start:find_similar_facts:facts', 'end:find_similar_facts:facts',
      'start:lookup_place:place', 'end:lookup_place:place',
      'start:saveExtractedFacts:write', 'end:saveExtractedFacts:write',
      'start:deleteUserFacts:remove', 'end:deleteUserFacts:remove',
      'start:webSearch:web', 'end:webSearch:web',
    ]);
  });

  it('carries the own arguments of the call, which the row label reads (the place word)', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    server.use(mockGql('PlaceSearch', async () => { await held; return { placeSearch: [] }; }));
    const { events, tools, onTool } = recorder();
    const deps = makeAgentDeps('msg', jest.fn(), undefined, undefined, undefined, onTool);

    const lookup = deps.tools.lookupPlace({ query: 'Porto' });
    // The lookup is still on the wire: the row must already say so, and not yet be over.
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(['start:lookup_place:place']);
    expect(tools[0].args).toEqual({ query: 'Porto' });
    release();
    await lookup;
    expect(events).toEqual(['start:lookup_place:place', 'end:lookup_place:place']);
  });

  it('a web search starts its row, then narrates, then sends, then ends', async () => {
    await setWebSearchInChat(true);
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/v1/web-search')) seen.push('request');
    });
    const deps = makeAgentDeps(
      'what is porto santo',
      jest.fn(),
      (p) => seen.push(String(p)),
      undefined,
      undefined,
      (event, tool) => seen.push(`${event}:${tool.kind}`),
    );

    await deps.tools.webSearch?.({ queries: ['Porto Santo'] });

    expect(seen).toEqual(['start:web', 'webSearch', 'request', 'end:web']);
  });

  it('explainMera is no live step: pure, local text', async () => {
    const { events, onTool } = recorder();
    const deps = makeAgentDeps('how does mera handle my data', jest.fn(), undefined, undefined, undefined, onTool);
    await deps.tools.explainMera?.({ topics: ['privacy'] });
    expect(events).toEqual([]);
  });

  it('ends the row when the tool throws', async () => {
    const { events, onTool } = recorder();
    const deps = makeAgentDeps('msg', jest.fn(), undefined, undefined, undefined, onTool);

    await expect(deps.tools.deleteUserFacts(null as never)).rejects.toThrow();

    expect(events).toEqual(['start:deleteUserFacts:remove', 'end:deleteUserFacts:remove']);
  });

  it('starts nothing after Stop', async () => {
    await setWebSearchInChat(true);
    const { events, onTool } = recorder();
    const stop = new AbortController();
    const deps = makeAgentDeps('msg', jest.fn(), undefined, stop.signal, undefined, onTool);
    stop.abort();

    await deps.tools.findSimilarFacts({});
    await deps.tools.lookupPlace({ query: 'Porto' });
    await deps.tools.saveExtractedFacts({ extracted_user_information: ['Lives in Porto'] });
    await deps.tools.deleteUserFacts({ fact_ids: ['f1'] });
    await deps.tools.webSearch?.({ queries: ['Porto'] });

    expect(events.filter((e) => e.startsWith('start:'))).toEqual([]);
  });

  it('an untapped delete never reaches the port: the card is the confirmation, so no remove row runs', async () => {
    const [fact] = await seedFacts(['Plays chess']);
    server.use(...mockGateway((c) =>
      c.index === 0
        ? reply('One moment.', toolCall('load_skill', { id: 'conversation/correction' }))
        : c.index === 1
          ? reply('', toolCall('deleteUserFacts', { fact_ids: [fact.id] }))
          : 'Shall I remove it?'));
    const { events, onTool } = recorder();
    const deps = makeAgentDeps('forget that I play chess', jest.fn(), undefined, undefined, undefined, onTool);
    const state = createAgentState({
      surface: 'CONFIG',
      languageName: 'English',
      facts: [{ id: fact.id, statement: 'Plays chess', attribute: null }],
    });

    const out = await runAgentTurn({ state, userMessage: 'forget that I play chess', deps });

    // The loop did see the call (precondition), and staged it instead of running it.
    expect(out.legs.some((l) => l.toolCalls.some((c) => c.name === 'deleteUserFacts'))).toBe(true);
    expect(events.filter((e) => e.includes('deleteUserFacts'))).toEqual([]);
  });
});
