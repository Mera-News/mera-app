// harness-local — follow-story option quality over a run-singleshot-corpus run. No calls.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/score-option-quality.ts <runDir> [<runDir> ...]
//
// Every turn whose fixture expects proposeTrack is scored by lib/option-quality.ts
// against its source: the fixture article's title and description, or for a
// follow-story turn the user's own message. A turn that staged no options fails
// the count and entity checks. Prints the pass rate and per-check counts per arm.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { OPTION_CHECKS, scoreOptions, summarise, type OptionSummary } from '../lib/option-quality';

const FIXTURES = join(__dirname, '../../lib/mera-harness/eval/fixtures/singleshot/turns.json');
/** run-singleshot-corpus's fixed clock. */
const TODAY = '2026-10-14';

interface Fixture {
  id: string;
  message: string;
  expect: string;
  article?: { title: string; description: string };
}

interface Row {
  fixture: string;
  arm: string;
  expect: string;
  error: string | null;
  options?: { label: string; search: string }[];
  rawOptionCount?: number;
}

export function optionQuality(runDir: string): Record<string, OptionSummary> {
  const fixtures = new Map((JSON.parse(readFileSync(FIXTURES, 'utf8')) as Fixture[]).map((f) => [f.id, f]));
  const rows = readFileSync(join(resolve(runDir), 'rows.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => r.expect === 'proposeTrack' && !r.error);
  const byArm = new Map<string, ReturnType<typeof scoreOptions>[]>();
  for (const r of rows) {
    const f = fixtures.get(r.fixture);
    if (!f) continue;
    const source = f.article ? `${f.article.title} ${f.article.description}` : f.message;
    const options = r.options ?? [];
    const verdict = scoreOptions({ source, options, rawCount: Math.max(r.rawOptionCount ?? 0, options.length), today: TODAY });
    byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), verdict]);
  }
  return Object.fromEntries([...byArm].map(([arm, v]) => [arm, summarise(v)]));
}

function main(): number {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (dirs.length === 0) throw new Error('harness-local: pass one or more run directories.');
  for (const dir of dirs) {
    console.log(`\n${dir}`);
    for (const [arm, s] of Object.entries(optionQuality(dir))) {
      const checks = OPTION_CHECKS.map((c) => `${c} ${s.byCheck[c]}`).join(', ');
      console.log(`  ${arm.padEnd(18)} option quality ${s.passed}/${s.turns} (${((s.passed / Math.max(1, s.turns)) * 100).toFixed(0)}%)  fails: ${checks}`);
    }
  }
  return 0;
}

if (/score-option-quality\.ts$/.test(process.argv[1] ?? '')) process.exit(main());
