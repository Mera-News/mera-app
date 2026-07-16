#!/usr/bin/env tsx
// harness-local — `npm run harness:compare -- <runDirA> <runDirB>`
//
// Compares two harness run directories (as produced by
// harness-local/lib/run-writer.ts) and prints a readable diff to stdout:
// config changes, summary deltas, a bucket-transition matrix, kept/discarded
// flips, the biggest score movers, and articles unique to either run.
//
// Run-dir contract this script expects (see harness-local/README.md):
//   <runDir>/config.json  — the ArticlePipelineConfig (± overrides) used for
//                            the run (see lib/news-harness/core/config.ts).
//   <runDir>/summary.json — a flat-ish object of aggregate stats for the run
//                            (counts, timings, totals — numeric fields are
//                            diffed, everything else shown old→new).
//   <runDir>/scores.json  — array of { id, title?, titleEn?, rawScore,
//                            relevance, reason? } — one entry per scored
//                            article. `bucket` is derived from rawScore using
//                            that run's own config.json cutoffs (mirrors
//                            lib/news-harness/article-pipeline/scoring.ts's
//                            bucketScores) rather than trusted as a field,
//                            since not every run-writer version may emit one.
//
// This script is intentionally forgiving about exact scores.json field names
// (title vs titleEn vs id-only) since it consumes output from a sibling
// script this agent does not own.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_HARNESS_CONFIG, type ArticlePipelineConfig } from '@/lib/news-harness/core/config';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface ScoreEntry {
  id: string;
  title?: string;
  titleEn?: string;
  rawScore?: number;
  relevance?: number;
  reason?: string;
  bucket?: string;
  kept?: boolean;
  [key: string]: Json | undefined;
}

// NB: the run-writer (and lib/news-harness/article-pipeline/scoring.ts, whose
// doc comment spells out the bucket names) emits the discard bucket as
// 'DISCARD', not 'DISCARDED' — keep this in sync with that literal or the
// matrix/flip logic below silently drops every discarded article again.
type Bucket = 'DISCARD' | 'LOW' | 'MEDIUM' | 'HIGH' | 'EMERGENCY' | 'UNKNOWN';

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function readJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
  }
}

function loadRunDir(dir: string) {
  const config = readJson<Record<string, Json>>(path.join(dir, 'config.json'));
  const summary = readJson<Record<string, Json>>(path.join(dir, 'summary.json'));
  const scores = readJson<ScoreEntry[]>(path.join(dir, 'scores.json'));
  if (!scores) {
    throw new Error(`${dir}: scores.json not found or empty — nothing to compare`);
  }
  return {
    dir,
    config: config ?? {},
    summary: summary ?? {},
    scores,
  };
}

function articlePipelineConfigFrom(config: Record<string, Json>): ArticlePipelineConfig {
  const embedded = (config.articlePipeline ?? config) as Partial<ArticlePipelineConfig>;
  return { ...DEFAULT_HARNESS_CONFIG.articlePipeline, ...embedded };
}

function bucketOf(entry: ScoreEntry, cfg: ArticlePipelineConfig): Bucket {
  if (entry.bucket) return entry.bucket as Bucket;
  const raw = entry.rawScore;
  if (typeof raw !== 'number' || Number.isNaN(raw)) return 'UNKNOWN';
  if (raw < cfg.discardFloor) return 'DISCARD';
  if (raw > cfg.emergencyPriorityCutoff) return 'EMERGENCY';
  if (raw >= cfg.highPriorityCutoff) return 'HIGH';
  if (raw >= cfg.mediumPriorityCutoff) return 'MEDIUM';
  return 'LOW';
}

// Kept-ness is its own field in scores.json (not always equivalent to
// `bucket !== 'DISCARD'` if a run-writer version derives kept differently) —
// prefer it when present, else fall back to that run's own discardFloor.
function keptOf(entry: ScoreEntry, cfg: ArticlePipelineConfig): boolean {
  if (typeof entry.kept === 'boolean') return entry.kept;
  const raw = entry.rawScore;
  if (typeof raw !== 'number' || Number.isNaN(raw)) return true;
  return raw >= cfg.discardFloor;
}

function titleOf(entry: ScoreEntry): string {
  return entry.title ?? entry.titleEn ?? entry.id;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width - 1) + '…' : s.padEnd(width);
}

function printTable(headers: string[], rows: string[][], widths?: number[]): void {
  const colWidths =
    widths ??
    headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length), 4) + 2);
  console.log(headers.map((h, i) => pad(h, colWidths[i])).join(''));
  console.log(colWidths.map((w) => '-'.repeat(w - 1) + ' ').join(''));
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell ?? '', colWidths[i])).join(''));
  }
}

function heading(title: string): void {
  console.log('');
  console.log(`=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// (a) Config diff
// ---------------------------------------------------------------------------

function deepDiff(a: Json, b: Json, prefix = ''): { path: string; oldValue: Json; newValue: Json }[] {
  const diffs: { path: string; oldValue: Json; newValue: Json }[] = [];
  const isObj = (v: Json): v is { [key: string]: Json } =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      const av = a[key] ?? null;
      const bv = b[key] ?? null;
      if (!(key in a)) {
        diffs.push({ path: nextPrefix, oldValue: null, newValue: bv });
      } else if (!(key in b)) {
        diffs.push({ path: nextPrefix, oldValue: av, newValue: null });
      } else {
        diffs.push(...deepDiff(av, bv, nextPrefix));
      }
    }
    return diffs;
  }

  if (JSON.stringify(a) !== JSON.stringify(b)) {
    diffs.push({ path: prefix || '(root)', oldValue: a, newValue: b });
  }
  return diffs;
}

function printConfigDiff(configA: Record<string, Json>, configB: Record<string, Json>): void {
  heading('Config diff');
  const diffs = deepDiff(configA, configB);
  if (diffs.length === 0) {
    console.log('(no config differences)');
    return;
  }
  printTable(
    ['path', 'old', 'new'],
    diffs.map((d) => [d.path, JSON.stringify(d.oldValue), JSON.stringify(d.newValue)]),
  );
}

// ---------------------------------------------------------------------------
// (b) Summary deltas
// ---------------------------------------------------------------------------

function printSummaryDeltas(summaryA: Record<string, Json>, summaryB: Record<string, Json>): void {
  heading('Summary deltas');
  const keys = new Set([...Object.keys(summaryA), ...Object.keys(summaryB)]);
  if (keys.size === 0) {
    console.log('(no summary.json data)');
    return;
  }
  const rows: string[][] = [];
  for (const key of keys) {
    const av = summaryA[key];
    const bv = summaryB[key];
    if (typeof av === 'number' && typeof bv === 'number') {
      const delta = bv - av;
      const sign = delta > 0 ? '+' : '';
      rows.push([key, String(av), String(bv), `${sign}${delta}`]);
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      rows.push([key, JSON.stringify(av ?? null), JSON.stringify(bv ?? null), 'changed']);
    } else {
      rows.push([key, JSON.stringify(av ?? null), JSON.stringify(bv ?? null), '—']);
    }
  }
  printTable(['metric', 'A', 'B', 'delta'], rows);
}

// ---------------------------------------------------------------------------
// (c)-(f) Article-level comparison
// ---------------------------------------------------------------------------

const ALL_BUCKETS: Bucket[] = ['DISCARD', 'LOW', 'MEDIUM', 'HIGH', 'EMERGENCY', 'UNKNOWN'];

function printBucketTransitionMatrix(
  common: { id: string; bucketA: Bucket; bucketB: Bucket }[],
): void {
  heading('Bucket-transition matrix (rows = A, cols = B)');
  const matrix = new Map<string, number>();
  for (const { bucketA, bucketB } of common) {
    const key = `${bucketA} ${bucketB}`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
  }
  const usedBuckets = ALL_BUCKETS.filter(
    (b) => common.some((c) => c.bucketA === b) || common.some((c) => c.bucketB === b),
  );
  const rows = usedBuckets.map((rowBucket) => [
    rowBucket,
    ...usedBuckets.map((colBucket) => String(matrix.get(`${rowBucket} ${colBucket}`) ?? 0)),
  ]);
  printTable(['A \\ B', ...usedBuckets], rows);
}

function printKeptDiscardedFlips(
  common: {
    id: string;
    title: string;
    bucketA: Bucket;
    bucketB: Bucket;
    keptA: boolean;
    keptB: boolean;
    rawA?: number;
    rawB?: number;
  }[],
): void {
  heading('Kept ↔ discarded flips');
  const flips = common.filter((c) => c.keptA !== c.keptB);
  if (flips.length === 0) {
    console.log('(none)');
    return;
  }
  printTable(
    ['title', 'direction', 'A bucket', 'B bucket', 'rawScore A→B'],
    flips.map((f) => [
      f.title,
      f.keptA && !f.keptB ? 'kept → discarded' : 'discarded → kept',
      f.bucketA,
      f.bucketB,
      `${f.rawA ?? '—'} → ${f.rawB ?? '—'}`,
    ]),
  );
}

function printTopMovers(
  common: { id: string; title: string; rawA?: number; rawB?: number }[],
  limit = 10,
): void {
  heading(`Top ${limit} score movers`);
  const withDelta = common
    .filter((c) => typeof c.rawA === 'number' && typeof c.rawB === 'number')
    .map((c) => ({ ...c, delta: (c.rawB as number) - (c.rawA as number) }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .slice(0, limit);
  if (withDelta.length === 0) {
    console.log('(no comparable rawScore values)');
    return;
  }
  printTable(
    ['title', 'rawScore A', 'rawScore B', 'delta'],
    withDelta.map((c) => [
      c.title,
      String(c.rawA),
      String(c.rawB),
      `${c.delta > 0 ? '+' : ''}${c.delta.toFixed(3)}`,
    ]),
  );
}

function printOnlyIn(label: string, entries: ScoreEntry[], previewCount = 5): void {
  heading(`Only in ${label}`);
  console.log(`count: ${entries.length}`);
  if (entries.length > 0) {
    console.log('first few:');
    for (const e of entries.slice(0, previewCount)) {
      console.log(`  - ${titleOf(e)} (${e.id})`);
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const [runDirA, runDirB] = process.argv.slice(2);
  if (!runDirA || !runDirB) {
    console.error('Usage: npm run harness:compare -- <runDirA> <runDirB>');
    process.exitCode = 1;
    return;
  }

  const a = loadRunDir(path.resolve(runDirA));
  const b = loadRunDir(path.resolve(runDirB));

  const cfgA = articlePipelineConfigFrom(a.config);
  const cfgB = articlePipelineConfigFrom(b.config);

  printConfigDiff(a.config, b.config);
  printSummaryDeltas(a.summary, b.summary);

  const scoresAById = new Map(a.scores.map((e) => [e.id, e]));
  const scoresBById = new Map(b.scores.map((e) => [e.id, e]));

  const commonIds = [...scoresAById.keys()].filter((id) => scoresBById.has(id));
  const onlyInA = a.scores.filter((e) => !scoresBById.has(e.id));
  const onlyInB = b.scores.filter((e) => !scoresAById.has(e.id));

  const common = commonIds.map((id) => {
    const entryA = scoresAById.get(id)!;
    const entryB = scoresBById.get(id)!;
    return {
      id,
      title: titleOf(entryA),
      bucketA: bucketOf(entryA, cfgA),
      bucketB: bucketOf(entryB, cfgB),
      keptA: keptOf(entryA, cfgA),
      keptB: keptOf(entryB, cfgB),
      rawA: entryA.rawScore,
      rawB: entryB.rawScore,
    };
  });

  printBucketTransitionMatrix(common);
  printKeptDiscardedFlips(common);
  printTopMovers(common);
  printOnlyIn('A', onlyInA);
  printOnlyIn('B', onlyInB);

  if (onlyInA.length > 0 || onlyInB.length > 0) {
    console.log('');
    console.log(
      '⚠️  Article sets differ between the two runs — score/bucket comparisons above only ' +
        'cover the overlapping articles. For a controlled comparison, re-run the second ' +
        'pass with --articles-from pointed at the first run so both operate on the exact ' +
        'same article set.',
    );
  }
}

main();
