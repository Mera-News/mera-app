// Positive control for score-scoring-fix: a synthetic run dir built to make each rule visibly fire.
// Node's runner: harness-local has no jest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerPromptVariant } from '@/lib/news-harness/prompts/prompt-variants';
import '@/lib/news-harness';
import { scoreRun } from './score-scoring-fix';

registerPromptVariant({ id: 'sf-rescore', description: 'test: rescores, demote-only', rescorePolicy: 'demote-only' });
registerPromptVariant({ id: 'sf-plain', description: 'test: no rescore field' });
registerPromptVariant({ id: 'sf-drop', description: 'test: no rescore field, drops a must_show' });

const ARTICLES = [
  { articleId: 'a', verdict: 'must_show', story: 's1' },
  { articleId: 'b', verdict: 'must_show', story: 's1' },
  { articleId: 'c', verdict: 'nice_to_have' },
  { articleId: 'd', verdict: 'skip' },
];
const BASE: Record<string, number> = { a: 0.8, b: 0.8, c: 0.8, d: 0.2 };
const M = 'm';

function build(pass1ByVariant: Record<string, Record<string, number>>, pass2ByVariant: Record<string, Record<string, number>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'score-fix-'));
  const fixture = join(dir, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ articles: ARTICLES }));
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ args: { fixture } }));
  const lines: string[] = [];
  for (const [variant, s1] of Object.entries(pass1ByVariant)) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const arm = `${M}@${variant}`;
      lines.push(JSON.stringify({
        arm, variant, repeat, callType: 'relevance-batch', dupOf: null, error: null,
        parsedSchema: { byId: ARTICLES.map((a) => ({ articleId: a.articleId, s: s1[a.articleId] })) },
      }));
      for (const [id, score] of Object.entries(pass2ByVariant[variant] ?? {})) {
        lines.push(JSON.stringify({
          arm, variant, repeat, callType: 'reason', dupOf: null, error: null,
          items: [{ id: `reason:${id}` }], parsedSchema: { reason: `note ${id}`, score },
        }));
      }
    }
  }
  writeFileSync(join(dir, 'rows.jsonl'), `${lines.join('\n')}\n`);
  return dir;
}

test('min of the two passes, per spec, with a must_show drop failing', () => {
  const dir = build(
    {
      baseline: BASE,
      'null-control': BASE,
      'sf-rescore': BASE,
      'sf-plain': BASE,
      'sf-drop': { ...BASE, a: 0.1 },
    },
    {
      // a: lower pass 2 changes FINAL; b: higher pass 2 does not.
      'sf-rescore': { a: 0.2, b: 0.95 },
      // same lower pass 2, but this arm's spec has no rescore: ignored.
      'sf-plain': { a: 0.2 },
    },
  );
  const res = scoreRun(dir);
  const arm = (v: string) => res.arms.find((a) => a.arm === `${M}@${v}`)!;

  assert.equal(arm('sf-rescore').rescores, true);
  assert.equal(arm('sf-rescore').changedByPass2, 4); // runner's count: a (lower) and b (higher), 2 repeats
  assert.equal(arm('sf-rescore').minChanges, 2); // only a is lower
  assert.equal(arm('sf-rescore').mean.mustPrecision, 0.5); // shown: b (must_show) and c (nice_to_have)
  assert.equal(arm('sf-rescore').mean.mustRecall, 0.5); // a fell below 0.4
  assert.equal(arm('sf-rescore').verdict, 'FAIL');

  assert.equal(arm('sf-plain').rescores, false);
  assert.equal(arm('sf-plain').changedByPass2, 2); // pass 2 differs, so the runner counts it...
  assert.equal(arm('sf-plain').mean.mustRecall, 1); // ...but FINAL ignores it
  assert.equal(arm('sf-plain').verdict, 'PASS');

  assert.equal(arm('sf-drop').verdict, 'FAIL');
  // Tier accuracy is gate side vs verdict: baseline all right, sf-drop wrong on a in every repeat.
  assert.equal(arm('baseline').tierAccuracy, 1);
  assert.equal(arm('sf-drop').tierAccuracy, 0.75);
  // Story s1 (a, b) stays in one band in baseline, splits across the gate in sf-drop.
  assert.deepEqual(arm('baseline').stableStories, { count: 1, of: 1, needed: 1 });
  assert.equal(arm('sf-drop').stableStories?.count, 0);
  assert.deepEqual(arm('sf-drop').failed, ['must-show recall']);

  assert.equal(arm('baseline').verdict, 'REFERENCE');
  assert.equal(arm('null-control').verdict, 'PASS');
  assert.equal(res.mismatch, null);
  assert.equal(res.crossCheck, 'skipped: no console.log');

  // Blind rater file: only note and tier, no arm; the key maps line number to the row.
  const lines = readFileSync(join(dir, 'rater-contradiction.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const key = JSON.parse(readFileSync(join(dir, 'rater-contradiction.key.json'), 'utf8')) as { line: number; arm: string }[];
  assert.equal(lines.length, key.length);
  for (const l of lines) assert.deepEqual(Object.keys(l).sort(), ['note', 'tier']);
  assert.ok(!JSON.stringify(lines).includes('@'));
});

test('the runner rescore count is read from console.log and compared', () => {
  const dir = build({ baseline: BASE, 'null-control': BASE, 'sf-rescore': BASE }, { 'sf-rescore': { a: 0.2, b: 0.95 } });
  writeFileSync(join(dir, 'console.log'), `RESCORE REPORT\n${M}@sf-rescore\n  rescore: n=4 mean-signed-delta=0\n`);
  const ok = scoreRun(dir);
  assert.equal(ok.crossCheck, 'done');
  assert.equal(ok.mismatch, null);
  writeFileSync(join(dir, 'console.log'), `${M}@sf-rescore\n  rescore: n=2 mean-signed-delta=0\n`);
  assert.match(scoreRun(dir).mismatch ?? '', /runner says rescore n=2, scorer counts 4/);
});
