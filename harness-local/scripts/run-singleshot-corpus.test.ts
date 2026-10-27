// harness-local: the single-shot runner's arg parsing and count-matched exclusion.
//
//   npx tsx --tsconfig harness-local/tsconfig.json --test \
//     harness-local/scripts/run-singleshot-corpus.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countMatched, liveSystem, loadPrePrompts, parseArgs, prePostVerdict } from './run-singleshot-corpus';
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

test('verdict: post within max(1, spread) of pre on proposeTrack, other kinds within spread', () => {
  const rows = (arm: string, track: number, fc: number, ans: number) => [
    ...Array.from({ length: 6 }, (_, i) => ({ arm, expect: 'proposeTrack' as const, pass: i < track })),
    ...Array.from({ length: 3 }, (_, i) => ({ arm, expect: 'proposeFactCheck' as const, pass: i < fc })),
    ...Array.from({ length: 3 }, (_, i) => ({ arm, expect: 'answer' as const, pass: i < ans })),
  ];
  const mk = (pre: number[], post: number[], twin: number[]) => [...rows('pre', pre[0], pre[1], pre[2]), ...rows('post', post[0], post[1], post[2]), ...rows('post-twin', twin[0], twin[1], twin[2])];
  assert.equal(prePostVerdict(mk([5, 3, 3], [4, 3, 3], [4, 3, 3])).verdict, 'PASS'); // one below pre, floor 1
  assert.equal(prePostVerdict(mk([5, 3, 3], [3, 3, 3], [3, 3, 3])).verdict, 'FAIL'); // two below, spread 0
  assert.equal(prePostVerdict(mk([5, 3, 3], [5, 2, 3], [5, 3, 3])).verdict, 'PASS'); // fc moved 1 <= spread 1
  assert.equal(prePostVerdict(mk([5, 3, 3], [5, 1, 3], [5, 1, 3])).verdict, 'FAIL'); // fc moved 2 > spread 0
});
