// harness-local — blind export of a run for the rater.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/rater-export.ts <runDir> [--seed 12345]
//
// WHAT BLIND MEANS HERE, and why each choice was made:
//  - arm, modelRequested and modelSent are replaced by opaque labels (arm-A,
//    arm-B, ...). A rater that can see which model produced a row is not
//    measuring the row.
//  - variant is HIDDEN for the same reason: it names the experiment arm.
//  - cohort stays VISIBLE. The rater is told which cohort it is judging on
//    purpose, because the adversarial hard fails are only judgeable against the
//    cohort's intent: refusing a request is a PASS there and would look like a
//    failure anywhere else.
//  - dupOf is stripped, so duplicated rows are indistinguishable from the rest
//    and intra-rater agreement can be scored afterwards from the key.
//  - rows are shuffled with a RECORDED seed, so the order carries no signal and
//    the shuffle is reproducible.
//
// The key file is written SEPARATELY and must not be given to the rater. It is
// what turns the blind scores back into a per-arm result.
//
// Node-only: never imported by the app bundle.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readJsonl } from '../lib/agreement';
import type { RunRow } from '../lib/jsonl-writer';

/** Deterministic PRNG, so a given seed always yields the same order. Math.random
 *  could not be reproduced, and an unreproducible shuffle makes a disputed
 *  rating impossible to re-examine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function main(): number {
  const argv = process.argv.slice(2);
  const runDir = argv.find((a) => !a.startsWith('--'));
  if (!runDir) throw new Error('harness-local: pass a run directory.');
  const seedIdx = argv.indexOf('--seed');
  const seed = seedIdx === -1 ? Date.now() % 2147483647 : Number(argv[seedIdx + 1]);
  if (!Number.isFinite(seed)) throw new Error('harness-local: --seed must be a number.');

  const dir = resolve(runDir);
  const rows = readJsonl(join(dir, 'rows.jsonl'));
  if (rows.length === 0) throw new Error(`harness-local: no rows in ${dir}.`);

  // Stable label assignment: arms sorted, so the same run always relabels the
  // same way for a given seed and two exports can be compared.
  const arms = [...new Set(rows.map((r) => r.arm))].sort();
  const label = new Map(arms.map((a, i) => [a, `arm-${String.fromCharCode(65 + i)}`]));

  const blind = shuffle(rows, mulberry32(seed)).map((r) => {
    const out: Record<string, unknown> = { ...r };
    out.arm = label.get(r.arm);
    out.modelRequested = label.get(r.arm);
    out.modelSent = r.modelSent === null ? null : label.get(r.arm);
    delete out.dupOf;
    delete out.variant;
    // interleaveGroup is a SCHEDULING key, not judgeable content, and the
    // topic-gen runner encodes the count arm in it ("10:0:combo"), so leaving
    // it in hands the rater the arm by the back door.
    delete out.interleaveGroup;
    return out;
  });

  // THE GUARD. Blinding by deleting named fields is only as good as the list of
  // names, and that list goes stale the moment a runner adds a field. So the
  // export refuses to write if ANY arm string survives anywhere in the
  // serialized rows, whatever field it hid in. This caught the count arm twice:
  // once inside `cohort`, once inside `interleaveGroup`.
  const serialized = JSON.stringify(blind);
  const leaked = arms.filter((a) => serialized.includes(a));
  if (leaked.length > 0) {
    throw new Error(
      `harness-local: refusing to write a rater export that still names its arms: ${leaked.join(', ')}. ` +
        'Some field carries the arm through. Find it rather than adding another delete, ' +
        'and consider whether the runner should be putting it there at all.',
    );
  }

  const blindPath = join(dir, 'rater-rows.jsonl');
  writeFileSync(blindPath, `${blind.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

  const keyPath = join(dir, 'rater-key.json');
  writeFileSync(
    keyPath,
    `${JSON.stringify(
      {
        _warning: 'DO NOT give this file to the rater. It is what de-blinds the export.',
        seed,
        rows: rows.length,
        labels: Object.fromEntries([...label.entries()].map(([arm, l]) => [l, arm])),
        duplicates: rows.filter((r) => r.dupOf !== null).map((r) => ({ rowId: r.rowId, dupOf: r.dupOf })),
        variantByRowId: Object.fromEntries(rows.map((r) => [r.rowId, r.variant])),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const dupCount = rows.filter((r) => r.dupOf !== null).length;
  // eslint-disable-next-line no-console
  console.log(
    `rows       : ${rows.length} (${dupCount} duplicate(s), indistinguishable in the export)\n` +
      `arms       : ${arms.length} relabelled ${[...label.values()].join(', ')}\n` +
      `seed       : ${seed}\n` +
      `cohort     : VISIBLE (the rater is told which cohort it judges)\n` +
      `variant    : hidden\n` +
      `rater file : ${blindPath}\n` +
      `key file   : ${keyPath}  <- do NOT hand this to the rater`,
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
