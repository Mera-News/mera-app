// harness-local: scorer for the scoring-fix eval. One run directory in, one verdict per arm out.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/score-scoring-fix.ts <run-dir>
//
// FINAL per (arm, repeat, article) = pass-1 score, or min(pass-1, pass-2) when the arm's SPEC (the
// prompt-variant registry, never an arm name) carries a rescore field. Then the shipped `bucketScore`,
// then the 0.4 gate. Pass 1 is read from the score row's parsedSchema (the runner already decoded it
// with the shipped decoder); pass 2 from the reason row's parsedSchema.score, joined to its article by
// `items[0].id` with any `reason:` prefix stripped (the RESCORE REPORT join in run-newsharness-corpus).
//
// Also writes rater-contradiction.jsonl + rater-contradiction.key.json into the run dir (blind rater).
// Node-only; no network, no model calls.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bandOf, bucketScore, DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness';
import { resolvePromptVariant } from '@/lib/news-harness/prompts/prompt-variants';
import { readJsonl } from '../lib/agreement';
import { precisionRecallAt } from '../lib/rescore-metrics';

const GATE = DEFAULT_HARNESS_CONFIG.articlePipeline.discardFloor;
const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;
const SEED = 20260528;

interface FixtureArticle { articleId: string; verdict?: string | null; story?: string | null; label?: string | null }
interface Row {
  dupOf?: string | null; repeat: number; arm: string; variant: string; callType: string; error?: string | null;
  items?: { id: string }[];
  parsedSchema?: { byId?: { articleId: string; s: number | null }[]; reason?: string; score?: number } | null;
}
interface Cell { articleId: string; pass1: number; pass2?: number; final: number; note: string | null }
interface Metrics { mustRecall: number | null; broadRecall: number | null; precision: number | null }
export interface ArmReport {
  arm: string;
  rescores: boolean;
  perRepeat: Metrics[];
  mean: Metrics;
  verdict: 'REFERENCE' | 'PASS' | 'FAIL';
  failed: string[];
  changedByPass2: number;
  tierAccuracy?: number | null;
  stableStories?: { count: number; of: number; needed: number };
}
export interface ScoreResult { arms: ArmReport[]; floor: Metrics; text: string; mismatch: string | null }

const mean = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const f = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(3));

/** Fixed-seed PRNG so the blind-rater order is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An arm rescores when its spec names a pass-2 field. Unknown variant: fail loudly, never guess. */
function specRescores(variant: string): boolean {
  const spec = resolvePromptVariant(variant);
  return spec.rescorePolicy !== undefined || spec.reasonPriorScoreLine !== undefined;
}

export function scoreRun(dir: string): ScoreResult {
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as { args: { fixture: string } };
  const fixture = JSON.parse(readFileSync(summary.args.fixture, 'utf8')) as { articles: FixtureArticle[] };
  const art = new Map(fixture.articles.map((a) => [a.articleId, a]));
  const rows = (readJsonl(join(dir, 'rows.jsonl')) as unknown as Row[]).filter((r) => !r.dupOf && !r.error);

  // arm -> repeat -> articleId -> cell
  const cells = new Map<string, Map<number, Map<string, Cell>>>();
  const variantOf = new Map<string, string>();
  const cellFor = (arm: string, rep: number, id: string): Cell => {
    const byRep = cells.get(arm) ?? new Map();
    cells.set(arm, byRep);
    const byId = byRep.get(rep) ?? new Map();
    byRep.set(rep, byId);
    const c = byId.get(id) ?? { articleId: id, pass1: NaN, final: NaN, note: null };
    byId.set(id, c);
    return c;
  };
  for (const r of rows) {
    variantOf.set(r.arm, r.variant);
    if (r.callType === 'relevance-batch') {
      for (const e of r.parsedSchema?.byId ?? []) if (e.s !== null) cellFor(r.arm, r.repeat, e.articleId).pass1 = e.s;
    } else if (r.callType === 'reason') {
      const id = (r.items?.[0]?.id ?? '').replace(/^reason:/, '');
      if (!id) continue;
      const c = cellFor(r.arm, r.repeat, id);
      c.note = r.parsedSchema?.reason ?? null;
      if (typeof r.parsedSchema?.score === 'number') c.pass2 = r.parsedSchema.score;
    }
  }

  const reports = new Map<string, ArmReport>();
  const tiered = fixture.articles.some((a) => a.story && a.label);
  const rater: { line: { note: string | null; tier: string }; key: { arm: string; repeat: number; articleId: string } }[] = [];
  for (const [arm, byRep] of [...cells].sort(([a], [b]) => a.localeCompare(b))) {
    const rescores = specRescores(variantOf.get(arm) as string);
    const perRepeat: Metrics[] = [];
    let changed = 0;
    const tierHits: boolean[] = [];
    const storyTiers = new Map<string, string[]>(); // story -> per-repeat "all copies one tier" (tier or 'SPLIT')
    for (const rep of [...byRep.keys()].sort((a, b) => a - b)) {
      const byId = byRep.get(rep) as Map<string, Cell>;
      const items: { score: number; verdict: string | null }[] = [];
      const storyRep = new Map<string, Set<string>>();
      for (const c of byId.values()) {
        if (Number.isNaN(c.pass1)) continue; // no pass-1 score: nothing to judge
        const raw = rescores && c.pass2 !== undefined ? Math.min(c.pass1, c.pass2) : c.pass1;
        if (raw !== c.pass1) changed += 1;
        c.final = bucketScore(raw, CFG);
        items.push({ score: c.final, verdict: art.get(c.articleId)?.verdict ?? null });
        const tier = bandOf(c.final, DEFAULT_HARNESS_CONFIG);
        if (c.final >= GATE) rater.push({ line: { note: c.note, tier }, key: { arm, repeat: rep, articleId: c.articleId } });
        const a = art.get(c.articleId);
        if (a?.story && a.label) {
          tierHits.push(tier === a.label.toUpperCase());
          const s = storyRep.get(a.story) ?? new Set();
          s.add(tier);
          storyRep.set(a.story, s);
        }
      }
      for (const [story, tiers] of storyRep) {
        const l = storyTiers.get(story) ?? [];
        l.push(tiers.size === 1 ? [...tiers][0] : 'SPLIT');
        storyTiers.set(story, l);
      }
      const must = precisionRecallAt(items, GATE, new Set(['must_show']));
      const broad = precisionRecallAt(items, GATE, new Set(['must_show', 'nice_to_have']));
      perRepeat.push({ mustRecall: must.recall, broadRecall: broad.recall, precision: broad.precision });
    }
    const repeats = byRep.size;
    const needed = repeats >= 5 ? 4 : Math.max(repeats - 1, 0);
    const rep: ArmReport = {
      arm, rescores, perRepeat, changedByPass2: changed, verdict: 'REFERENCE', failed: [],
      mean: {
        mustRecall: mean(perRepeat.map((m) => m.mustRecall)),
        broadRecall: mean(perRepeat.map((m) => m.broadRecall)),
        precision: mean(perRepeat.map((m) => m.precision)),
      },
    };
    if (tiered) {
      rep.tierAccuracy = tierHits.length ? tierHits.filter(Boolean).length / tierHits.length : null;
      // A story is stable when one tier holds in at least `needed` repeats (every copy in that tier).
      let ok = 0;
      for (const l of storyTiers.values()) {
        const counts = new Map<string, number>();
        for (const t of l) if (t !== 'SPLIT') counts.set(t, (counts.get(t) ?? 0) + 1);
        if (Math.max(0, ...counts.values()) >= needed) ok += 1;
      }
      rep.stableStories = { count: ok, of: storyTiers.size, needed };
    }
    reports.set(arm, rep);
  }

  // Noise floor + verdicts, per model (arm is `model@variant`).
  const floorOf = (model: string): Metrics => {
    const b = reports.get(`${model}@baseline`);
    const n = reports.get(`${model}@null-control`);
    const diff = (k: keyof Metrics): number | null => {
      if (!b || !n) return null;
      return mean(b.perRepeat.map((m, i) => (m[k] === null || n.perRepeat[i]?.[k] == null ? null : Math.abs((m[k] as number) - (n.perRepeat[i][k] as number)))));
    };
    return { mustRecall: diff('mustRecall'), broadRecall: diff('broadRecall'), precision: diff('precision') };
  };
  let floorShown: Metrics = { mustRecall: null, broadRecall: null, precision: null };
  for (const r of reports.values()) {
    const model = r.arm.split('@')[0];
    const base = reports.get(`${model}@baseline`);
    const floor = floorOf(model);
    floorShown = floor.mustRecall !== null ? floor : floorShown;
    if (r.arm.endsWith('@baseline')) continue;
    if (!base || floor.mustRecall === null || floor.precision === null) {
      throw new Error(`score-scoring-fix: ${model} needs baseline and null-control arms in the run to compute the noise floor.`);
    }
    for (const k of ['mustRecall', 'precision'] as const) {
      const bm = base.mean[k];
      const m = r.mean[k];
      if (bm !== null && (m === null || m < bm - (floor[k] as number))) r.failed.push(k === 'mustRecall' ? 'must-show recall' : 'precision');
    }
    r.verdict = r.failed.length ? 'FAIL' : 'PASS';
  }

  // Cross-check against the runner's own `rescore: n=` lines, when a log sits in the run dir.
  let mismatch: string | null = null;
  for (const name of readdirSync(dir).filter((n) => /\.(txt|log)$/.test(n))) {
    let arm = '';
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (/^\S+@\S+$/.test(line)) arm = line.trim();
      const m = /rescore: n=(\d+)/.exec(line);
      const r = m && reports.get(arm);
      if (m && r && Number(m[1]) !== r.changedByPass2) {
        mismatch = `${arm}: runner says rescore n=${m[1]}, scorer counts ${r.changedByPass2} rows where pass 2 changed FINAL (${name})`;
      }
    }
  }

  // Blind-rater file: note + final tier only, fixed-seed shuffle; the key maps line number (1-based) to the row.
  const rnd = mulberry32(SEED);
  for (let i = rater.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [rater[i], rater[j]] = [rater[j], rater[i]];
  }
  writeFileSync(join(dir, 'rater-contradiction.jsonl'), rater.map((r) => JSON.stringify(r.line)).join('\n') + (rater.length ? '\n' : ''), 'utf8');
  writeFileSync(join(dir, 'rater-contradiction.key.json'), `${JSON.stringify(rater.map((r, i) => ({ line: i + 1, ...r.key })), null, 2)}\n`, 'utf8');

  const out: string[] = [`gate ${GATE}; precision = broad (must_show + nice_to_have); recall columns as named`];
  for (const r of reports.values()) {
    out.push(`\n${r.arm}  [${r.verdict}${r.failed.length ? `: ${r.failed.join(', ')}` : ''}]  rescore=${r.rescores}  pass2-changed-final=${r.changedByPass2}`);
    r.perRepeat.forEach((m, i) => out.push(`  repeat ${i}: must-show recall ${f(m.mustRecall)}  broad recall ${f(m.broadRecall)}  precision ${f(m.precision)}`));
    out.push(`  mean    : must-show recall ${f(r.mean.mustRecall)}  broad recall ${f(r.mean.broadRecall)}  precision ${f(r.mean.precision)}`);
    if (r.stableStories) {
      const rule = r.perRepeat.length >= 5 ? 'at least 4 of 5 repeats' : `all but one repeat (run has ${r.perRepeat.length}, fewer than 5)`;
      out.push(`  tier accuracy ${f(r.tierAccuracy ?? null)}; stories with all copies in one tier in ${rule}: ${r.stableStories.count} of ${r.stableStories.of}`);
    }
  }
  out.push(`\nnoise floor (mean |baseline - null-control|): must-show recall ${f(floorShown.mustRecall)}  broad recall ${f(floorShown.broadRecall)}  precision ${f(floorShown.precision)}`);
  return { arms: [...reports.values()], floor: floorShown, text: out.join('\n'), mismatch };
}

if (/score-scoring-fix\.ts$/.test(process.argv[1] ?? '')) {
  const dir = process.argv[2];
  if (!dir || !existsSync(join(dir, 'rows.jsonl'))) {
    console.error('usage: score-scoring-fix.ts <run-dir containing rows.jsonl and summary.json>');
    process.exit(2);
  }
  const res = scoreRun(dir);
  console.log(res.text);
  if (res.mismatch) {
    console.error(`\nCROSS-CHECK FAILED: ${res.mismatch}`);
    process.exit(1);
  }
}
