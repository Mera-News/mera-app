// harness-local — the topic lifecycle eval, offline.
//
//   npx tsx --tsconfig harness-local/tsconfig.json --test harness-local/scripts/run-topic-lifecycle.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ARM_ORDER,
  TAPS,
  attributeSkill,
  buildRaterView,
  composeSkillFrom,
  dryCaller,
  isNearDuplicate,
  leaksOf,
  parseArgs,
  runLifecycle,
  type LifecycleFact,
  type LifecycleRow,
} from './run-topic-lifecycle';

const f = (id: string, statement: string, questionnaireAttribute = 'topics: general interests'): LifecycleFact => ({
  id, statement, questionnaireAttribute,
});

test('refuses anything but --target staging', () => {
  assert.throws(() => parseArgs([]), /--target staging is required/);
  assert.throws(() => parseArgs(['--target', 'prod']), /Refusing/);
  assert.equal(parseArgs(['--target', 'staging', '--dry-run', '--repeat', '2']).repeat, 2);
});

test('only the catch-all arms swap the catch-all attribute to generic', () => {
  const fact = f('a', 'Male');
  assert.equal(attributeSkill('catch-all-generic', fact), 'topics/generic');
  assert.equal(attributeSkill('short-catch-all', fact), 'topics/generic');
  assert.equal(attributeSkill('short', fact), 'topics/interest');
  assert.equal(attributeSkill('catch-all-generic', f('b', 'x', 'profession: job')), 'topics/profession');
});

test('composeSkillFrom puts the group generic ahead of the leaf', () => {
  const load = composeSkillFrom({ 'topics/generic': 'G', 'topics/interest': 'I', router: 'R' });
  assert.equal(load('topics/interest'), 'G\n\nI');
  assert.equal(load('topics/generic'), 'G');
  assert.equal(load('router'), 'R');
  assert.equal(load('nope'), null);
});

test('near-duplicate and leak detection', () => {
  assert.equal(isNearDuplicate('Fitness trends', ['fitness trends']), true);
  assert.equal(isNearDuplicate('Marathon training plans', ['Fitness trends']), false);
  const all = [f('i1', 'Interested in fitness'), f('i2', 'Follows Formula 1')];
  assert.deepEqual(leaksOf(['Fitness gear', 'Budget airlines'], all[0], all), []);
  assert.deepEqual(leaksOf(['Formula 1 race results', 'Fitness gear'], all[0], all), ['Formula 1 race results']);
});

test('dry lifecycle: null first per fact, 5 taps, no network, rater view hides arms', async () => {
  const rows: LifecycleRow[] = [];
  await runLifecycle(
    { call: dryCaller(), nullSkills: { 'topics/generic': 'G', 'topics/interest': 'I' }, model: 'm', write: (r) => rows.push(r) },
    [f('e1', 'Male')],
    [f('t1', 'Interested in fitness')],
    1,
  );
  assert.deepEqual(rows.filter((r) => r.pass === 'empty').map((r) => r.arm), ARM_ORDER);
  const taps = rows.filter((r) => r.pass === 'tap' && r.arm === 'short');
  assert.deepEqual(taps.map((r) => r.tap), Array.from({ length: TAPS + 1 }, (_, i) => i));
  assert.ok(rows.every((r) => r.attempts >= 1 && !r.malformed));

  const { view, key } = buildRaterView(rows);
  for (const arm of ARM_ORDER) assert.ok(!view.includes(arm), `${arm} leaked into the rater view`);
  assert.deepEqual(Object.keys(key['empty:e1']).sort(), ['A', 'B', 'C', 'D', 'E']);
});
