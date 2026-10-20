// node:test (harness-local has no jest): npx tsx --test harness-local/lib/option-quality.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namesEndedSeason, scoreOptions, summarise } from './option-quality';

const today = '2026-10-14';
const source = 'Floods in Assam displace thousands as the Brahmaputra rises';
const good = [
  { label: 'Assam Floods', search: 'Assam floods Brahmaputra displacement' },
  { label: 'Assam Flood Relief', search: 'Assam flood relief' },
  { label: 'India Monsoon Floods', search: 'India monsoon flooding' },
];

test('a grounded, widening set of 3 passes', () => {
  assert.deepEqual(scoreOptions({ source, options: good, today }), []);
});

test('a copied prompt example fails, whatever the dash or case', () => {
  const options = [...good.slice(0, 2), { label: 'russia-ukraine WAR', search: 'x' }];
  assert.ok(scoreOptions({ source, options, today }).includes('copied-example'));
});

test('2 options, or 5 before the cut, fail the count', () => {
  assert.ok(scoreOptions({ source, options: good.slice(0, 2), today }).includes('count'));
  assert.ok(scoreOptions({ source, options: good, rawCount: 5, today }).includes('count'));
});

test('options naming nothing from the source fail', () => {
  const options = good.map(() => ({ label: 'World Weather', search: 'global climate events' }));
  assert.ok(scoreOptions({ source, options, today }).includes('no-entity'));
});

test('a broad first option followed by a narrower one fails widening', () => {
  const options = [good[2], good[0], good[1]];
  assert.ok(scoreOptions({ source, options, today }).includes('not-widening'));
});

test('ended years and seasons fail; the current year and a running season do not', () => {
  assert.equal(namesEndedSeason('PSV 2025-26 Champions League', today), true);
  assert.equal(namesEndedSeason('Elections 2025', today), true);
  assert.equal(namesEndedSeason('Assam floods 2026', today), false);
  assert.equal(namesEndedSeason('PSV 2026/27 season', today), false);
  assert.equal(namesEndedSeason('PSV 2026-2027', today), false);
});

test('summarise counts passes and each check', () => {
  const s = summarise([[], ['count', 'no-entity'], ['count']]);
  assert.equal(s.passed, 1);
  assert.equal(s.byCheck.count, 2);
  assert.equal(s.byCheck['no-entity'], 1);
});
