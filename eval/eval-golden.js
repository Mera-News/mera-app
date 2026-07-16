#!/usr/bin/env node
// Evaluate a harness run's scores.json against golden-labels.json.
//
// Tier contract (the product spec being tuned toward):
//   FEED       raw >= 0.40  (direct/indirect impact -> For You page)
//   TANGENTIAL 0.25 <= raw < 0.40  (interest-adjacent -> future Discover surface)
//   EXCLUDE    raw < 0.25   (unrelated -> never shown)
//
// Usage: node eval-golden.js <runDir> [--verbose]

const path = require('path');
const fs = require('fs');

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node eval-golden.js <runDir> [--verbose]');
  process.exit(1);
}
const verbose = process.argv.includes('--verbose');

const scores = JSON.parse(fs.readFileSync(path.join(runDir, 'scores.json'), 'utf8'));
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
let judged = 0, unknown = 0, missing = 0;

for (const row of scores) {
  const g = goldenMap.get(row.id);
  if (!g) { missing++; continue; }
  if (g === 'UNKNOWN') { unknown++; continue; }
  const p = predictTier(row.rawScore);
  matrix[g][p]++;
  judged++;
  const entry = { id: row.id, raw: row.rawScore, t: (row.titleEn || '').slice(0, 70) };
  if (g === 'EXCLUDE' && p === 'FEED') offenders.feedButExclude.push(entry);
  if (g === 'FEED' && p === 'EXCLUDE') offenders.excludeButFeed.push(entry);
  if (g === 'TANGENTIAL' && p === 'FEED') offenders.tangentialButFeed.push(entry);
  if (g === 'FEED' && p === 'TANGENTIAL') offenders.feedButTangential.push(entry);
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

// Weighted "product accuracy": exact tier match
const correct = TIERS.reduce((s, t) => s + matrix[t][t], 0);
console.log(`\noverall tier accuracy: ${((100 * correct) / judged).toFixed(1)}%  (${correct}/${judged})`);

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
