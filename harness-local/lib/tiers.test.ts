// Turn selection, the lane pool and the count-matched exclusion of the agent corpus.
//   npx tsx --tsconfig harness-local/tsconfig.json --test harness-local/lib/tiers.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { addOnly, erroredCells, loadTier, runPool, selectTurns, TIERS_PATH } from './tiers';
import { SpendLimitError } from './near-call';
import type { AgentScript, EvalRow } from '../../lib/mera-harness/eval/types';

const turn = (index: number, chooses?: string): AgentScript['turns'][number] =>
  ({ index, ...(chooses ? { chooses } : { user: `u${index}` }), expect: { tools: [] } }) as unknown as AgentScript['turns'][number];
const script = (id: string, turns: AgentScript['turns']): AgentScript =>
  ({ id, cohort: id, persona: { facts: [], topics: [] }, declinedTopics: [], turns }) as unknown as AgentScript;

const SCRIPTS = [script('a', [turn(0), turn(1), turn(2), turn(3)]), script('b', [turn(0), turn(1, 'Yes')]), script('c', [turn(0)])];

test('a selection keeps the named scripts and turns, with their ORIGINAL indexes', () => {
  const out = selectTurns(SCRIPTS, { c: null, a: [3, 1] });
  assert.deepEqual(out.map((s) => [s.id, s.turns.map((t) => t.index)]), [['a', [1, 3]], ['c', [0]]]);
});

test('a kept choice reply whose question turn was dropped is refused', () => {
  assert.throws(() => selectTurns(SCRIPTS, { b: [1] }), /b turn 1 is a choice reply but turn 0 is not selected/);
  assert.equal(selectTurns(SCRIPTS, { b: [0, 1] })[0].turns.length, 2);
});

test('an unknown script or turn index is refused', () => {
  assert.throws(() => selectTurns(SCRIPTS, { zz: null }), /'zz'/);
  assert.throws(() => selectTurns(SCRIPTS, { a: [9] }), /a has no turn 9/);
});

test('--only parses script and script:i,j', () => {
  const sel = {};
  addOnly(sel, 'a:0,2');
  addOnly(sel, 'c');
  assert.deepEqual(sel, { a: [0, 2], c: null });
});

test('tiers.json: the plan’s turn counts, and every tier loads against the real fixtures', () => {
  const tiers = JSON.parse(readFileSync(TIERS_PATH, 'utf8')) as Record<string, Record<string, number[]>>;
  const count = (name: string): number => Object.values(tiers[name]).reduce((n, t) => n + t.length, 0);
  assert.deepEqual(
    Object.fromEntries(Object.keys(tiers).map((n) => [n, count(n)])),
    { facts: 26, conversation: 23, 'feed-tuning': 9, decision: 58, full: 82 },
  );
  const dir = join(__dirname, '../../lib/mera-harness/eval/fixtures/scripts');
  const real = Object.keys(tiers.full).map((id) => {
    const raw = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as AgentScript;
    return script(id, raw.turns.map((t, i) => turn(i, t.chooses)));
  });
  for (const name of Object.keys(tiers)) assert.ok(selectTurns(real, loadTier(name)).length > 0);
  assert.throws(() => loadTier('nope'), /Known: facts, conversation/);
});

test('the pool never runs more than N jobs at once and runs every job', async () => {
  let live = 0;
  let peak = 0;
  const done: number[] = [];
  await runPool([...Array(10).keys()], 3, async (j) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5 + (j % 3)));
    live -= 1;
    done.push(j);
  });
  assert.equal(peak, 3);
  assert.deepEqual(done.sort((x, y) => x - y), [...Array(10).keys()]);
});

test('a thrown spend limit stops the pool taking jobs, lets in-flight jobs finish, and is rethrown', async () => {
  const started: number[] = [];
  const finished: number[] = [];
  await assert.rejects(
    runPool([...Array(10).keys()], 2, async (j) => {
      started.push(j);
      if (j === 2) throw new SpendLimitError('402', '5', '5', '');
      await new Promise((r) => setTimeout(r, 10));
      finished.push(j);
    }),
    SpendLimitError,
  );
  assert.ok(started.length <= 4, `started ${started.join(',')}`);
  assert.deepEqual(finished, started.filter((j) => j !== 2));
});

test('an error row in ANY arm excludes that (script, repeat) for every arm', () => {
  const row = (scriptId: string, repeat: number, arm: string, error: string | null) =>
    ({ scriptId, repeat, arm, error }) as EvalRow;
  const cells = erroredCells([row('a', 0, 'x', null), row('a', 0, 'y', 'AbortError'), row('a', 1, 'x', null), row('b', 0, 'x', 'stall')]);
  assert.deepEqual([...cells].sort(), ['a|0', 'b|0']);
});
