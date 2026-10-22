// harness-local: the single-shot runner's arg parsing and count-matched exclusion.
//
//   npx tsx --tsconfig harness-local/tsconfig.json --test \
//     harness-local/scripts/run-singleshot-corpus.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countMatched, parseArgs } from './run-singleshot-corpus';
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
