// SILENT TURNS (chatfix): the eval rows carry the loop's terminal and closing-leg counters, and the
// report counts a turn that shows nothing apart from one that shows a card or a sentence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScript } from '@/lib/mera-harness/eval/script';
import { runAgentScript } from '@/lib/mera-harness/eval/run-agent-corpus';
import { groupTurns, silentTurnReport } from '@/lib/mera-harness/eval/agent-metrics';
import { routeKindsFor } from '@/lib/mera-harness/eval/contract';
import { PERSONA_SKILL_IDS } from '@/lib/mera-harness/skills/index.generated';
import type { EvalModelRequest, EvalModelResult, EvalRow } from '@/lib/mera-harness/eval/types';

const OPTS = { routeKinds: routeKindsFor(PERSONA_SKILL_IDS), skillIds: PERSONA_SKILL_IDS };
const FIXTURE = join(__dirname, '../../../../../lib/mera-harness/eval/fixtures/scripts/silent-turns.json');

const result = (over: Partial<EvalModelResult>): EvalModelResult => ({
  content: '', toolCalls: [], finishReason: 'stop', truncated: false, usage: null,
  modelSent: 'm', latencyMs: 1, ttVisibleMs: null, error: null, ...over,
});
const call = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });

/** Routes to facts/interest, saves nothing, then stays silent. `closing` answers the closing leg. */
function model(closing: string) {
  return async (req: EvalModelRequest): Promise<EvalModelResult> => {
    if (req.role === 'route') return result({ content: 'Got it.', toolCalls: [call('load_skill', { id: 'facts/interest' })] });
    if (/Nothing was offered, saved or changed/.test(req.messages[req.messages.length - 1]?.content ?? '')) {
      return result({ content: closing });
    }
    return result({ toolCalls: [call('saveExtractedFacts', { extracted_user_information: [] })] });
  };
}

async function rowsFor(closing: string): Promise<EvalRow[]> {
  const script = parseScript(JSON.parse(readFileSync(FIXTURE, 'utf8')), OPTS);
  const one = { ...script, turns: script.turns.slice(0, 1) };
  const rows: EvalRow[] = [];
  await runAgentScript(one, {
    callModel: model(closing), sink: (r) => rows.push(r),
    arm: 'm@baseline', variant: 'baseline', model: 'm', repeat: 0, skillIds: PERSONA_SKILL_IDS,
  });
  return rows;
}

describe('silent turns in the eval', () => {
  it('the fixture loads', () => {
    expect(parseScript(JSON.parse(readFileSync(FIXTURE, 'utf8')), OPTS).turns.length).toBeGreaterThan(5);
  });

  it('a turn the closing leg answered is not silent, and the closing leg is counted', async () => {
    const report = silentTurnReport(groupTurns(await rowsFor('I did not change anything for Bollywood.')));
    expect(report).toEqual({ turns: 1, silent: [], closingFired: 1, cannedFired: 0, closingClaims: 0 });
  });

  it('a closing sentence that claims a change counts as a claim and as the canned line', async () => {
    const report = silentTurnReport(groupTurns(await rowsFor("Done, I've muted Bollywood.")));
    expect(report.closingClaims).toBe(1);
    expect(report.cannedFired).toBe(1);
    expect(report.silent).toEqual([]);
  });

  it('a last row with no reply and nothing on screen is silent', () => {
    const row = {
      scriptId: 's', turnIndex: 0, repeat: 0, arm: 'a', legIndex: 0, callType: 'agent-tool', error: null,
      endedOn: 'settled', reply: '', terminalReason: 'settled', stagedSomething: false, choicePending: false,
    } as unknown as EvalRow;
    expect(silentTurnReport(groupTurns([row])).silent).toEqual([{ scriptId: 's', turnIndex: 0, repeat: 0, arm: 'a' }]);
    expect(silentTurnReport(groupTurns([{ ...row, terminalReason: 'no-proposal' } as EvalRow])).silent).toEqual([]);
    expect(silentTurnReport(groupTurns([{ ...row, stagedSomething: true } as EvalRow])).silent).toEqual([]);
    // u6b2: a More options turn with no card is a MORE OPTIONS miss, not a silent chat turn.
    expect(silentTurnReport(groupTurns([{ ...row, moreOptions: true } as EvalRow]))).toMatchObject({ turns: 0, silent: [] });
  });
});
