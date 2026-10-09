// The default responder: enough of each prompt's output contract that the app
// code under test does not crash or retry. A test that cares about the text
// passes its own responder to mockGateway().
import type { GatewayCall, GatewayResponder } from '../../helpers/gateway';

const FENCE = /<<ARTICLE [a-f0-9]{12}>>/g;

const content = (call: GatewayCall, role: string) =>
  call.messages.find((m) => m.role === role)?.content ?? '';

const HARNESS_LINES = /^(<state>|<known_facts>|<tool_response>|They were answering|Their previous message|Earlier in this chat)/;
/** The person's own message in a persona-loop leg: the first user turn the harness did not write. */
const personMessage = (call: GatewayCall) =>
  call.messages.find((m) => m.role === 'user' && !HARNESS_LINES.test(m.content))?.content ?? '';

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
    // The persona loop (lib/mera-harness/core/core.ts) sends no history: each leg is the system
    // prompt, then <state>, <known_facts>, optional context lines, THE PERSON'S MESSAGE, then this
    // leg's tool results as `<tool_response>name: {...}`. The route leg's system prompt carries
    // the skill index; a skill leg's carries the skill body.
    const factTurn = FACT_TURN.exec(personMessage(call));
    if (system.includes('## Skill index')) {
      return loadSkillCall(factTurn ? 'facts/interest' : 'conversation/question');
    }
    const offered = call.messages.some((m) => m.role !== 'system' && m.content.includes('saveExtractedFacts:'));
    if (factTurn && !offered) return saveFactCall(factTurn[1].trim());
    return 'E2E fixture answer.';
  }
  // Topic generation, combo pass, headline, summary: not scripted yet.
  return '[]';
};
