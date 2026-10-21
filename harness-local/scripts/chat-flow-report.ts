// harness-local — one table over several run-chat-flows runs. No calls.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/chat-flow-report.ts <runDir> [<runDir> ...]
//
// Rows from every dir are pooled per flow x arm x split (lib/chat-flow-score.ts),
// so repeats split across runs add up.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { summariseRows, summaryTable, type FlowRow } from '../lib/chat-flow-score';

function main(): number {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (dirs.length === 0) throw new Error('harness-local: pass one or more run-chat-flows directories.');
  const rows = dirs.flatMap((d) =>
    readFileSync(join(resolve(d), 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FlowRow),
  );
  console.log(summaryTable(summariseRows(rows)));
  return 0;
}

if (/chat-flow-report\.ts$/.test(process.argv[1] ?? '')) process.exit(main());
