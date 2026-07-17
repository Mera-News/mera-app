#!/usr/bin/env node
// Evaluate a harness run's scores.json against golden-labels.json.
//
// Tier contract (the product spec being tuned toward):
//   FEED       raw >= 0.40  (direct/indirect impact -> For You page)
//   TANGENTIAL 0.25 <= raw < 0.40  (interest-adjacent -> future Discover surface)
//   EXCLUDE    raw < 0.25   (unrelated -> never shown)
//
// Usage: node eval-golden.js <runDir> [--engine=math|backstop] [--verbose]
//
//   (no --engine)      legacy: score the run's recorded scores.json (unchanged).
//   --engine=backstop  score the run's scores.json (today's LLM path) AND report
//                      the wrong-location leak counter (geo resolved on-device).
//   --engine=math      re-score via the deterministic engine (persona-v3.json +
//                      golden-tags.json, fake judge = ok) and report tiers + the
//                      wrong-location leak counter + top scoring disagreements.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const runDir = process.argv[2];
if (!runDir || runDir.startsWith('--')) {
  console.error('usage: node eval-golden.js <runDir> [--engine=math|backstop] [--verbose]');
  process.exit(1);
}
const verbose = process.argv.includes('--verbose');
const engineArg = process.argv.find((a) => a.startsWith('--engine'));
let engine = null;
if (engineArg) {
  engine = engineArg.includes('=')
    ? engineArg.split('=')[1]
    : process.argv[process.argv.indexOf(engineArg) + 1];
  if (engine !== 'math' && engine !== 'backstop') {
    console.error(`bad --engine "${engine}" (expected math|backstop)`);
    process.exit(1);
  }
}

// scores: either the run's recorded scores.json (legacy) or the engine-aware
// eval-scores-<engine>.json produced by build-eval-scores.ts (carries per-row
// rawScore + wrongLocation + optional component breakdown).
let scores;
if (engine) {
  execFileSync(
    'npx',
    ['tsx', '--tsconfig', 'harness-local/tsconfig.json', 'eval/lib/build-eval-scores.ts', runDir, engine],
    { stdio: ['ignore', 'inherit', 'inherit'], cwd: path.join(__dirname, '..') },
  );
  scores = JSON.parse(fs.readFileSync(path.join(runDir, `eval-scores-${engine}.json`), 'utf8'));
} else {
  scores = JSON.parse(fs.readFileSync(path.join(runDir, 'scores.json'), 'utf8'));
}
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden-labels.json'), 'utf8'));
const goldenMap = new Map(golden.map((g) => [g.id, g.tier]));

const FEED_MIN = 0.4;
const TANGENTIAL_MIN = 0.25;

const predictTier = (raw) =>
  raw >= FEED_MIN ? 'FEED' : raw >= TANGENTIAL_MIN ? 'TANGENTIAL' : 'EXCLUDE';

const TIERS = ['FEED', 'TANGENTIAL', 'EXCLUDE'];
const matrix = {}; // matrix[golden][predicted]
for (const g of TIERS) { matrix[g] = { FEED: 0, TANGENTIAL: 0, EXCLUDE: 0 }; }

const offenders = { feedButExclude: [], excludeButFeed: [], feedButTangential: [], tangentialButFeed: [] };
const disagreements = []; // predicted !== golden, for tuning
let judged = 0, unknown = 0, missing = 0;
let feedWrongLocLeak = 0;   // FEED-predicted whose geo resolves to a sibling city
let wrongLocTotal = 0;      // rows flagged wrong-location at any tier

for (const row of scores) {
  const g = goldenMap.get(row.id);
  if (!g) { missing++; continue; }
  if (g === 'UNKNOWN') { unknown++; continue; }
  const p = predictTier(row.rawScore);
  matrix[g][p]++;
  judged++;
  if (row.wrongLocation === 1) {
    wrongLocTotal++;
    if (p === 'FEED') feedWrongLocLeak++;
  }
  const entry = { id: row.id, raw: row.rawScore, t: (row.titleEn || '').slice(0, 70) };
  if (g === 'EXCLUDE' && p === 'FEED') offenders.feedButExclude.push(entry);
  if (g === 'FEED' && p === 'EXCLUDE') offenders.excludeButFeed.push(entry);
  if (g === 'TANGENTIAL' && p === 'FEED') offenders.tangentialButFeed.push(entry);
  if (g === 'FEED' && p === 'TANGENTIAL') offenders.feedButTangential.push(entry);
  if (g !== p) {
    disagreements.push({
      id: row.id, golden: g, predicted: p, raw: row.rawScore,
      wrongLoc: row.wrongLocation ?? 0, geo: row.geoAlignment, comp: row.comp,
      t: (row.titleEn || '').slice(0, 60),
    });
  }
}

const col = (p) => TIERS.reduce((s, g) => s + matrix[g][p], 0);
const rowSum = (g) => TIERS.reduce((s, p) => s + matrix[g][p], 0);

console.log(`run: ${path.basename(runDir)}   judged=${judged} unknown=${unknown} missing=${missing}`);
console.log('\nconfusion (rows=golden, cols=predicted):');
console.log('              FEED   TANG   EXCL   total');
for (const g of TIERS) {
  console.log(
    `${g.padEnd(11)} ${String(matrix[g].FEED).padStart(6)} ${String(matrix[g].TANGENTIAL).padStart(6)} ${String(matrix[g].EXCLUDE).padStart(6)} ${String(rowSum(g)).padStart(7)}`,
  );
}

console.log('\nper-tier metrics:');
for (const t of TIERS) {
  const tp = matrix[t][t];
  const prec = col(t) ? tp / col(t) : 0;
  const rec = rowSum(t) ? tp / rowSum(t) : 0;
  const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  console.log(
    `  ${t.padEnd(11)} precision ${(100 * prec).toFixed(1).padStart(5)}%   recall ${(100 * rec).toFixed(1).padStart(5)}%   f1 ${(100 * f1).toFixed(1).padStart(5)}%`,
  );
}

// The two product-critical numbers:
const exclLeak = matrix.EXCLUDE.FEED + matrix.EXCLUDE.TANGENTIAL;
const exclTotal = rowSum('EXCLUDE');
const feedMiss = matrix.FEED.EXCLUDE;
console.log(`\nCRITICAL: unrelated leaking into product: ${matrix.EXCLUDE.FEED} into FEED + ${matrix.EXCLUDE.TANGENTIAL} into TANGENTIAL of ${exclTotal} (${((100 * exclLeak) / (exclTotal || 1)).toFixed(1)}% leak)`);
console.log(`CRITICAL: impactful articles fully hidden (FEED->EXCLUDE): ${feedMiss} of ${rowSum('FEED')}`);

// NEW product metric: wrong-location leak (the Chhindwara/Dindori + Bhopal-
// sibling class). A FEED-predicted article whose geo resolves to a sibling city
// of a persona location is a leak — the headline metric for this redesign.
if (engine) {
  console.log(`\nCRITICAL: wrong-location leaks (FEED-predicted, geo=sibling-city): ${feedWrongLocLeak}  (of ${wrongLocTotal} wrong-location rows at any tier)`);
}

// Weighted "product accuracy": exact tier match
const correct = TIERS.reduce((s, t) => s + matrix[t][t], 0);
console.log(`\noverall tier accuracy: ${((100 * correct) / judged).toFixed(1)}%  (${correct}/${judged})`);

// Top scoring disagreements vs golden labels (with component breakdown) — the
// tuning surface for the math engine.
if (engine === 'math') {
  const near = (r) => Math.min(Math.abs(r - FEED_MIN), Math.abs(r - TANGENTIAL_MIN));
  const top = disagreements
    .slice()
    .sort((a, b) => near(a.raw) - near(b.raw))
    .slice(0, 10);
  console.log('\ntop 10 scoring disagreements (nearest a tier boundary, for tuning):');
  for (const d of top) {
    const c = d.comp
      ? `topic=${d.comp.topic} geo=${d.comp.geo}(${d.geo}) event=${d.comp.event} fresh=${d.comp.fresh} base=${d.comp.base} negP=${d.comp.negP} wrongP=${d.comp.wrongP}`
      : '';
    console.log(`  [${d.raw.toFixed(3)}] golden=${d.golden} pred=${d.predicted} wrongLoc=${d.wrongLoc}  ${d.t}`);
    if (c) console.log(`         ${c}`);
  }
}

if (verbose) {
  const dump = (name, list) => {
    console.log(`\n-- ${name} (${list.length}) --`);
    list.sort((a, b) => b.raw - a.raw).slice(0, 40).forEach((e) => console.log(`  [${e.raw.toFixed(2)}] ${e.t}`));
  };
  dump('golden EXCLUDE but predicted FEED (worst leak)', offenders.feedButExclude);
  dump('golden FEED but predicted EXCLUDE (worst miss)', offenders.excludeButFeed);
  dump('golden TANGENTIAL but predicted FEED', offenders.tangentialButFeed);
  dump('golden FEED but predicted TANGENTIAL', offenders.feedButTangential);
}
