// harness-local — the rater's own noise floor.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/rater-agreement.ts <pass1.jsonl> --pass2 <pass2.jsonl>
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/rater-agreement.ts <pass.jsonl> --key <rater-key.json>
//
// TWO MEASUREMENTS, AND ONLY ONE OF THEM IS A FLOOR.
//
// --pass2 compares two INDEPENDENT rater passes over the same rows. That is the
// real floor: how far the rater moves when nothing about the input changed but
// the invocation. Any between-arm gap smaller than this is not evidence.
//
// --key compares the duplicate pairs inside ONE pass. Those rows are
// byte-identical apart from their row id, so a deterministic rater reproduces
// itself exactly and the agreement is 100% BY CONSTRUCTION, whatever its real
// reliability. Measured here at exactly that: 8 of 8 pairs, 0.00 mean absolute
// difference on every dimension. It is worth running because a result BELOW
// 100% would mean the rater is not deterministic, which is itself a finding,
// but it must never be quoted as a floor. This script refuses to call it one.
//
// Node-only: never imported by the app bundle.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The rubric dimensions, scored numerically. `hardFails` is a set and is
 *  compared for equality rather than distance. */
const DIMENSIONS = ['specificity', 'linkage', 'calibration', 'voice'] as const;
type Dimension = (typeof DIMENSIONS)[number];

interface RaterRow {
  rowId: string;
  hardFails?: string[];
  [k: string]: unknown;
}

function readRater(path: string): Map<string, RaterRow> {
  const out = new Map<string, RaterRow>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as RaterRow;
    if (!row.rowId) throw new Error(`harness-local: a rater row has no rowId in ${path}.`);
    if (out.has(row.rowId)) {
      throw new Error(`harness-local: duplicate rowId ${row.rowId} in ${path}; scores are ambiguous.`);
    }
    out.set(row.rowId, row);
  }
  if (out.size === 0) throw new Error(`harness-local: no rater rows in ${path}.`);
  return out;
}

function score(row: RaterRow, d: Dimension): number | null {
  const v = row[d];
  return typeof v === 'number' ? v : null;
}

interface DimStat {
  dimension: string;
  n: number;
  exact: number;
  meanAbs: number;
  max: number;
  /** Rows where the two sides disagreed, worst first. */
  worst: { rowId: string; a: number; b: number }[];
}

function compare(
  a: Map<string, RaterRow>,
  b: Map<string, RaterRow>,
  pairs: [string, string][],
): { dims: DimStat[]; hardFailExact: number; hardFailDiffs: string[]; skipped: string[] } {
  const dims: DimStat[] = [];
  const skipped: string[] = [];

  for (const d of DIMENSIONS) {
    const diffs: number[] = [];
    const worst: { rowId: string; a: number; b: number }[] = [];
    for (const [idA, idB] of pairs) {
      const sa = score(a.get(idA) as RaterRow, d);
      const sb = score(b.get(idB) as RaterRow, d);
      // A dimension the rater omitted is NOT scored as agreement. Counting a
      // missing field as a match is how a dropped dimension reports a perfect
      // floor.
      if (sa === null || sb === null) {
        skipped.push(`${d}:${idA.slice(0, 8)}`);
        continue;
      }
      const diff = Math.abs(sa - sb);
      diffs.push(diff);
      if (diff > 0) worst.push({ rowId: idA, a: sa, b: sb });
    }
    worst.sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b));
    dims.push({
      dimension: d,
      n: diffs.length,
      exact: diffs.length ? diffs.filter((x) => x === 0).length / diffs.length : 0,
      meanAbs: diffs.length ? diffs.reduce((m, x) => m + x, 0) / diffs.length : 0,
      max: diffs.length ? Math.max(...diffs) : 0,
      worst: worst.slice(0, 5),
    });
  }

  const hardFailDiffs: string[] = [];
  let hfMatch = 0;
  for (const [idA, idB] of pairs) {
    const sa = new Set((a.get(idA) as RaterRow).hardFails ?? []);
    const sb = new Set((b.get(idB) as RaterRow).hardFails ?? []);
    const same = sa.size === sb.size && [...sa].every((x) => sb.has(x));
    if (same) hfMatch += 1;
    else hardFailDiffs.push(`${idA.slice(0, 8)} ${JSON.stringify([...sa])} vs ${JSON.stringify([...sb])}`);
  }

  return { dims, hardFailExact: pairs.length ? hfMatch / pairs.length : 0, hardFailDiffs, skipped };
}

function main(): number {
  const argv = process.argv.slice(2);
  const first = argv.find((a) => !a.startsWith('--'));
  if (!first) throw new Error('harness-local: pass a rater output file.');
  const pass1 = readRater(resolve(first));

  const p2Idx = argv.indexOf('--pass2');
  const keyIdx = argv.indexOf('--key');
  if (p2Idx === -1 && keyIdx === -1) {
    throw new Error('harness-local: pass either --pass2 <file> (the real floor) or --key <rater-key.json>.');
  }

  let pairs: [string, string][];
  let mode: 'pass' | 'duplicate';
  let pass2 = pass1;

  if (p2Idx !== -1) {
    mode = 'pass';
    pass2 = readRater(resolve(argv[p2Idx + 1] ?? ''));
    const common = [...pass1.keys()].filter((id) => pass2.has(id));
    const onlyA = pass1.size - common.length;
    const onlyB = pass2.size - common.length;
    if (onlyA > 0 || onlyB > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `!!  ${onlyA} row(s) only in pass 1 and ${onlyB} only in pass 2 are excluded. ` +
          'The floor below is over the intersection, not over either file.',
      );
    }
    pairs = common.map((id) => [id, id]);
  } else {
    mode = 'duplicate';
    const key = JSON.parse(readFileSync(resolve(argv[keyIdx + 1] ?? ''), 'utf8')) as {
      duplicatesAddedAtExport?: { rowId: string; dupOf: string }[];
      duplicates?: { rowId: string; dupOf: string }[];
    };
    // The key lists export-time duplicates under BOTH `duplicatesAddedAtExport`
    // and `duplicates`, so concatenating them counts every pair twice and
    // reports n=16 for 8 pairs. Deduped on the pair itself.
    const seen = new Set<string>();
    const declared: { rowId: string; dupOf: string }[] = [];
    for (const d of [...(key.duplicatesAddedAtExport ?? []), ...(key.duplicates ?? [])]) {
      const k = `${d.rowId}|${d.dupOf}`;
      if (seen.has(k)) continue;
      seen.add(k);
      declared.push(d);
    }
    pairs = declared
      .filter((p) => pass1.has(p.rowId) && pass1.has(p.dupOf))
      .map((p) => [p.rowId, p.dupOf] as [string, string]);
    const unrated = declared.length - pairs.length;
    if (unrated > 0) {
      // eslint-disable-next-line no-console
      console.warn(`!!  ${unrated} declared duplicate pair(s) are not rated on both sides and are excluded.`);
    }
  }

  if (pairs.length === 0) throw new Error('harness-local: no comparable pairs.');

  const { dims, hardFailExact, hardFailDiffs, skipped } = compare(pass1, pass2, pairs);

  // eslint-disable-next-line no-console
  console.log(
    mode === 'pass'
      ? `RATER NOISE FLOOR: two independent passes over ${pairs.length} shared row(s)`
      : `WITHIN-PASS DUPLICATE AGREEMENT over ${pairs.length} pair(s)`,
  );
  // eslint-disable-next-line no-console
  console.log(`  ${'dimension'.padEnd(14)}${'n'.padStart(5)}${'exact'.padStart(9)}${'mean abs'.padStart(10)}${'max'.padStart(6)}`);
  for (const d of dims) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${d.dimension.padEnd(14)}${String(d.n).padStart(5)}${(d.exact * 100).toFixed(1).padStart(8)}%` +
        `${d.meanAbs.toFixed(2).padStart(10)}${String(d.max).padStart(6)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`  ${'hardFails'.padEnd(14)}${String(pairs.length).padStart(5)}${(hardFailExact * 100).toFixed(1).padStart(8)}%   set equality`);
  if (skipped.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n  ${skipped.length} dimension/row cell(s) were MISSING and excluded rather than counted as agreement:`);
    // eslint-disable-next-line no-console
    console.log(`    ${[...new Set(skipped.map((x) => x.split(':')[0]))].join(', ')}`);
  }
  for (const d of dims.filter((x) => x.worst.length > 0)) {
    // eslint-disable-next-line no-console
    console.log(`\n  biggest ${d.dimension} disagreements:`);
    for (const w of d.worst) {
      // eslint-disable-next-line no-console
      console.log(`    ${w.rowId.slice(0, 8)}  ${w.a} vs ${w.b}`);
    }
  }
  if (hardFailDiffs.length > 0) {
    // eslint-disable-next-line no-console
    console.log('\n  hardFails disagreements:');
    for (const h of hardFailDiffs) console.log(`    ${h}`);
  }

  const worstDim = dims.reduce((m, d) => (d.meanAbs > m.meanAbs ? d : m), dims[0]);
  // eslint-disable-next-line no-console
  console.log(
    mode === 'pass'
      ? `\nREADING RULE\n  Worst dimension: ${worstDim.dimension}, mean absolute difference ` +
          `${worstDim.meanAbs.toFixed(2)}, exact ${(worstDim.exact * 100).toFixed(0)}%.\n` +
          '  A between-arm gap smaller than that is not evidence. This IS the floor.'
      : '\nNOT A FLOOR\n' +
          '  These rows are byte-identical apart from their row id, so a deterministic rater\n' +
          '  reproduces itself exactly and 100% here is guaranteed by construction, whatever the\n' +
          "  rater's real reliability. Below 100% would mean the rater is NOT deterministic, which\n" +
          '  is a finding. Use --pass2 against a second independent pass for the actual floor.',
  );
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}
