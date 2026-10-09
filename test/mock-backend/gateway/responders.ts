// The default responder: enough of each prompt's output contract that the app
// code under test does not crash or retry. A test that cares about the text
// passes its own responder to mockGateway().
import type { GatewayCall, GatewayResponder } from '../../helpers/gateway';

const FENCE = /<<ARTICLE [a-f0-9]{12}>>/g;

const content = (call: GatewayCall, role: string) =>
  call.messages.find((m) => m.role === role)?.content ?? '';

const loadSkillCall = (id: string) =>
  `One moment.\n<tool_call>\n<function=load_skill>\n<parameter=id>\n${id}\n</parameter>\n</function>\n</tool_call>`;

// A fact turn is any chat whose user text says "I follow <x>": the e2e sign-in adds one such fact
// in onboarding so the Feed has topics to fetch (a zero-fact Feed requests no articles at all).
const FACT_TURN = /\bI follow ([^.\n"]+)/i;
const saveFactCall = (subject: string) =>
  '<tool_call>\n<function=saveExtractedFacts>\n<parameter=extracted_user_information>\n' +
  JSON.stringify([{ statement: `Follows ${subject}` }]) +
  '\n</parameter>\n</function>\n</tool_call>';

export const defaultResponder: GatewayResponder = (call) => {
  if (call.route === 'web-search') {
    const q = content(call, 'user');
    return JSON.stringify(
      [1, 2].map((n) => ({
        title: `Result ${n} for ${q}`,
        url: `https://example.com/${encodeURIComponent(q)}/${n}`,
        snippet: `E2E fixture snippet ${n}.`,
      })),
    );
  }
  if (call.route === 'fact-check-claims') {
    const q = content(call, 'user');
    return JSON.stringify([
      {
        claim: q,
        claimant: '',
        claimDate: '',
        publisher: { name: 'Example Fact Check', site: 'example.com' },
        url: 'https://example.com/fact-check',
        title: 'E2E fixture review',
        reviewDate: '',
        textualRating: 'False',
      },
    ]);
  }

  const user = content(call, 'user');
  const system = content(call, 'system');
  const fences = user.match(FENCE)?.length ?? 0;

  // Relevance scoring (numbers are accepted by parseBatchRelevanceResponse).
  // Batch items carry no id on the wire, so the system prompt is the fallback.
  if (call.callId?.startsWith('score:') || (fences > 0 && /relevan/i.test(system))) {
    return JSON.stringify(Array<number>(Math.max(1, fences)).fill(0.9));
  }
  if (call.callId?.startsWith('reason:')) return 'E2E fixture reason about this story.';

  // Topic generation (lib/mera-harness/core/topic-call.ts): the user message opens with `Fact: "..."`.
  const fact = /^Fact: "([^"]+)"/.exec(user);
  if (fact) {
    const subject = fact[1].replace(/^(follows|interested in|likes)\s+/i, '');
    return JSON.stringify([`${subject} news`, `${subject} results`]);
  }

  if (call.route === 'chat') {
    const all = call.messages.map((m) => m.content).join('\n');
    const toolResults = all.split('<tool_response>').length - 1;
    // Only the person's own first message counts: skill bodies and the system prompt quote examples.
    const factTurn = FACT_TURN.exec(content(call, 'user'));
    if (toolResults === 0 && system.includes('## Skill index')) {
      return loadSkillCall(factTurn ? 'facts/interest' : 'conversation/question');
    }
    if (factTurn && toolResults === 1) return saveFactCall(factTurn[1].trim());
    return 'E2E fixture answer.';
  }
  // Topic generation, combo pass, headline, summary: not scripted yet.
  return '[]';
};
