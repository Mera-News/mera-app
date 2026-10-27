// Scorer tests for fact-places-eval.ts.
//   npx tsx --tsconfig harness-local/tsconfig.json --test harness-local/scripts/fact-places-eval.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreCase, summarize, type EvalCase } from './fact-places-eval';

const city: EvalCase = { id: 'a', statement: 's', expect: { level: 'city', place: 'IN|Madhya Pradesh|Bhopal' }, alsoOk: ['IN|Madhya Pradesh'] };
const glob: EvalCase = { id: 'g', statement: 's', expect: { level: 'global', place: 'GLOBAL' } };
const one = (c: EvalCase, a: string | null) => scoreCase(c, [a]);

test('exact answer is correct, and a hit at every measure', () => {
  const s = one(city, 'IN|Madhya Pradesh|Bhopal');
  assert.deepEqual([s.correct[0], s.countryHit[0], s.levelHit[0], s.wrong[0]], [true, true, true, false]);
});
test('alsoOk answer counts as correct even at another level', () => {
  const s = one(city, 'IN|Madhya Pradesh');
  assert.deepEqual([s.correct[0], s.levelHit[0], s.wrong[0]], [true, true, false]);
});
test('right country, wrong level: country hit, level miss, not wrong', () => {
  const s = one(city, 'IN');
  assert.deepEqual([s.correct[0], s.countryHit[0], s.levelHit[0], s.wrong[0]], [false, true, false, false]);
});
test('wrong country is a wrong place', () => {
  const s = one(city, 'PK|Punjab|Lahore');
  assert.deepEqual([s.countryHit[0], s.levelHit[0], s.wrong[0]], [false, true, true]);
});
test('GLOBAL expected, country answered: wrong place, no country eligibility', () => {
  const s = one(glob, 'IN');
  assert.deepEqual([s.countryHit[0], s.levelHit[0], s.wrong[0]], [null, false, true]);
});
test('missing answer is a miss, never wrong', () => {
  const s = one(city, null);
  assert.deepEqual([s.correct[0], s.countryHit[0], s.levelHit[0], s.wrong[0]], [false, false, false, false]);
});
test('summarize applies the bar', () => {
  const r = summarize([one(city, 'IN|Madhya Pradesh|Bhopal'), one(glob, 'GLOBAL')]);
  assert.equal(r.pass, true);
  assert.equal(summarize([one(city, null)]).pass, false);
});
