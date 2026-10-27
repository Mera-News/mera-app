// harness-local: the single-shot runner's arg parsing and count-matched exclusion.
//
//   npx tsx --tsconfig harness-local/tsconfig.json --test \
//     harness-local/scripts/run-singleshot-corpus.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countMatched, harnessVerdict, liveSystem, loadPrePrompts, parseArgs, prePostVerdict, runTurnHarness, type HarnessCaller } from './run-singleshot-corpus';
import { BIG_MODEL } from '../../lib/llm/constants';

test('defaults: BIG_MODEL and the on, on-twin, off arms', () => {
  const a = parseArgs([]);
  assert.equal(a.model, BIG_MODEL);
  assert.deepEqual(a.arms.map((x) => x.id), ['on', 'on-twin', 'off']);
});

test('--model and --arms pick the model and arms; off-twin is off byte for byte', () => {
  const a = parseArgs(['--model', 'm/x', '--arms', 'off,off-twin']);
  assert.equal(a.model, 'm/x');
  assert.deepEqual(a.arms, [{ id: 'off', thinking: false }, { id: 'off-twin', thinking: false }]);
});

test('an unknown arm is refused', () => {
  assert.throws(() => parseArgs(['--arms', 'on,of']), /unknown arm "of"/);
});

test('an error row drops its (fixture, repeat) for every arm, and nothing else', () => {
  const row = (fixture: string, arm: string, repeat: number, error: string | null = null) => ({ fixture, arm, repeat, error });
  const rows = [
    row('a', 'on', 0), row('a', 'off', 0, 'HTTP 500'),
    row('b', 'on', 0), row('b', 'off', 0),
    row('a', 'on', 1), row('a', 'off', 1),
  ];
  const { valid, dropped } = countMatched(rows, 2);
  assert.deepEqual(dropped, ['a r0']);
  assert.deepEqual(valid.map((x) => `${x.fixture}${x.repeat}${x.arm}`), ['b0on', 'b0off', 'a1on', 'a1off']);
});

test('a cell missing an arm (a run cut mid-fixture) is dropped, and duplicate arms are refused', () => {
  const row = (fixture: string, arm: string, repeat: number) => ({ fixture, arm, repeat, error: null });
  const { dropped } = countMatched([row('a', 'on', 0), row('a', 'off', 0), row('b', 'on', 0)], 2);
  assert.deepEqual(dropped, ['b r0']);
  assert.throws(() => parseArgs(['--arms', 'on,on']), /duplicate arm/);
});

test('arm pre needs --pre-prompts; the D8 arms parse', () => {
  assert.throws(() => parseArgs(['--arms', 'pre']), /needs --pre-prompts/);
  const a = parseArgs(['--arms', 'pre,post,post-twin', '--pre-prompts', 'x.json']);
  assert.deepEqual(a.arms.map((x) => x.id), ['pre', 'post', 'post-twin']);
  assert.equal(a.prePrompts, 'x.json');
});

test('a snapshot byte-equal to the live prompts is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pre-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ followStory: 'old follow', followStoryTools: [], article: 'old article', articleTools: [] }));
  assert.equal(loadPrePrompts(bad).followStory, 'old follow');
  writeFileSync(bad, JSON.stringify({ followStory: 'x' }));
  assert.throws(() => loadPrePrompts(bad), /"article" must be a non-empty string/);
  writeFileSync(bad, JSON.stringify({ followStory: liveSystem('follow-story'), followStoryTools: [], article: 'old', articleTools: [] }));
  assert.throws(() => loadPrePrompts(bad), /measure nothing/);
  writeFileSync(bad, JSON.stringify({ followStory: 'old', followStoryTools: [], article: liveSystem('article'), articleTools: [] }));
  assert.throws(() => loadPrePrompts(bad), /measure nothing/);
});

test('verdict: per-kind spread; track within max(1, spread), other kinds within max(1, spread_k)', () => {
  const rows = (arm: string, track: number, fc: number, ans: number) => [
    ...Array.from({ length: 6 }, (_, i) => ({ arm, expect: 'proposeTrack' as const, pass: i < track })),
    ...Array.from({ length: 3 }, (_, i) => ({ arm, expect: 'proposeFactCheck' as const, pass: i < fc })),
    ...Array.from({ length: 3 }, (_, i) => ({ arm, expect: 'answer' as const, pass: i < ans })),
  ];
  const mk = (pre: number[], post: number[], twin: number[]) => [...rows('pre', pre[0], pre[1], pre[2]), ...rows('post', post[0], post[1], post[2]), ...rows('post-twin', twin[0], twin[1], twin[2])];
  const v = (pre: number[], post: number[], twin: number[]) => prePostVerdict(mk(pre, post, twin));
  assert.equal(v([5, 3, 3], [4, 3, 3], [4, 3, 3]).verdict, 'PASS'); // track one below pre, floor 1
  assert.equal(v([5, 3, 3], [3, 3, 3], [3, 3, 3]).verdict, 'FAIL'); // track two below, spread 0
  assert.equal(v([5, 3, 3], [3, 3, 3], [5, 3, 3]).verdict, 'PASS'); // track spread 2 widens the band
  assert.equal(v([5, 3, 3], [5, 2, 3], [5, 2, 3]).verdict, 'PASS'); // fc moved 1, floor 1 at spread 0
  assert.equal(v([5, 3, 3], [5, 1, 3], [5, 1, 3]).verdict, 'FAIL'); // fc moved 2 > max(1, 0)
  assert.equal(v([5, 3, 3], [5, 1, 3], [5, 3, 3]).verdict, 'PASS'); // fc spread 2 allows it
  assert.deepEqual(v([5, 3, 3], [4, 2, 3], [5, 3, 1]).spread, { proposeTrack: 1, proposeFactCheck: 1, answer: 2 });
});

test('the harness arm parses and runs a fake caller\'s proposeTrack through the real loop', async () => {
  assert.deepEqual(parseArgs(['--arms', 'off,off-twin,harness']).arms.map((x) => x.id), ['off', 'off-twin', 'harness']);
  const names = (tools: unknown): string[] =>
    Array.isArray(tools) ? tools.map((t) => (t as { function?: { name?: string } }).function?.name ?? '') : [];
  let proposed = false;
  const caller: HarnessCaller = async (req) => {
    const offered = names(req.tools);
    const base = { content: '', finishReason: 'stop', truncated: false, usage: null, modelSent: null, latencyMs: 1, error: null };
    if (offered.includes('load_skill')) return { ...base, toolCalls: [{ name: 'load_skill', argumentsRaw: JSON.stringify({ id: 'conversation/follow-story' }) }] };
    if (offered.includes('proposeTrack') && !proposed) {
      proposed = true;
      const options = [{ label: 'Dutch Cabinet Talks', search: 'Dutch cabinet formation talks' }, { label: 'Dutch Politics', search: 'Netherlands coalition politics' }, { label: 'EU Coalitions', search: 'European coalition governments' }];
      return { ...base, toolCalls: [{ name: 'proposeTrack', argumentsRaw: JSON.stringify({ options }) }] };
    }
    return { ...base, content: 'Pick the stories to follow below.', toolCalls: [] };
  };
  const row = await runTurnHarness(caller, { id: 'f', agent: 'follow-story', message: 'the dutch cabinet formation talks', expect: 'proposeTrack', search: ['a'] }, 'm', 0);
  assert.equal(row.arm, 'harness');
  assert.equal(row.trackOptions, 3);
  assert.equal(row.pass, true, row.why);
  assert.ok(row.legTools?.flat().includes('proposeTrack'));
  assert.equal(typeof row.closingLegFired, 'boolean');

  // One rule for off and harness: a 2-option proposeTrack fails.
  proposed = false;
  const two: HarnessCaller = async (req) => {
    const r = await caller(req);
    return r.toolCalls[0]?.name === 'proposeTrack'
      ? { ...r, toolCalls: [{ name: 'proposeTrack', argumentsRaw: JSON.stringify({ options: ['Dutch Cabinet Talks', 'Dutch Politics'] }) }] }
      : r;
  };
  const short = await runTurnHarness(two, { id: 'f', agent: 'follow-story', message: 'the dutch cabinet formation talks', expect: 'proposeTrack', search: ['a'] }, 'm', 0);
  assert.equal(short.trackOptions, 2);
  assert.equal(short.pass, false);
});

test('harness verdict: quality within max(1, spread) of off and p90 within 2x', () => {
  const rows = (arm: string, pass: number, ms: number) => Array.from({ length: 6 }, (_, i) => ({ arm, expect: 'proposeTrack' as const, pass: i < pass, wallMs: ms + i }));
  const v = (off: number, twin: number, h: number, hms: number) => harnessVerdict([...rows('off', off, 1000), ...rows('off-twin', twin, 1000), ...rows('harness', h, hms)]);
  assert.equal(v(5, 5, 4, 1500).verdict, 'PASS');
  assert.equal(v(5, 5, 3, 1500).verdict, 'FAIL'); // two below, spread 0
  assert.equal(v(5, 5, 5, 2100).verdict, 'FAIL'); // p90 above 2 x off p90 (1005)
  assert.equal(v(5, 3, 3, 1500).verdict, 'PASS'); // spread 2 widens the band
});
