// The arms of a run must build different leg-0 prompts (twins excepted), and the runner checks
// that BEFORE the first call, on a dry run too. Node's runner: harness-local has no jest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leg0Collisions } from '../lib/arm-distinctness';
test('two arms with one leg-0 prompt that are not twins fail', () => {
  // forced-offer-ungrounded changes the loop only, so its leg 0 is baseline's.
  assert.deepEqual(leg0Collisions(['baseline', 'forced-offer-ungrounded']).failures, ['baseline == forced-offer-ungrounded']);
});

function dryRun(variants: string): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'arm-distinct-'));
  copyFileSync(join(__dirname, '../../lib/mera-harness/eval/fixtures/scripts/good.json'), join(dir, 'good.json'));
  const r = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      join(__dirname, 'run-agent-corpus.ts'),
      '--target', 'staging',
      '--graphql-endpoint', 'https://graphql.staging.mera.news/graphql',
      '--auth-endpoint', 'https://auth.staging.mera.news',
      '--inference-endpoint', 'https://inference.staging.mera.news',
      '--variant', variants, '--repeat', '1', '--dry-run', '--scripts', dir, '--label', 'arm-distinct-test',
    ],
    { encoding: 'utf8', input: '' },
  );
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('a dry run with two identical arms exits non-zero before any call', () => {
  const { status, out } = dryRun('baseline,forced-offer-ungrounded');
  assert.equal(status, 1);
  assert.match(out, /RUNNER BUG: two arms build the SAME leg-0 router prompt/);
  assert.match(out, /Nothing was sent/);
});
