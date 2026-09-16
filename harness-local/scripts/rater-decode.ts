// harness-local - decode a blinded rater batch back to its arms and pivot it.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/rater-decode.ts <ratings.jsonl> --run <runDir> \
//       [--dims specificity,novelty,useful] [--hard-fail a]
//
// The rater sees arm-A..arm-D and never learns what they are. This joins its
// output back through the export and the key: ratings -> rater-rows.jsonl (for
// the arm label and the call type, which is NOT blinded) -> rater-key.json (for
// the run, arm and variant behind each label).
//
// IT PIVOTS BY CALL TYPE, ALWAYS. A per-arm mean is confounded whenever the
// arms differ in their mix of call types, and they do: at total 4 the combo
// call has a CEILING of 1 topic, so an arm carrying more combo rows scores
// worse on anything that scales with topic count, for a reason that has nothing
// to do with the prompt. Reading a per-arm mean without this split is how a
// ceiling gets mistaken for a quality difference.
//
// Duplicated rows are EXCLUDED from every mean and reported separately as the
// rater's agreement with itself. Averaging one row twice adds no information,
// it only makes n look bigger.
//
// Node-only: never imported by the app bundle.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Rating { rowId: string; hardFails?: string[]; note?: string; [k: string]: unknown }
interface ExportRow { rowId: string; arm: string; callType: string }
interface KeyFile {
  labels: Record<string, { run: string; arm: string; variant: string | null }>;
  duplicatesAddedAtExport?: { rowId: string; dupOf: string }[];
  duplicates?: { rowId: string; dupOf: string }[];
}

const SEP = ' | ';

function readJsonlAs<T>(path: string): T[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function fmt(x: number): string {
  return Number.isNaN(x) ? '-' : x.toFixed(2);
}

function main(): number {
  const argv = process.argv.slice(2);
  const ratingsPath = argv.find((a) => !a.startsWith('--'));
  if (!ratingsPath) throw new Error('harness-local: pass the rater output file.');
  const runIdx = argv.indexOf('--run');
  if (runIdx === -1) throw new Error('harness-local: --run <runDir> is required; it holds the export and the key.');
  const runDir = resolve(argv[runIdx + 1] ?? '');
  const dimsIdx = argv.indexOf('--dims');
  const hfIdx = argv.indexOf('--hard-fail');
  const hardFailCode = hfIdx === -1 ? 'a' : (argv[hfIdx + 1] ?? 'a');

  const ratings = new Map(readJsonlAs<Rating>(resolve(ratingsPath)).map((r) => [r.rowId, r]));
  const exported = new Map(readJsonlAs<ExportRow>(join(runDir, 'rater-rows.jsonl')).map((r) => [r.rowId, r]));
  const key = JSON.parse(readFileSync(join(runDir, 'rater-key.json'), 'utf8')) as KeyFile;

  const dupPairs = new Map<string, string>();
  for (const d of [...(key.duplicatesAddedAtExport ?? []), ...(key.duplicates ?? [])]) {
    dupPairs.set(d.rowId, d.dupOf);
  }

  const sample = [...ratings.values()][0];
  const dims = dimsIdx !== -1
    ? (argv[dimsIdx + 1] ?? '').split(',').filter(Boolean)
    : Object.keys(sample).filter((k) => typeof sample[k] === 'number');

  const unjoined = [...ratings.keys()].filter((id) => !exported.has(id));
  if (unjoined.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`!!  ${unjoined.length} rated row(s) are not in the export and are excluded.`);
  }

  interface Cell { run: string; arm: string; callType: string; rows: Rating[] }
  const cells = new Map<string, Cell>();
  const flagged: { rowId: string; run: string; arm: string; callType: string; note: string }[] = [];

  for (const [rowId, rating] of ratings) {
    const ex = exported.get(rowId);
    if (!ex) continue;
    const decoded = key.labels[ex.arm];
    if (!decoded) throw new Error(`harness-local: no key entry for label ${ex.arm}.`);
    const runShort = decoded.run.replace(/^[0-9]+-topicgen-/, '').replace(/^[0-9]+-/, '');
    if ((rating.hardFails ?? []).includes(hardFailCode)) {
      flagged.push({ rowId, run: runShort, arm: decoded.arm, callType: ex.callType, note: String(rating.note ?? '') });
    }
    if (dupPairs.has(rowId)) continue;
    const k = [runShort, decoded.arm, ex.callType].join(SEP);
    const cell = cells.get(k) ?? { run: runShort, arm: decoded.arm, callType: ex.callType, rows: [] };
    cell.rows.push(rating);
    cells.set(k, cell);
  }

  const printTable = (title: string, group: (c: Cell) => string, filter: (c: Cell) => boolean): void => {
    const buckets = new Map<string, Rating[]>();
    for (const c of cells.values()) {
      if (!filter(c)) continue;
      const g = group(c);
      buckets.set(g, [...(buckets.get(g) ?? []), ...c.rows]);
    }
    // eslint-disable-next-line no-console
    console.log(`\n${title}`);
    // eslint-disable-next-line no-console
    console.log(`  ${'cell'.padEnd(62)}${'n'.padStart(4)}${dims.map((d) => d.slice(0, 11).padStart(13)).join('')}${`hf-${hardFailCode}`.padStart(8)}`);
    for (const [g, rows] of [...buckets.entries()].sort()) {
      const hf = rows.filter((r) => (r.hardFails ?? []).includes(hardFailCode)).length;
      // eslint-disable-next-line no-console
      console.log(
        `  ${g.padEnd(62).slice(0, 62)}${String(rows.length).padStart(4)}` +
          dims.map((d) => fmt(mean(rows.map((r) => r[d] as number).filter((x) => typeof x === 'number'))).padStart(13)).join('') +
          String(hf).padStart(8),
      );
    }
  };

  printTable('BY RUN x ARM x CALL TYPE (duplicates excluded from every mean)',
    (c) => [c.run, c.arm, c.callType].join(SEP), () => true);
  printTable('COLLAPSED TO factOnly ONLY (the comparable subset)',
    (c) => [c.run, c.arm].join(SEP), (c) => c.callType === 'topicgen-factOnly');
  printTable('COLLAPSED TO combo ONLY',
    (c) => [c.run, c.arm].join(SEP), (c) => c.callType === 'topicgen-combo');

  // eslint-disable-next-line no-console
  console.log(`\nHARD FAIL (${hardFailCode}) ROWS, ${flagged.length} of ${ratings.size} rated`);
  for (const f of flagged.sort((a, b) => a.run.localeCompare(b.run) || a.arm.localeCompare(b.arm))) {
    // eslint-disable-next-line no-console
    console.log(`  ${f.rowId.slice(0, 8)}  ${[f.run, f.arm, f.callType].join(SEP)}${f.note ? `  "${f.note}"` : ''}`);
  }

  const pairs = [...dupPairs.entries()].filter(([x, y]) => ratings.has(x) && ratings.has(y));
  if (pairs.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\nWITHIN-BATCH DUPLICATE AGREEMENT over ${pairs.length} pair(s)`);
    for (const d of dims) {
      const diffs = pairs.map(([x, y]) => Math.abs((ratings.get(x)?.[d] as number) - (ratings.get(y)?.[d] as number)));
      // eslint-disable-next-line no-console
      console.log(`  ${d.padEnd(14)} exact ${((diffs.filter((v) => v === 0).length / diffs.length) * 100).toFixed(1)}%  mean abs ${fmt(mean(diffs))}  max ${Math.max(...diffs)}`);
    }
    // eslint-disable-next-line no-console
    console.log('  Byte-identical rows, so a deterministic rater scores 100% here by construction.');
  }
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}
