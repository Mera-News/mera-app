// chatfix S3 eval support: the follow-card fakes, the script schema, the runner's More options
// turn, and the TRACK and MORE OPTIONS reports. Scripted model, no network.
import fs from 'node:fs';
import path from 'node:path';

import { resetAgentArmsForTest } from '@/lib/mera-harness/core/arms';
import { PERSONA_SKILL_IDS, PERSONA_SKILL_INDEX } from '@/lib/mera-harness/skills/index.generated';
import { groupTurns } from '@/lib/mera-harness/eval/agent-metrics';
import { routeKindsFor } from '@/lib/mera-harness/eval/contract';
import { createFakeTools } from '@/lib/mera-harness/eval/fake-tools';
import { runAgentScript } from '@/lib/mera-harness/eval/run-agent-corpus';
import { parseScript } from '@/lib/mera-harness/eval/script';
import { moreOptionsReport, trackReport } from '@/lib/mera-harness/eval/track-metrics';
import type { AgentScript, EvalModelRequest, EvalModelResult, EvalRow } from '@/lib/mera-harness/eval/types';

afterEach(() => resetAgentArmsForTest());

const OPTS = { routeKinds: routeKindsFor(PERSONA_SKILL_IDS), skillIds: PERSONA_SKILL_IDS };
const DIR = path.join(__dirname, '../../../../../lib/mera-harness/eval/fixtures/scripts');
const load = (name: string): AgentScript => parseScript(JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8')), OPTS);

const tc = (name: string, args: unknown = {}) => ({ name, argumentsRaw: JSON.stringify(args) });
const res = (over: Partial<EvalModelResult> = {}): EvalModelResult => ({
  content: '', toolCalls: [], finishReason: 'stop', truncated: false, usage: null,
  modelSent: 'm', latencyMs: 1, ttVisibleMs: null, error: null, ...over,
});

const base = (turns: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 's', cohort: 'follow-x', persona: { facts: [], topics: [] }, declinedTopics: [], turns, ...extra,
});
const parse = (raw: unknown) => parseScript(raw, OPTS);

async function drive(s: AgentScript, results: EvalModelResult[], requests: EvalModelRequest[] = []) {
  const rows: EvalRow[] = [];
  let i = 0;
  await runAgentScript(s, {
    callModel: async (req) => { requests.push(req); return results[Math.min(i++, results.length - 1)]; },
    sink: (r) => rows.push(r),
    arm: 'baseline@m', variant: 'baseline', model: 'm', repeat: 0,
    skillIds: PERSONA_SKILL_IDS,
  });
  return rows;
}

describe('fixtures', () => {
  const NAMES = ['follow-story', 'follow-story-hindi', 'follow-two-turn', 'follow-two-turn-feed', 'follow-persona', 'more-options', 'more-options-hindi', 'nothing-new-left'];
  it.each(NAMES)('%s parses and avoids the skill example subjects', (name) => {
    const text = fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8');
    expect(() => load(name)).not.toThrow();
    expect(text).not.toMatch(/ukrain|hungarian|valparaiso|chile|olympiakos/i);
  });
  it('the surface is on the stories fixtures and absent on the Mera button ones', () => {
    expect(load('follow-story').surface?.kind).toBe('follow-story');
    expect(load('follow-two-turn').surface?.kind).toBe('follow-story');
    expect(load('follow-two-turn-feed').surface).toBeUndefined();
    expect(load('follow-persona').surface).toBeUndefined();
  });
});

describe('fake proposeTrack and searchNews', () => {
  const fakes = () => createFakeTools(parse(base([{ index: 0, user: 'x', expect: { tools: [] } }])));

  it('stages a multi-select card, trims, and logs the option lists', async () => {
    const f = fakes();
    const out = await f.port.proposeTrack!({ options: [{ label: ' A Story ', search: ' a s ' }, { label: 'B', search: 'b' }, { label: ' ', search: 'c' }] });
    expect(out).toMatchObject({ staged: true, proposalId: 'track-1', options: [{ label: 'A Story', search: 'a s' }, { label: 'B', search: 'b' }] });
    expect(f.pendingProposal()).toMatchObject({ id: 'track-1', summary: 'A Story, B', chooseOne: true, appliable: false, multiSelect: true });
    expect(f.log.trackOptions).toHaveLength(1);
  });
  it('one option is appliable and not multiSelect; none is an error', async () => {
    const f = fakes();
    expect(await f.port.proposeTrack!({ options: [] })).toEqual({ error: 'options is required' });
    expect(f.pendingProposal()).toBeNull();
    await f.port.proposeTrack!({ options: [{ label: 'Only', search: 'o' }] });
    expect(f.pendingProposal()).toMatchObject({ chooseOne: false, appliable: true, multiSelect: false });
  });
  it('searchNews answers from the script by substring, else an empty note', async () => {
    const s = parse(base([{ index: 0, user: 'x', expect: { tools: ['searchNews'] }, fakeTools: { searchNews: [{ query: 'assam', headlines: ['Flood one'] }] } }]));
    const f = createFakeTools(s);
    f.beginTurn(s.turns[0], null);
    expect(await f.port.searchNews!({ query: 'Assam floods' })).toEqual({ query: 'Assam floods', results: [{ title: 'Flood one' }] });
    expect(await f.port.searchNews!({ query: 'other' })).toMatchObject({ results: [], note: expect.any(String) });
  });
});

describe('script schema', () => {
  const T = { index: 0, expect: { tools: [] } };
  it('exactly one of user, chooses, moreOptions', () => {
    const mo = { shown: [{ label: 'A', searchText: 'a' }], room: 2 };
    expect(() => parse(base([{ ...T, user: 'x', moreOptions: mo }]))).toThrow(/exactly one/);
    expect(() => parse(base([{ ...T }]))).toThrow(/exactly one/);
    expect(parse(base([{ index: 0, moreOptions: mo }])).turns[0].moreOptions).toEqual(mo);
    expect(() => parse(base([{ index: 0, moreOptions: { ...mo, room: 0 } }]))).toThrow(/room/);
  });
  it('expect.track needles must be lowercase; staged is required', () => {
    expect(() => parse(base([{ index: 0, user: 'x', expect: { tools: [], track: { staged: true, labelMatches: ['Assam'] } } }]))).toThrow(/lowercase/);
    expect(() => parse(base([{ index: 0, user: 'x', expect: { tools: [], track: { minOptions: 2 } } }]))).toThrow(/staged/);
    expect(() => parse(base([{ index: 0, user: 'x', expect: { tools: [], track: { staged: true, minOptions: 4, maxOptions: 3 } } }]))).toThrow(/above/);
  });
  it('searchNews answers are validated and must be reachable', () => {
    const ft = { searchNews: [{ headlines: ['h'] }] };
    expect(() => parse(base([{ index: 0, user: 'x', expect: { tools: [] }, fakeTools: ft }]))).toThrow(/does not expect that tool/);
    expect(() => parse(base([{ index: 0, user: 'x', expect: { tools: ['searchNews'] }, fakeTools: { searchNews: [{ headlines: [1] }] } }]))).toThrow(/headlines/);
    expect(() => parse(base([{ index: 0, user: 'x', expect: { tools: ['searchNews'] }, fakeTools: { searchNews: [{ query: 'Up', headlines: ['h'] }] } }]))).toThrow(/lowercase/);
  });
  it('surface needs a known kind', () => {
    expect(() => parse(base([{ index: 0, user: 'x', expect: { tools: [] } }], { surface: { kind: 'nope', hint: null, context: null } }))).toThrow(/surface/);
  });
});

describe('runner and TRACK report', () => {
  const stories = () => parse(base([
    { index: 0, user: 'the floods in assam', expect: { tools: ['searchNews'], track: { staged: true, minOptions: 2, labelMatches: ['assam'] } }, fakeTools: { searchNews: [{ headlines: ['Floods hit Assam'] }] } },
    { index: 1, user: 'I follow PSV', expect: { tools: [], track: { staged: false } } },
  ], { surface: { kind: 'follow-story', hint: 'They opened this chat from their Followed stories page to follow a news story.', context: null } }));

  it('scores a staged card against expect.track and counts a miss on the second turn', async () => {
    const rows = await drive(stories(), [
      res({ toolCalls: [tc('load_skill', { id: 'conversation/follow-story' })] }),
      res({ toolCalls: [tc('searchNews', { query: 'Assam floods' })] }),
      res({ toolCalls: [tc('proposeTrack', { options: [{ label: 'Assam Floods', search: 'Assam floods Brahmaputra' }, { label: 'Northeast Relief', search: 'Northeast relief funds' }] })], content: 'Pick the stories to follow below.' }),
      res({ toolCalls: [tc('load_skill', { id: 'conversation/follow-story' })] }),
      res({ toolCalls: [tc('proposeTrack', { options: [{ label: 'PSV', search: 'PSV Eindhoven' }] })] }),
    ]);
    expect(rows.find((r) => r.turnIndex === 0 && r.toolCalls.some((c) => c.name === 'searchNews'))?.toolCalls[0].schemaValid).toBe(true);
    expect(rows.flatMap((r) => r.toolCalls).filter((c) => c.unknownTool)).toEqual([]);
    const s = stories();
    const rep = trackReport(groupTurns(rows), (id, i) => s.turns.find((t) => t.index === i)?.expect ?? null);
    expect(rep).toMatchObject({ attempted: 2, staged: 2, refused: 0, histogram: { 1: 1, 2: 1 }, offCohortAttempts: 0, expected: 2, met: 1 });
    expect(rep.misses[0]).toMatchObject({ turnIndex: 1, detail: expect.stringContaining('card staged') });
  });

  it('puts the surface in the state the model sees and counts a proposeTrack off the follow cohorts', async () => {
    const requests: EvalModelRequest[] = [];
    const rows = await drive(stories(), [res({ toolCalls: [tc('load_skill', { id: 'conversation/follow-story' })] }), res({ toolCalls: [tc('proposeTrack', { options: [{ label: 'A', search: 'A' }] })] })], requests);
    expect(requests[0].messages.map((m) => m.content).join('\n')).toContain('Followed stories page');
    const rep = trackReport(groupTurns(rows), () => null, (c) => c === 'never');
    expect(rep.offCohortAttempts).toBe(rep.attempted);
    expect(rep.attempted).toBeGreaterThan(0);
    // A turn that expects the card (backref's "follow this") is not off-cohort noise.
    const expecting = trackReport(groupTurns(rows), () => ({ tools: [], track: { staged: true } }), (c) => c === 'never');
    expect(expecting.offCohortAttempts).toBe(0);
  });
});

describe('More options turn and report', () => {
  const SHOWN = [{ label: 'Assam Flood Relief', searchText: 'Assam flood relief funds' }, { label: 'Kaziranga Flooding', searchText: 'Kaziranga park flooding' }];
  const s = () => parse(base([{ index: 0, moreOptions: { shown: SHOWN, room: 3 } }], { cohort: 'more-options' }));
  const run = async (options: { label: string; search: string }[], content = '') => {
    const rows = await drive(s(), [res({ toolCalls: [tc('proposeTrack', { options })], content })]);
    return rows;
  };
  const report = (rows: EvalRow[], over: Partial<{ examples: string[]; nowYear: number }> = {}) =>
    moreOptionsReport(groupTurns(rows), (id, i) => s().turns.find((t) => t.index === i)?.moreOptions ?? null, { examples: ['Chile Wildfires'], nowYear: 2026, ...over });

  it('runs one forced leg on a copy, rows marked moreOptions, and passes fresh options', async () => {
    const rows = await run([{ label: 'Brahmaputra Erosion Crisis', search: 'Brahmaputra erosion Majuli Assam' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].moreOptions).toBe(true);
    expect(rows[0].callType).toBe('agent-tool');
    const r = report(rows);
    expect(r).toMatchObject({ passed: 1, options: 1, repeated: 0, proseWritten: 0 });
    expect(r.flags).toEqual({ 'copied-example': 0, 'ended-season': 0, 'no-entity': 0 });
    // The TRACK block leaves More options turns to this report.
    expect(trackReport(groupTurns(rows), () => null).attempted).toBe(0);
  });

  it('fails a reworded label and a repeated search text (case and spacing folded)', async () => {
    const r1 = report(await run([{ label: 'Assam Flood Relief Funds', search: 'Other Search' }]));
    expect(r1).toMatchObject({ passed: 0, repeated: 1 });
    const r2 = report(await run([{ label: 'Majuli Erosion', search: '  KAZIRANGA   park flooding ' }]));
    expect(r2).toMatchObject({ passed: 0, repeated: 1 });
  });

  it('flags a copied example, an ended season and a search with no capitalised word; counts prose', async () => {
    const r = report(await run([
      { label: 'chile wildfires', search: 'Chile fires' },
      { label: 'Season Review', search: 'Premier League 2019 title race' },
      { label: 'Flood Maps', search: 'flood maps of the region' },
    ], 'Here are more options.'));
    expect(r.flags).toEqual({ 'copied-example': 1, 'ended-season': 1, 'no-entity': 1 });
    expect(r.proseWritten).toBe(1);
    expect(r.passed).toBe(1);
  });

  it('does not advance the script state: a following turn sees none of the tap', async () => {
    const two = parse(base([
      { index: 0, moreOptions: { shown: SHOWN, room: 2 } },
      { index: 1, user: 'hello', expect: { tools: [] } },
    ]));
    const requests: EvalModelRequest[] = [];
    await drive(two, [res({ toolCalls: [tc('proposeTrack', { options: [{ label: 'New One', search: 'New One' }] })] }), res({ content: 'hi' })], requests);
    const turn1 = requests.slice(1).map((r) => r.messages.map((m) => m.content).join('\n')).join('\n');
    expect(turn1).not.toContain('More options');
  });

  it('skill example labels come from the skill index', () => {
    expect(PERSONA_SKILL_INDEX.find((e) => e.id === 'conversation/follow-story')?.examples.length).toBeGreaterThan(0);
  });
});
