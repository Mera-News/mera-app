// onemera S1.5: the agent corpus can test back-references. A web search answer is scripted per turn
// (in the device's single-entry shape), the recent block reaches the next turn, and the offer guards
// catch a fact that names an earlier subject. Real loop, scripted model, no network.
import { resetAgentArmsForTest } from '@/lib/mera-harness/core/arms';
import { PERSONA_SKILL_IDS } from '@/lib/mera-harness/skills/index.generated';
import { groupTurns, offerGuardReport } from '@/lib/mera-harness/eval/agent-metrics';
import { routeKindsFor } from '@/lib/mera-harness/eval/contract';
import { runAgentScript } from '@/lib/mera-harness/eval/run-agent-corpus';
import { parseScript } from '@/lib/mera-harness/eval/script';
import type { AgentScript, EvalModelRequest, EvalModelResult, EvalRow } from '@/lib/mera-harness/eval/types';

afterEach(() => resetAgentArmsForTest());

const tc = (name: string, args: unknown = {}) => ({ name, argumentsRaw: JSON.stringify(args) });
const res = (over: Partial<EvalModelResult> = {}): EvalModelResult => ({
  content: '', toolCalls: [], finishReason: 'stop', truncated: false, usage: null,
  modelSent: 'm', latencyMs: 1, ttVisibleMs: null, error: null, ...over,
});

const ASK = {
  index: 0,
  user: 'Who won the Tour de France this year?',
  expect: { routeKind: 'question', skill: 'conversation/question', tools: [], legs: 3 },
  fakeTools: {
    webSearch: [{ query: 'tour de france', results: [{ title: 'Pogacar wins the Tour', url: 'https://x.org/a', snippet: 'Pogacar won.' }] }],
  },
};
const FACT = {
  index: 1,
  user: 'I work as a nurse at a hospital',
  expect: { routeKind: 'profession', skill: 'facts/profession', tools: [], legs: 3, offerExcludes: ['pogacar', 'tour de france'] },
};

function script(turns: unknown[]): AgentScript {
  return parseScript(
    { id: 'backref', cohort: 'backref', persona: { facts: [], topics: [] }, declinedTopics: [], turns },
    { routeKinds: routeKindsFor(PERSONA_SKILL_IDS), skillIds: PERSONA_SKILL_IDS },
  );
}

async function drive(s: AgentScript, results: EvalModelResult[]) {
  const rows: EvalRow[] = [];
  const requests: EvalModelRequest[] = [];
  let i = 0;
  await runAgentScript(s, {
    callModel: async (req) => {
      requests.push(req);
      return results[Math.min(i++, results.length - 1)];
    },
    sink: (r) => rows.push(r),
    arm: 'baseline@m', variant: 'baseline', model: 'm', repeat: 0,
    skillIds: PERSONA_SKILL_IDS,
  });
  return { rows, requests };
}

const ask = [
  res({ toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
  res({ content: 'Looking.', toolCalls: [tc('webSearch', { queries: ['Tour de France winner 2026'] })] }),
  res({ content: 'Pogacar won it.' }),
];

describe('scripted web search', () => {
  it('a scripted query returns the device\'s single-entry shape with the scripted results', async () => {
    const { rows } = await drive(script([ASK]), ask);
    const call = rows.flatMap((r) => r.toolCalls).find((c) => c.name === 'webSearch')!;
    expect(call.result).toEqual({
      query: 'Tour de France winner 2026',
      searched: true,
      results: [{ title: 'Pogacar wins the Tour', url: 'https://x.org/a', snippet: 'Pogacar won.' }],
    });
  });

  it('the next turn carries the exchange and what it was about', async () => {
    const s = script([ASK, FACT]);
    const { requests } = await drive(s, [
      ...ask,
      res({ toolCalls: [tc('load_skill', { id: 'facts/profession' })] }),
      res({ content: 'Offered.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Works as a nurse' }] })] }),
      res({ content: 'Tap to confirm.' }),
    ]);
    const routeOfTurn1 = requests[3].messages.map((m) => m.content).join('\n');
    expect(routeOfTurn1).toContain('They said: Who won the Tour de France this year?');
    expect(routeOfTurn1).toContain('Last turn was about: Tour de France winner 2026');
  });
});

describe('offer guards', () => {
  it('pass when the new fact names only the new subject, and miss when it names the earlier one', async () => {
    const s = script([ASK, FACT]);
    const clean = await drive(s, [
      ...ask,
      res({ toolCalls: [tc('load_skill', { id: 'facts/profession' })] }),
      res({ content: 'Offered.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Works as a nurse' }] })] }),
      res({ content: 'Tap to confirm.' }),
    ]);
    const leaky = await drive(s, [
      ...ask,
      res({ toolCalls: [tc('load_skill', { id: 'facts/profession' })] }),
      res({ content: 'Offered.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Works as a nurse' }, { statement: 'Follows Pogacar' }] })] }),
      res({ content: 'Tap to confirm.' }),
    ]);
    const expectFor = (id: string, idx: number) => s.turns.find((t) => t.index === idx)?.expect ?? null;

    expect(offerGuardReport(groupTurns(clean.rows), expectFor)).toMatchObject({ checked: 1, passed: 1 });
    const miss = offerGuardReport(groupTurns(leaky.rows), expectFor);
    expect(miss).toMatchObject({ checked: 1, passed: 0 });
    expect(miss.misses[0].offered).toContain('Follows Pogacar');
  });

  it('noOffer misses on any offer at all', async () => {
    const s = script([{ index: 0, user: 'okay, follow this', expect: { routeKind: 'question', skill: 'conversation/question', tools: [], legs: 2, noOffer: true } }]);
    const { rows } = await drive(s, [
      res({ toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: 'Offered.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Interested in news' }] })] }),
      res({ content: 'Tap to confirm.' }),
    ]);
    expect(offerGuardReport(groupTurns(rows), () => s.turns[0].expect)).toMatchObject({ checked: 1, passed: 0 });
  });
});

describe('a fact card waiting on screen (fixture pendingCards)', () => {
  const CARD = "Follows NASA's Artemis lunar program";
  const ACK = { index: 0, user: 'ok', pendingCards: [CARD], expect: { routeKind: 'question', skill: 'conversation/question', tools: [], legs: 2, noOffer: true } };
  const NEXT = { index: 1, user: 'thanks', expect: { routeKind: 'question', skill: 'conversation/question', tools: [], legs: 2 } };

  it('reaches the loop as state.pendingCardStatements for that turn only', async () => {
    const turn = [res({ toolCalls: [tc('load_skill', { id: 'conversation/question' })] }), res({ content: 'Tap Add on the card above.' })];
    // "ok" beside the card gets one more tool-free leg that points at it.
    const { requests } = await drive(script([ACK, NEXT]), [...turn, res({ content: 'Tap Add on the card above.' }), ...turn]);
    const said = (r: EvalModelRequest) => r.messages.map((m) => m.content).join('\n');
    expect(said(requests[0])).toContain(`Cards already waiting for the user: "${CARD}"`);
    expect(requests[2].tools ?? []).toEqual([]);
    expect(said(requests[3])).not.toContain('Cards already waiting');
  });

  it('a malformed pendingCards is a load error', () => {
    expect(() => script([{ ...ACK, pendingCards: [''] }])).toThrow(/pendingCards/);
    expect(() => script([{ ...ACK, pendingCards: CARD }])).toThrow(/pendingCards/);
  });
});

describe('a turn scored only on its outcome', () => {
  // waiting-card.json: routing and leg count beside a waiting card were never
  // measured, so the turn carries only noOffer, card.noApply and replyMatches.
  it('loads with no routeKind, skill or legs, and scores no route for it', async () => {
    const s = script([{ index: 0, user: 'ok', pendingCards: ['Works as a nurse'], expect: { noOffer: true, card: { noApply: true }, replyMatches: ['card'] } }]);
    expect(s.turns[0].expect.routeKind).toBeUndefined();
    expect(s.turns[0].expect.legs).toBeUndefined();
    const { rows } = await drive(s, [res({ toolCalls: [tc('load_skill', { id: 'conversation/question' })] }), res({ content: 'Tap the card above.' })]);
    expect(rows.every((r) => r.expectedRouteKind === null && r.expectedSkill === null)).toBe(true);
  });

  it('a routeKind or skill that IS written must still exist', () => {
    expect(() => script([{ index: 0, user: 'ok', expect: { routeKind: 'nonsense' } }])).toThrow(/routeKind/);
    expect(() => script([{ index: 0, user: 'ok', expect: { skill: 'facts/nonsense' } }])).toThrow(/skill/);
    expect(() => script([{ index: 0, user: 'ok', expect: { legs: 0 } }])).toThrow(/legs/);
  });
});
