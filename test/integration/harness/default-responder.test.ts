// The default gateway responder's scripted paths decode with the app's own parsers, so the e2e
// lane's sign-in (one "I follow ..." fact in onboarding) and chat flow can rely on them.
import { parseTopics } from '@/lib/mera-harness';
import { parseToolCallsFromText } from '@/lib/llm/text-tool-protocol';
import { defaultResponder, type GatewayCall } from '@/test/helpers';

const call = (messages: GatewayCall['messages'], route: GatewayCall['route'] = 'chat'): GatewayCall => ({
  route, model: 'm', stream: false, algo: 'ed25519', messages, headers: {}, index: 0, aborted: false,
});
const calls = (text: string) => parseToolCallsFromText(text, undefined, 'xml').calls;
const SYSTEM = { role: 'system', content: 'Router.\n## Skill index\n| facts/interest | ... |' };

describe('defaultResponder scripted paths', () => {
  it('a fact turn loads facts/interest, then offers the fact', () => {
    const user = { role: 'user', content: 'I follow Formula 1 racing' };
    const leg0 = calls(defaultResponder(call([SYSTEM, user])) as string);
    expect(leg0.map((c) => [c.name, JSON.parse(c.argumentsRaw)])).toEqual([['load_skill', { id: 'facts/interest' }]]);

    // A skill leg, shaped as the persona loop sends it: state, known facts, the message, no history.
    const state = { role: 'user', content: '<state>route: interest</state>' };
    const known = { role: 'user', content: '<known_facts>\n(none)\n</known_facts>' };
    const leg1 = calls(defaultResponder(call([{ role: 'system', content: 'facts skill' }, state, known, user])) as string);
    expect(leg1).toHaveLength(1);
    expect(leg1[0].name).toBe('saveExtractedFacts');
    expect(JSON.parse(leg1[0].argumentsRaw).extracted_user_information).toEqual([{ statement: 'Follows Formula 1 racing' }]);

    // Once the offer's result is back, the leg closes in prose instead of offering again.
    const offered = { role: 'user', content: '<tool_response>\nsaveExtractedFacts: {"pendingFacts":[]}\n</tool_response>' };
    expect(defaultResponder(call([{ role: 'system', content: 'facts skill' }, state, known, user, offered]))).toBe('E2E fixture answer.');
  });

  it('any other chat routes to conversation/question and answers in prose', () => {
    const user = { role: 'user', content: 'What is new today?' };
    expect(calls(defaultResponder(call([SYSTEM, user])) as string)[0]).toMatchObject({ name: 'load_skill' });
    expect(JSON.parse(calls(defaultResponder(call([SYSTEM, user])) as string)[0].argumentsRaw)).toEqual({ id: 'conversation/question' });
    expect(defaultResponder(call([{ role: 'system', content: 'question skill' }, { role: 'user', content: '<state>x</state>' }, user]))).toBe('E2E fixture answer.');
  });

  it('topic generation returns topics the app parser accepts', () => {
    const out = defaultResponder(call([{ role: 'system', content: 'topics skill' }, { role: 'user', content: 'Fact: "Follows Formula 1 racing"' }])) as string;
    expect(parseTopics(out)).toEqual(['Formula 1 racing news', 'Formula 1 racing results']);
  });
});
