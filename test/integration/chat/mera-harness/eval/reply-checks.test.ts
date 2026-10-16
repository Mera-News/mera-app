// Reply checks on the turn's FINAL reply (replyScript / replyExcludes /
// replyMatches), the fixture's app language, and the two wiring gaps that made
// a skill-leg measurement meaningless: the eval sent `skill:<id>` instead of the
// skill body, and its explainMera answered placeholder text. Fake model, no
// network.

import { parseScript } from '@/lib/mera-harness/eval/script';
import { runAgentScript } from '@/lib/mera-harness/eval/run-agent-corpus';
import { groupTurns, replyCheckReport } from '@/lib/mera-harness/eval/agent-metrics';
import { REPLY_SCRIPT_MIN_SHARE, scriptShare } from '@/lib/mera-harness/eval/copy-rules';
import { routeKindsFor } from '@/lib/mera-harness/eval/contract';
import { loadSkill } from '@/lib/mera-harness/core/skill-loader';
import { PERSONA_SKILL_IDS } from '@/lib/mera-harness/skills/index.generated';
import type { EvalModelRequest, EvalModelResult, EvalRow, ScriptTurn } from '@/lib/mera-harness/eval/types';

const OPTS = { routeKinds: routeKindsFor(PERSONA_SKILL_IDS), skillIds: PERSONA_SKILL_IDS };

function aboutMera(over: { persona?: Record<string, unknown>; expect?: Record<string, unknown> } = {}) {
  return {
    id: 'hi',
    cohort: 'hi',
    persona: { facts: [], topics: [], ...(over.persona ?? {}) },
    declinedTopics: [],
    turns: [{
      index: 0,
      user: 'मेरा ऐप मेरे डेटा को कैसे संभालता है?',
      expect: {
        routeKind: 'about-mera', skill: 'conversation/about-mera', tools: ['load_skill', 'explainMera'], legs: 3,
        ...(over.expect ?? {}),
      },
    }],
  };
}

describe('script validation: language and reply checks', () => {
  it('accepts languageName and the three reply checks, and carries them through', () => {
    const s = parseScript(aboutMera({
      persona: { languageName: 'Hindi' },
      expect: { replyScript: 'devanagari', replyExcludes: ['menu', 'मेनू'], replyMatches: ['mb', 'एमबी'] },
    }), OPTS);
    expect(s.persona.languageName).toBe('Hindi');
    expect(s.turns[0].expect.replyScript).toBe('devanagari');
    expect(s.turns[0].expect.replyExcludes).toEqual(['menu', 'मेनू']);
    expect(s.turns[0].expect.replyMatches).toEqual(['mb', 'एमबी']);
  });

  it('rejects an unknown script', () => {
    expect(() => parseScript(aboutMera({ expect: { replyScript: 'cyrillic' } }), OPTS)).toThrow(/replyScript/);
  });

  // The reply is lowercased before matching, so an uppercase needle can never
  // hit and the check would pass or fail for a reason nobody wrote down.
  it('rejects a needle that is not lowercase, or empty, or not a string', () => {
    expect(() => parseScript(aboutMera({ expect: { replyMatches: ['MB'] } }), OPTS)).toThrow(/lowercase/);
    expect(() => parseScript(aboutMera({ expect: { replyExcludes: [''] } }), OPTS)).toThrow(/replyExcludes/);
    expect(() => parseScript(aboutMera({ expect: { replyExcludes: 'menu' } }), OPTS)).toThrow(/replyExcludes/);
  });

  it('rejects a languageName that is not a non-empty string', () => {
    expect(() => parseScript(aboutMera({ persona: { languageName: '' } }), OPTS)).toThrow(/languageName/);
  });
});

describe('scriptShare', () => {
  it('counts letters only: Latin brand words beside Hindi stay a minority', () => {
    const share = scriptShare('आपका Mera प्लान रोज़ 10 MB तक पढ़ता है।', 'devanagari');
    expect(share).not.toBeNull();
    expect(share!).toBeGreaterThanOrEqual(REPLY_SCRIPT_MIN_SHARE);
  });

  it('scores an English reply near zero, and a reply with no letters as null', () => {
    expect(scriptShare('In the app, open the menu and tap Learn about Mera.', 'devanagari')).toBe(0);
    expect(scriptShare('10 / 50 / 200 …', 'devanagari')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wiring: what actually goes on the wire
// ---------------------------------------------------------------------------

function aboutMeraModel(captured: EvalModelRequest[], reply: string) {
  let call = 0;
  return async (req: EvalModelRequest): Promise<EvalModelResult> => {
    captured.push(req);
    call += 1;
    const toolCalls =
      call === 1 ? [{ name: 'load_skill', argumentsRaw: JSON.stringify({ id: 'conversation/about-mera' }) }]
      : call === 2 ? [{ name: 'explainMera', argumentsRaw: JSON.stringify({ topics: ['plans_and_limits'] }) }]
      : [];
    return {
      content: call === 1 ? 'एक पल।' : call === 2 ? 'मैं देखता हूँ।' : reply,
      toolCalls, finishReason: 'stop', truncated: false,
      usage: null, modelSent: req.model, latencyMs: 1, ttVisibleMs: null, error: null,
    };
  };
}

async function driveAboutMera(persona: Record<string, unknown>, reply = 'आपके प्लान में रोज़ 10 MB मिलता है।') {
  const script = parseScript(aboutMera({ persona }), OPTS);
  const captured: EvalModelRequest[] = [];
  const rows: EvalRow[] = [];
  const explained: string[][] = [];
  await runAgentScript(script, {
    callModel: aboutMeraModel(captured, reply),
    sink: (r) => rows.push(r),
    arm: 'm@baseline', variant: 'baseline', model: 'm', repeat: 0,
    skillIds: PERSONA_SKILL_IDS,
    explainMera: async (a) => {
      explained.push(a.topics);
      return { sections: a.topics.map((topic) => ({ topic, text: 'REAL TEXT: Starter 10 MB a day.' })) };
    },
  });
  return { captured, rows, explained };
}

describe('the eval sends what the app sends', () => {
  it('sends the REAL composed skill body on the skill leg, with the Voice rules naming the fixture language last', async () => {
    const { captured } = await driveAboutMera({ languageName: 'Hindi' });
    const body = loadSkill('conversation/about-mera');
    expect(body).not.toBeNull();
    const skillLeg = captured[1].systemPrompt;
    expect(skillLeg.startsWith(body!)).toBe(true);
    expect(skillLeg).not.toMatch(/^skill:/);
    const voice = skillLeg.slice(skillLeg.lastIndexOf('## Voice'));
    expect(voice).toContain('**Hindi**');
    // The route leg carries the language too.
    expect(captured[0].systemPrompt).toContain('**Hindi**');
  });

  it('without languageName the persona gets the match-the-user rule, as the app does today', async () => {
    const { captured } = await driveAboutMera({});
    expect(captured[1].systemPrompt).toContain("Match the user's language");
    expect(captured[1].systemPrompt).not.toContain('**Hindi**');
  });

  it('routes explainMera to the injected answer, so the reply is scored against real reference text', async () => {
    const { captured, explained, rows } = await driveAboutMera({});
    expect(explained).toEqual([['plans_and_limits']]);
    const leg2 = captured[2].messages.map((m) => m.content).join('\n');
    expect(leg2).toContain('REAL TEXT: Starter 10 MB a day.');
    expect(rows[rows.length - 1].reply).toBe('आपके प्लान में रोज़ 10 MB मिलता है।');
  });
});

// ---------------------------------------------------------------------------
// The metric
// ---------------------------------------------------------------------------

function lastRow(over: Partial<EvalRow>): EvalRow {
  return {
    scriptId: 'hi', cohort: 'hi', turnIndex: 0, legIndex: 0, repeat: 0,
    arm: 'a', variant: 'baseline', callType: 'agent-tool',
    interleaveGroup: 'hi:0', promptDeterministic: false, formatRetries: null,
    replyRetries: null, replyClaimUnfixed: null, replyLeakUnfixed: null,
    systemPrompt: 'S', messages: [], toolSchemaNames: [], rawOutput: '',
    toolCalls: [], turnStartedAtMs: 0, legStartedAtMs: 0,
    latencyMs: 1, ttVisibleMs: null, thinkingRequested: false, inputTokens: 1,
    usage: null, finishReason: 'stop', truncated: false, error: null,
    modelRequested: 'm', modelSent: 'm', endedOn: 'settled', awaitingUser: false,
    routeKind: null, skillLoaded: null, expectedRouteKind: 'none', expectedSkill: 'conversation/question',
    items: null, factKind: null, topics: null, dropped: null,
    ...over,
  };
}

describe('replyCheckReport', () => {
  const expect0: ScriptTurn['expect'] = {
    routeKind: 'about-mera', skill: 'conversation/about-mera', tools: [], legs: 3,
    replyScript: 'devanagari', replyExcludes: ['menu', 'learn about mera'], replyMatches: ['mb', 'एमबी'],
  };
  const report = (rows: EvalRow[]) => replyCheckReport(groupTurns(rows), () => expect0);

  it('passes a Hindi reply naming MB with no redirect', () => {
    const r = report([lastRow({ reply: 'आपके प्लान में रोज़ 10 MB मिलता है।' })]);
    expect(r.script).toMatchObject({ checked: 1, passed: 1, noReply: 0, errored: 0 });
    expect(r.excludes).toMatchObject({ checked: 1, passed: 1 });
    expect(r.matches).toMatchObject({ checked: 1, passed: 1 });
  });

  it('fails the owner’s screenshot reply on all three checks', () => {
    const r = report([lastRow({
      reply: "In the app, open the menu and tap 'Learn about Mera' to see exactly how it handles your data.",
    })]);
    expect(r.script).toMatchObject({ checked: 1, passed: 0 });
    expect(r.excludes).toMatchObject({ checked: 1, passed: 0 });
    expect(r.matches).toMatchObject({ checked: 1, passed: 0 });
    expect(r.script.misses[0].reply).toMatch(/^In the app/);
  });

  // NEVER folded in: an empty reply passes every exclude and fails every
  // script check for a reason that has nothing to do with language.
  it('counts an empty reply and a transport error apart from the checked turns', () => {
    const r = report([
      lastRow({ repeat: 0, reply: '' }),
      lastRow({ repeat: 1, reply: null, error: 'fetch failed', endedOn: 'transport_error' }),
      lastRow({ repeat: 2, reply: 'आपके प्लान में रोज़ 10 MB मिलता है।' }),
    ]);
    for (const k of ['script', 'excludes', 'matches'] as const) {
      expect(r[k]).toMatchObject({ checked: 1, passed: 1, noReply: 1, errored: 1 });
    }
  });

  it('skips a turn whose expect carries no reply check', () => {
    const r = replyCheckReport(groupTurns([lastRow({ reply: 'English' })]), () => ({ ...expect0, replyScript: undefined, replyExcludes: undefined, replyMatches: undefined }));
    expect(r.script.checked + r.script.noReply + r.script.errored).toBe(0);
  });
});
