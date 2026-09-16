// harness-local — blind export of a run for the rater.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/rater-export.ts <runDir> \
//       [--merge <runDir2>] [--seed 12345] [--repeat 0] [--call-type reason]
//       [--duplicate 8] [--sample 80] [--include <rowId>,<rowId>]
//
// --repeat selects ONE repeat, which is what a floor run wants: the repeats are
// there to measure the noise floor, and asking a rater to judge the same prompt
// three times spends its budget on a number the runner already computed.
// Duplicate rows are ALWAYS kept regardless of which repeat they copy, because
// they are what intra-rater agreement is measured from. --include force-keeps
// specific row ids that must be in the batch deliberately.
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
// --merge pulls a second run into ONE batch, which is how two prompt variants
// get judged against each other rather than in two sittings the rater cannot
// compare. The opaque label is assigned per (run, arm) pair, NOT per arm: two
// runs of the same model under different prompt variants would otherwise
// collapse into one label and the comparison would vanish. The key maps each
// label back to its run and variant.
//
// --sample N keeps N rows PER ARM, drawn with the recorded seed and balanced,
// so a batch stays inside one rater invocation. That matters more than the
// extra rows would: the whole design rests on judging both arms in ONE
// invocation so the pass-to-pass drift cancels, and splitting a batch to fit
// re-exposes it. Forced ids are kept regardless of the sample.
//
// The key file is written SEPARATELY and must not be given to the rater. It is
// what turns the blind scores back into a per-arm result.
//
// Node-only: never imported by the app bundle.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readJsonl } from '../lib/agreement';
import { newRowId, type RunRow } from '../lib/jsonl-writer';

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
  // Every --merge occurrence adds a run. The first positional stays the primary,
  // and the export is written into it.
  const mergeDirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--merge') {
      const d = argv[i + 1];
      if (!d || d.startsWith('--')) throw new Error('harness-local: --merge needs a run directory.');
      mergeDirs.push(resolve(d));
    }
  }

  const sources = [dir, ...mergeDirs];
  const runOf = new Map<string, string>();
  const all: RunRow[] = [];
  for (const src of sources) {
    const part = readJsonl(join(src, 'rows.jsonl'));
    if (part.length === 0) throw new Error(`harness-local: no rows in ${src}.`);
    const name = src.split('/').filter(Boolean).pop() ?? src;
    for (const r of part) {
      if (runOf.has(r.rowId)) {
        throw new Error(
          `harness-local: row id ${r.rowId} appears in two runs. Refusing to merge, since a ` +
            'duplicate id makes the rater scores unattributable.',
        );
      }
      runOf.set(r.rowId, name);
      all.push(r);
    }
  }
  if (all.length === 0) throw new Error(`harness-local: no rows in ${dir}.`);

  const repeatIdx = argv.indexOf('--repeat');
  const repeat = repeatIdx === -1 ? null : Number(argv[repeatIdx + 1]);
  if (repeatIdx !== -1 && !Number.isFinite(repeat)) {
    throw new Error('harness-local: --repeat must be a number.');
  }
  const includeIdx = argv.indexOf('--include');
  const forced = new Set(
    includeIdx === -1 ? [] : (argv[includeIdx + 1] ?? '').split(',').map((x) => x.trim()).filter(Boolean),
  );

  const callTypeIdx = argv.indexOf('--call-type');
  const callType = callTypeIdx === -1 ? null : argv[callTypeIdx + 1];
  const dupIdx = argv.indexOf('--duplicate');
  const addDuplicates = dupIdx === -1 ? 0 : Number(argv[dupIdx + 1]);
  if (dupIdx !== -1 && (!Number.isFinite(addDuplicates) || addDuplicates < 0)) {
    throw new Error('harness-local: --duplicate must be a non-negative number.');
  }

  let rows =
    repeat === null
      ? all
      : all.filter((r) => r.repeat === repeat || r.dupOf !== null || forced.has(r.rowId));
  if (callType) {
    const before = rows.length;
    rows = rows.filter((r) => r.callType === callType || forced.has(r.rowId));
    if (rows.length === 0) {
      throw new Error(
        `harness-local: --call-type ${callType} selected no rows from ${before}. ` +
          `Present: ${[...new Set(all.map((r) => r.callType))].join(', ')}.`,
      );
    }
  }

  // A forced id that is not in the run is a silent hole in a batch someone
  // deliberately composed, so it fails instead.
  const missing = [...forced].filter((id) => !rows.some((r) => r.rowId === id));
  if (missing.length > 0) {
    throw new Error(
      `harness-local: --include named ${missing.length} row id(s) not present in this run: ${missing.join(', ')}.`,
    );
  }
  if (rows.length === 0) {
    throw new Error(`harness-local: --repeat ${repeat} selected no rows.`);
  }

  // JUDGEABILITY. The rubric's specificity and fact-linkage dimensions are
  // unjudgeable without the article text and the facts the model saw, and every
  // one of those lives in the materialised user message. A row that lost it
  // would be scored on nothing, so the export refuses rather than shipping a
  // batch that quietly cannot be rated.
  const blank = rows.filter(
    (r) => !r.input?.messages?.some((m) => typeof m.content === 'string' && m.content.trim().length > 0),
  );
  if (blank.length > 0) {
    throw new Error(
      `harness-local: ${blank.length} selected row(s) carry no materialised input, so nothing about them ` +
        'is judgeable. First: ' + blank[0].rowId,
    );
  }

  // Per-arm sampling, before duplication so the duplicates are drawn from what
  // the rater will actually see.
  const sampleIdx = argv.indexOf('--sample');
  const sampleN = sampleIdx === -1 ? 0 : Number(argv[sampleIdx + 1]);
  if (sampleIdx !== -1 && (!Number.isFinite(sampleN) || sampleN <= 0)) {
    throw new Error('harness-local: --sample must be a positive number.');
  }
  let sampledOut = 0;
  if (sampleN > 0) {
    const sampleRng = mulberry32(seed ^ 0x2f9a1c07);
    const byArm = new Map<string, RunRow[]>();
    for (const r of rows) byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), r]);
    const kept: RunRow[] = [];
    for (const [arm, list] of [...byArm.entries()].sort()) {
      const forcedHere = list.filter((r) => forced.has(r.rowId));
      const rest = shuffle(list.filter((r) => !forced.has(r.rowId)), sampleRng);
      const room = Math.max(0, sampleN - forcedHere.length);
      const take = [...forcedHere, ...rest.slice(0, room)];
      if (list.length < sampleN) {
        // eslint-disable-next-line no-console
        console.warn(`!!  arm ${arm} has only ${list.length} row(s), fewer than --sample ${sampleN}.`);
      }
      sampledOut += list.length - take.length;
      kept.push(...take);
    }
    rows = kept;
  }

  // Export-time duplication, drawn with the SAME seeded PRNG so a given seed
  // reproduces the whole batch, duplicates included.
  const dupRng = mulberry32(seed ^ 0x5bf03635);
  const addedDuplicates: { rowId: string; dupOf: string }[] = [];
  if (addDuplicates > 0) {
    const pool = rows.filter((r) => r.dupOf === null);
    const picked = shuffle(pool, dupRng).slice(0, Math.min(addDuplicates, pool.length));
    if (picked.length < addDuplicates) {
      // eslint-disable-next-line no-console
      console.warn(
        `harness-local: asked for ${addDuplicates} duplicates but only ${pool.length} unique row(s) exist.`,
      );
    }
    for (const src of picked) {
      const copy = { ...src, rowId: newRowId(), dupOf: src.rowId };
      // The copy needs its source's run registered against its NEW id, or
      // armKey resolves to "undefined::<arm>" and every duplicate lands in a
      // phantom arm of its own. That would both break the pairing and hand the
      // rater a way to spot the duplicates, which is the one thing they must
      // not be able to do.
      const srcRun = runOf.get(src.rowId);
      if (srcRun === undefined) {
        throw new Error(`harness-local: no source run for row ${src.rowId}.`);
      }
      runOf.set(copy.rowId, srcRun);
      addedDuplicates.push({ rowId: copy.rowId, dupOf: src.rowId });
      rows.push(copy);
    }
  }

  // Label per (run, arm), sorted, so the same inputs always relabel the same way
  // and two runs of the SAME model under different prompt variants stay distinct.
  const armKey = (r: RunRow): string => `${runOf.get(r.rowId)}::${r.arm}`;
  const arms = [...new Set(rows.map(armKey))].sort();
  const label = new Map(arms.map((a, i) => [a, `arm-${String.fromCharCode(65 + i)}`]));
  // Raw strings the guard must never find in the export: both the composite
  // keys and the bare arm ids they are built from.
  const secrets = [...new Set([...arms, ...rows.map((r) => r.arm)])];

  const blind = shuffle(rows, mulberry32(seed)).map((r) => {
    const out: Record<string, unknown> = { ...r };
    const lbl = label.get(armKey(r));
    out.arm = lbl;
    out.modelRequested = lbl;
    out.modelSent = r.modelSent === null ? null : lbl;
    // runId names the source run, and with --merge that IS the variant.
    out.runId = lbl;
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
  // Matched on the FULL arm id, not a vendor substring: the goldset contains a
  // real article about Alibaba unveiling a Qwen model, and treating that as a
  // leak would refuse every honest export.
  const leaked = secrets.filter((a) => serialized.includes(a));
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
        selectedRepeat: repeat,
        selectedCallType: callType,
        forcedRowIds: [...forced],
        samplePerArm: sampleN > 0 ? sampleN : null,
        duplicatesAddedAtExport: addedDuplicates,
        sources,
        labels: Object.fromEntries(
          [...label.entries()].map(([key, l]) => {
            const [runName, arm] = key.split('::');
            const sample = rows.find((r) => armKey(r) === key);
            return [l, { run: runName, arm, variant: sample?.variant ?? null }];
          }),
        ),
        duplicates: rows.filter((r) => r.dupOf !== null).map((r) => ({ rowId: r.rowId, dupOf: r.dupOf })),
        variantByRowId: Object.fromEntries(rows.map((r) => [r.rowId, r.variant])),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const dupCount = rows.filter((r) => r.dupOf !== null).length;
  const uniqueCount = rows.length - dupCount;
  // eslint-disable-next-line no-console
  console.log(
    `sources    : ${sources.length} run(s): ${sources.map((x) => x.split('/').pop()).join(', ')}\n` +
      `rows       : ${rows.length} of ${all.length} across the run(s)` +
      `${repeat === null ? '' : ` (repeat ${repeat} only)`}\n` +
      `unique     : ${uniqueCount}\n` +
      `duplicates : ${dupCount}, indistinguishable in the export\n` +
      `call type  : ${callType ?? 'all'}\n` +
      `forced in  : ${forced.size}\n` +
      `${sampleN > 0 ? `sampled    : ${sampleN} per arm, ${sampledOut} row(s) dropped\n` : ''}` +
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
