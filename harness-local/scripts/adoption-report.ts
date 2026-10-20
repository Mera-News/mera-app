// harness-local — the D34 adoption table: a candidate on-device engine against a
// baseline one, on the same on-device sets. No calls.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/adoption-report.ts \
//     --candidate <runDir>,<runDir>,... --baseline <runDir>,<runDir>,...
//
// Each side takes its run dirs in any order; the kind is read off the dir:
//   singleshot    run-singleshot-corpus --engine   follow-story option quality + turn pass
//   persona-chat  replay-persona-chat --engine     fact-save accuracy
//   topicgen      run-topicgen-corpus --engine     G1, G1b, G3 (score-topic-run)
//   notes         run-newsharness-corpus --engine  note count; preference needs the blind rater
//
// THE RULE (D34, fixed before prompt iteration): the candidate (AFM) must be >= the
// baseline (Qwen local) on every row, lower being better for G1, G1b and G3, and lose
// nothing on blind notes preference. Until then it is selectable but not the default.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { optionQuality } from './score-option-quality';
import { topicGates } from './score-topic-run';

type Kind = 'singleshot' | 'persona-chat' | 'topicgen' | 'notes';

function lines(dir: string): Record<string, unknown>[] {
  const p = join(dir, 'rows.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function kindOf(dir: string): Kind {
  const first = lines(dir)[0] ?? {};
  if ('fixture' in first && 'expect' in first) return 'singleshot';
  if ('fixture' in first && 'calls' in first) return 'persona-chat';
  if (first.surface === 'TOPICGEN') return 'topicgen';
  if (first.callType === 'reason') return 'notes';
  throw new Error(`harness-local: cannot tell what kind of run ${dir} is.`);
}

interface Side {
  optionQuality?: number;
  turnPass?: number;
  factSave?: number;
  g1?: number;
  g1b?: number;
  g3?: number;
  notes?: number;
  engine?: string;
}

const rate = (pass: number, n: number) => (n === 0 ? NaN : pass / n);

function measure(dirs: string[]): Side {
  const side: Side = {};
  for (const raw of dirs) {
    const dir = resolve(raw);
    const kind = kindOf(dir);
    const rows = lines(dir);
    if (kind === 'singleshot') {
      const oq = Object.values(optionQuality(dir));
      side.optionQuality = rate(oq.reduce((a, s) => a + s.passed, 0), oq.reduce((a, s) => a + s.turns, 0));
      const valid = rows.filter((r) => !r.error);
      side.turnPass = rate(valid.filter((r) => r.pass).length, valid.length);
      side.engine ??= String(rows[0]?.arm ?? '').replace(/-twin$/, '');
    } else if (kind === 'persona-chat') {
      const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as { pass: number; n: number; engine: string };
      side.factSave = rate(s.pass, s.n);
      side.engine ??= s.engine;
    } else if (kind === 'topicgen') {
      const g = Object.values(topicGates(dir))[0];
      side.g1 = g?.g1;
      side.g1b = g?.g1b;
      side.g3 = g?.g3;
    } else {
      side.notes = rows.filter((r) => typeof (r.parsedSchema as { reason?: string } | null)?.reason === 'string' && (r.parsedSchema as { reason: string }).reason.length > 0).length;
    }
  }
  return side;
}

function main(): number {
  const argv = process.argv.slice(2);
  const list = (flag: string) => (argv[argv.indexOf(flag) + 1] ?? '').split(',').filter(Boolean);
  if (!argv.includes('--candidate') || !argv.includes('--baseline')) {
    throw new Error('harness-local: pass --candidate <runDir,...> and --baseline <runDir,...>.');
  }
  const c = measure(list('--candidate'));
  const b = measure(list('--baseline'));
  const pctOf = (x?: number) => (x === undefined || Number.isNaN(x) ? '   n/a' : `${(x * 100).toFixed(1).padStart(5)}%`);
  const rowsOut: [string, number | undefined, number | undefined, 'higher' | 'lower'][] = [
    ['follow-story option quality', c.optionQuality, b.optionQuality, 'higher'],
    ['single-shot turn pass', c.turnPass, b.turnPass, 'higher'],
    ['persona fact-save accuracy', c.factSave, b.factSave, 'higher'],
    ['topic-gen G1 empty content', c.g1, b.g1, 'lower'],
    ['topic-gen G1b no usable set', c.g1b, b.g1b, 'lower'],
    ['topic-gen G3 S7 post-filter', c.g3, b.g3, 'lower'],
  ];
  console.log(`D34 ADOPTION RULE  candidate ${c.engine ?? '?'}  vs  baseline ${b.engine ?? '?'}\n`);
  console.log(`  ${'metric'.padEnd(30)} candidate  baseline  holds`);
  let missing = 0;
  let lost = 0;
  for (const [name, cv, bv, better] of rowsOut) {
    const known = cv !== undefined && bv !== undefined && !Number.isNaN(cv) && !Number.isNaN(bv);
    const holds = known ? (better === 'higher' ? cv >= bv : cv <= bv) : null;
    if (holds === null) missing++;
    else if (!holds) lost++;
    console.log(`  ${name.padEnd(30)} ${pctOf(cv)}    ${pctOf(bv)}   ${holds === null ? 'NO DATA' : holds ? 'yes' : 'NO'}`);
  }
  console.log(`  ${'notes for blind rating'.padEnd(30)} ${String(c.notes ?? 'n/a').padStart(6)}    ${String(b.notes ?? 'n/a').padStart(6)}   PENDING RATER`);
  console.log(
    '\n  Notes preference: rater-export.ts <candidate notes dir> --merge <baseline notes dir> --call-type reason --repeat 0.\n' +
      '  Keep the default (run, arm) labels: both engines carry variant ondevice-notes, so --label-by variant merges them.',
  );
  const verdict = missing > 0 ? 'INCOMPLETE' : lost > 0 ? 'NOT MET: the candidate stays selectable, not default' : 'MET on every measured row; adopt only if the blind notes rating shows no loss';
  console.log(`\nVERDICT: ${verdict}`);
  return 0;
}

if (/adoption-report\.ts$/.test(process.argv[1] ?? '')) process.exit(main());
