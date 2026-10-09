// The default responder: enough of each prompt's output contract that the app
// code under test does not crash or retry. A test that cares about the text
// passes its own responder to mockGateway().
import type { GatewayCall, GatewayResponder } from '../../helpers/gateway';

const FENCE = /<<ARTICLE [a-f0-9]{12}>>/g;

const content = (call: GatewayCall, role: string) =>
  call.messages.find((m) => m.role === role)?.content ?? '';

const LOAD_SKILL_CALL =
  'One moment.\n<tool_call>\n<function=load_skill>\n<parameter=id>\nconversation/question\n</parameter>\n</function>\n</tool_call>';

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

  if (call.route === 'chat') {
    const seenToolResult = call.messages.some((m) => m.content.includes('<tool_response>'));
    if (!seenToolResult && system.includes('## Skill index')) return LOAD_SKILL_CALL;
    return 'E2E fixture answer.';
  }
  // Topic generation, combo pass, headline, summary: not scripted yet.
  return '[]';
};
