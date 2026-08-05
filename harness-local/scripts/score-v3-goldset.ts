// Node-only replay: score a frozen 348-article GOLD SET through the relevance-v3
// merged scoring prompt and through a derived SCORE-ONLY variant of the same
// prompt, then report how each correlates with the blind Sonnet panel's
// composite judgement (`j_comp`).
//
//   npx tsx harness-local/scripts/score-v3-goldset.ts --label v3-gate \
//     [--matrix <matrix.json>] [--facts <persona_facts.json>] [--db <v1.db>] \
//     [--variants merged,score-only] [--limit N] [--dry-run]
//
// WHY THIS SCRIPT EXISTS (the decision it settles)
// -----------------------------------------------
// v3 merges the legacy two-pass cloud path (score prompt → reason prompt) into
// ONE call that returns {"i","rel","impact","why"?} per article. The open
// prompt-design question is whether asking the model for a user-facing sentence
// in the SAME response degrades the numbers it emits. This script runs the
// identical article set, chunking, temperature and token budget through both
// designs and compares Pearson r against the judge composite. If the merged
// design costs more than 0.03 r, the reason has to move back into its own call.
//
// The score-only system prompt is DERIVED HERE by string surgery over
// CLOUD_SCORE_V3_SYSTEM_PROMPT (asserted, and dumped to the run dir) rather than
// added to prompts.ts: it is an experiment variant, not a shipped prompt, and
// prompts.ts is pinned by config.test.ts / golden-prompts.test.ts.
//
// Local-only: harness-local is excluded from tsconfig, jest and EAS bundling.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessEnv } from '../config/env';
import { ensureLocalTestData } from '../config/local-data';
import { createNearAiLlm, type LlmCallRecord } from '../adapters/nearai-llm';
import { consoleLogger } from '../adapters/console-logger';
import { createRunWriter, captureGitSha } from '../lib/run-writer';
import {
  DEFAULT_HARNESS_CONFIG,
  CLOUD_SCORE_V3_SYSTEM_PROMPT,
  buildBatchScoringUserMessage,
  parseScoreV3Response,
  blendToScore,
  buildUserContext,
  resolveCountryName,
  chunk,
  type ScoreV3Entry,
  type BatchCall,
} from '../../lib/news-harness';

// --- Fixed paths of the frozen gold set (overridable via flags) -------------

const SCRATCH =
  '/private/tmp/claude-501/-Users-abhijeetchakraborty-Code-mera-news/' +
  '44c79ab4-a3d9-44eb-803a-b603af780eb4/scratchpad';

const DEFAULT_MATRIX = join(SCRATCH, 'matrix.json');
const DEFAULT_FACTS = join(SCRATCH, 'persona_facts.json');
const DEFAULT_DB = join(SCRATCH, 'frozen', 'v1.db');

type VariantName = 'merged' | 'score-only';

interface Args {
  label: string;
  matrix: string;
  facts: string;
  db: string;
  variants: VariantName[];
  limit?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    label: 'v3-goldset',
    matrix: DEFAULT_MATRIX,
    facts: DEFAULT_FACTS,
    db: DEFAULT_DB,
    variants: ['merged', 'score-only'],
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i] ?? args.label;
    else if (a === '--matrix') args.matrix = argv[++i] ?? args.matrix;
    else if (a === '--facts') args.facts = argv[++i] ?? args.facts;
    else if (a === '--db') args.db = argv[++i] ?? args.db;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--variants') {
      const raw = (argv[++i] ?? '').split(',').map((s) => s.trim());
      const ok = raw.filter((s): s is VariantName => s === 'merged' || s === 'score-only');
      if (ok.length > 0) args.variants = ok;
    }
  }
  return args;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// --- Gold-set shapes --------------------------------------------------------

interface MatrixRow {
  article_id: string;
  title: string;
  pub?: string;
  country?: string;
  age_h?: number;
  j_rel?: number;
  j_imp?: number;
  j_urg?: number;
  j_info?: number;
  j_comp: number;
  verdict: 'must_show' | 'nice_to_have' | 'skip';
  v1_relevance?: number | null;
}

interface PersonaFact {
  statement: string;
}

/** One gold article, assembled from matrix.json + the frozen v1 sqlite. */
interface GoldArticle {
  articleId: string;
  title: string;
  description: string;
  countryCode: string | null;
  relatedFacts: string[];
  jComp: number;
  verdict: MatrixRow['verdict'];
  v1Relevance: number | null;
}

/**
 * Read title/description/country and the retrieval-linked fact statements out of
 * the frozen v1 device DB. The fact link is
 * article_suggestions.id → article_suggestion_facts.article_suggestion_id →
 * facts.id, which is what production feeds into `Related User Fact`.
 *
 * Opened read-only: the frozen DB is the shared gold artifact and must not move.
 */
function loadFromDb(dbPath: string): {
  text: Map<string, { title: string; description: string; countryCode: string | null }>;
  facts: Map<string, string[]>;
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const text = new Map<string, { title: string; description: string; countryCode: string | null }>();
  const facts = new Map<string, string[]>();

  const rows = db
    .prepare('SELECT article_id, title_en, description_en, country_code FROM article_suggestions')
    .all() as {
    article_id: string;
    title_en: string | null;
    description_en: string | null;
    country_code: string | null;
  }[];
  for (const r of rows) {
    text.set(r.article_id, {
      title: r.title_en ?? '',
      description: r.description_en ?? '',
      countryCode: r.country_code,
    });
  }

  const factRows = db
    .prepare(
      `SELECT s.article_id AS article_id, f.statement AS statement
         FROM article_suggestions s
         JOIN article_suggestion_facts asf ON asf.article_suggestion_id = s.id
         JOIN facts f ON f.id = asf.fact_id
        ORDER BY s.article_id, f.id`,
    )
    .all() as { article_id: string; statement: string }[];
  for (const r of factRows) {
    if (!r.statement) continue;
    const list = facts.get(r.article_id) ?? [];
    list.push(r.statement);
    facts.set(r.article_id, list);
  }

  db.close();
  return { text, facts };
}

// --- Variant (b): derive a score-only system prompt -------------------------

/** Every edit the surgery must land, so a silently-missed one fails the run
 *  instead of quietly producing a prompt that still asks for a reason. */
interface Surgery {
  name: string;
  apply: (s: string) => string;
}

const WHY_FIELD_SECTION_START = '### The "why" field — conditional';
const FIELD_ORDER_SECTION_START = '### Field order is load-bearing';

const FIELD_ORDER_OLD =
  '### Field order is load-bearing\n' +
  'Always emit "i", then "rel", then "impact", then (if it qualifies) "why". ' +
  'Decide the two numbers first and let the sentence explain them. ' +
  'Never revise a number to fit a sentence you have already written.';

const FIELD_ORDER_NEW =
  '### Field order is load-bearing\n' +
  'Always emit "i", then "rel", then "impact" — those three keys and nothing else. ' +
  'Decide the two numbers independently and emit no other field.';

const CONTRACT_OLD =
  '{"i": <1-based position of the article in this batch>, "rel": <integer 0-100>, ' +
  '"impact": <integer 0-100>, "why": "<25 words or fewer>"}';
const CONTRACT_NEW =
  '{"i": <1-based position of the article in this batch>, "rel": <integer 0-100>, ' +
  '"impact": <integer 0-100>}';

const INTEGERS_OLD =
  '- `"rel"` and `"impact"` are INTEGERS (never decimals) and always come before `"why"`.';
const INTEGERS_NEW = '- `"rel"` and `"impact"` are INTEGERS (never decimals).';

const WHY_GATE_BULLET =
  '- `"why"` is present ONLY when (0.65 × rel) + (0.35 × impact) ≥ 34; otherwise the key is absent.\n';

function requireReplace(s: string, from: string, to: string, label: string): string {
  if (!s.includes(from)) {
    throw new Error(
      `score-v3-goldset: prompt surgery "${label}" did not match — ` +
        'CLOUD_SCORE_V3_SYSTEM_PROMPT has drifted. Re-derive the score-only variant before running.',
    );
  }
  return s.replace(from, to);
}

const SURGERIES: Surgery[] = [
  {
    // Drop the whole conditional-reason section (rubric + voice rule + the
    // "never fabricate a connection" paragraph), up to the next heading.
    name: 'remove why-field section',
    apply: (s) => {
      const start = s.indexOf(WHY_FIELD_SECTION_START);
      const end = s.indexOf(FIELD_ORDER_SECTION_START);
      if (start === -1 || end === -1 || end <= start) {
        throw new Error(
          'score-v3-goldset: could not locate the why-field section boundaries in ' +
            'CLOUD_SCORE_V3_SYSTEM_PROMPT — prompt has drifted.',
        );
      }
      return s.slice(0, start) + s.slice(end);
    },
  },
  {
    name: 'rewrite field-order paragraph',
    apply: (s) => requireReplace(s, FIELD_ORDER_OLD, FIELD_ORDER_NEW, 'field-order paragraph'),
  },
  {
    name: 'rewrite output contract',
    apply: (s) => requireReplace(s, CONTRACT_OLD, CONTRACT_NEW, 'output contract'),
  },
  {
    name: 'rewrite integers bullet',
    apply: (s) => requireReplace(s, INTEGERS_OLD, INTEGERS_NEW, 'integers bullet'),
  },
  {
    name: 'drop why-gate bullet',
    apply: (s) => requireReplace(s, WHY_GATE_BULLET, '', 'why-gate bullet'),
  },
  {
    // The calibration anchors and the Task example both carry inline whys.
    name: 'strip why from examples',
    apply: (s) => {
      const stripped = s.replace(/,"why":"[^"]*"/g, '');
      if (stripped === s) {
        throw new Error('score-v3-goldset: no inline "why" examples found to strip — prompt drifted.');
      }
      return stripped;
    },
  },
  {
    name: 'strip "no reason emitted" aside',
    apply: (s) => requireReplace(s, ', no reason emitted', '', 'no-reason-emitted aside'),
  },
];

function deriveScoreOnlyPrompt(): string {
  let out = CLOUD_SCORE_V3_SYSTEM_PROMPT;
  for (const surgery of SURGERIES) out = surgery.apply(out);

  // The base rubric legitimately contains lowercase prose "why" ("It names why
  // this article was retrieved", an anchor titled "Why founders burn out"), so
  // the assertion targets the JSON field reference specifically.
  const leftovers = out
    .split('\n')
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes('"why"') || line.includes('"why":'));
  if (leftovers.length > 0) {
    throw new Error(
      'score-v3-goldset: derived score-only prompt still references the "why" field:\n' +
        leftovers.map(({ i, line }) => `  line ${i + 1}: ${line}`).join('\n'),
    );
  }
  return out;
}

/** Variant (b)'s user message: the v3 message with the trailer's `"why"?` key
 *  removed, so the last thing the model reads matches its system contract. */
const TRAILER_V3 = '({"i","rel","impact","why"?})';
const TRAILER_SCORE_ONLY = '({"i","rel","impact"})';

function buildUserMessage(
  variant: VariantName,
  userContext: string,
  articles: { title: string; description: string; country?: string; relatedFacts?: string[] }[],
): string {
  const msg = buildBatchScoringUserMessage({ userContext, articles, v3: true });
  if (variant === 'merged') return msg;
  if (!msg.includes(TRAILER_V3)) {
    throw new Error(
      'score-v3-goldset: v3 trailer not found in the built user message — ' +
        'buildBatchScoringUserMessage has drifted.',
    );
  }
  return msg.replace(TRAILER_V3, TRAILER_SCORE_ONLY);
}

// --- Statistics -------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

/** Average ranks (ties shared) — the input to Spearman. */
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}

function spearman(xs: number[], ys: number[]): number {
  return pearson(ranks(xs), ranks(ys));
}

/** Deterministic PRNG so the bootstrap interval is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired bootstrap over Δr = r(a) − r(b) on the SAME resampled article indices.
 * Both variants scored the same articles, so the pairing removes the article-mix
 * component of the variance and leaves the design difference. Costs no provider
 * calls, which is why this replaces a repeat run.
 */
function bootstrapDeltaR(
  scoresA: number[],
  scoresB: number[],
  judge: number[],
  resamples = 4000,
  seed = 20260805,
): { lo: number; hi: number; mean: number } {
  const rand = mulberry32(seed);
  const n = judge.length;
  const deltas: number[] = [];
  const bufA = new Array<number>(n);
  const bufB = new Array<number>(n);
  const bufJ = new Array<number>(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rand() * n);
      bufA[i] = scoresA[k];
      bufB[i] = scoresB[k];
      bufJ[i] = judge[k];
    }
    const d = pearson(bufA, bufJ) - pearson(bufB, bufJ);
    if (Number.isFinite(d)) deltas.push(d);
  }
  deltas.sort((a, b) => a - b);
  const pick = (q: number) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))];
  return { lo: pick(0.025), hi: pick(0.975), mean: mean(deltas) };
}

// --- Scoring one variant ----------------------------------------------------

interface ScoredRow {
  articleId: string;
  title: string;
  rel: number;
  impact: number;
  blend: number;
  why: string | null;
  jComp: number;
  verdict: MatrixRow['verdict'];
  factless: boolean;
}

interface VariantResult {
  variant: VariantName;
  systemPrompt: string;
  rows: ScoredRow[];
  unscored: string[];
  chunkAttempts: number;
  parseNullChunks: number;
  retriedChunks: number;
  truncatedCalls: number;
  errorCalls: number;
  llmCalls: LlmCallRecord[];
}

const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

async function scoreVariant(
  variant: VariantName,
  systemPrompt: string,
  articles: GoldArticle[],
  userContext: string,
  llmFactory: (sink: LlmCallRecord[]) => ReturnType<typeof createNearAiLlm>,
): Promise<VariantResult> {
  const chunks = chunk(articles, CFG.articlesPerScorePrompt);
  const decoded = new Map<number, ScoreV3Entry[]>();
  const llmCalls: LlmCallRecord[] = [];
  const llm = llmFactory(llmCalls);

  let pending = chunks.map((_, i) => i);
  let chunkAttempts = 0;
  let parseNullChunks = 0;
  let retriedChunks = 0;

  // Attempt 0 = the run itself; attempts 1..2 are the parse-null retries.
  for (let attempt = 0; attempt <= 2 && pending.length > 0; attempt++) {
    if (attempt > 0) retriedChunks += pending.length;
    const calls: BatchCall[] = pending.map((ci) => ({
      id: `${variant}:chunk-${ci}:a${attempt}`,
      system: systemPrompt,
      prompt: buildUserMessage(
        variant,
        userContext,
        chunks[ci].map((a) => ({
          title: a.title,
          description: a.description,
          country: resolveCountryName(a.countryCode),
          relatedFacts: a.relatedFacts,
        })),
      ),
      temperature: CFG.scoreTemperature,
      maxTokens: CFG.v3ScoreBatchMaxTokens,
    }));
    chunkAttempts += calls.length;

    const results = await llm.batchComplete(calls, { model: CFG.model });
    const stillPending: number[] = [];
    results.forEach((res, k) => {
      const ci = pending[k];
      const entries = parseScoreV3Response(res.output ?? '', chunks[ci].length);
      if (entries) decoded.set(ci, entries);
      else {
        parseNullChunks++;
        stillPending.push(ci);
      }
    });
    pending = stillPending;
    if (pending.length > 0) {
      consoleLogger.warn(
        `[${variant}] attempt ${attempt}: ${pending.length} chunk(s) failed to parse — retrying`,
      );
    }
  }

  const rows: ScoredRow[] = [];
  const unscored: string[] = [];
  chunks.forEach((chunkArticles, ci) => {
    const entries = decoded.get(ci);
    chunkArticles.forEach((a, k) => {
      const e = entries?.[k];
      if (!e) {
        unscored.push(a.articleId);
        return;
      }
      rows.push({
        articleId: a.articleId,
        title: a.title,
        rel: e.rel,
        impact: e.impact,
        blend: blendToScore(e.rel, e.impact),
        why: e.why ?? null,
        jComp: a.jComp,
        verdict: a.verdict,
        factless: a.relatedFacts.length === 0,
      });
    });
  });

  return {
    variant,
    systemPrompt,
    rows,
    unscored,
    chunkAttempts,
    parseNullChunks,
    retriedChunks,
    truncatedCalls: llmCalls.filter((c) => c.finishReason === 'length').length,
    errorCalls: llmCalls.filter((c) => c.error).length,
    llmCalls,
  };
}

// --- Reporting --------------------------------------------------------------

const GATE = CFG.discardFloor; // 0.4 — the inclusive render gate
const MED = CFG.mediumPriorityCutoff; // 0.6
const HIGH = CFG.highPriorityCutoff; // 0.8
const EMERGENCY = CFG.emergencyPriorityCutoff; // 1.0

function pct(num: number, den: number): number {
  return den === 0 ? NaN : (100 * num) / den;
}

function fmt(n: number, digits = 3): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

interface VariantMetrics {
  variant: VariantName;
  n: number;
  pearson: number;
  spearman: number;
  gate: {
    n: number;
    mustShowRecall: number;
    mustShowTotal: number;
    skipShare: number;
    meanJComp: number;
  };
  histogram: { bucket: string; count: number; includedShare: number }[];
  maxIncludedBucketShare: number;
  bands: { band: string; n: number; meanJComp: number }[];
  bandsMonotone: boolean;
  topDecileHighPlus: number;
  skipMedPlus: number;
  reasons: {
    aboveGateWithWhy: number;
    aboveGateTotal: number;
    aboveGateBelowWhyGate: number;
    belowGateWithWhy: number;
    belowGateTotal: number;
  } | null;
  cutoffFor130: { cutoff: number; n: number; recall: number } | null;
}

function bucketLabel(score: number): string {
  const b = Math.min(10, Math.floor(score * 10));
  return `${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}`;
}

function computeMetrics(res: VariantResult, mustShowTotal: number): VariantMetrics {
  const rows = res.rows;
  const scores = rows.map((r) => r.blend);
  const judge = rows.map((r) => r.jComp);

  const included = rows.filter((r) => r.blend >= GATE);
  const excluded = rows.filter((r) => r.blend < GATE);

  // Histogram over ALL scored rows; the >40% acceptance bar is measured over the
  // INCLUDED population (that's the ranking surface the user actually sees).
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(bucketLabel(r.blend), (counts.get(bucketLabel(r.blend)) ?? 0) + 1);
  const includedCounts = new Map<string, number>();
  for (const r of included)
    includedCounts.set(bucketLabel(r.blend), (includedCounts.get(bucketLabel(r.blend)) ?? 0) + 1);
  const histogram = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, count]) => ({
      bucket,
      count,
      includedShare: pct(includedCounts.get(bucket) ?? 0, included.length),
    }));
  const maxIncludedBucketShare = Math.max(
    0,
    ...[...includedCounts.values()].map((c) => pct(c, included.length)),
  );

  const bandRows = (lo: number, hi: number, inclusiveHi = false) =>
    rows.filter((r) => r.blend >= lo && (inclusiveHi ? r.blend <= hi : r.blend < hi));
  const bandDefs: { band: string; rows: ScoredRow[] }[] = [
    { band: `LOW [${GATE},${MED})`, rows: bandRows(GATE, MED) },
    { band: `MED [${MED},${HIGH})`, rows: bandRows(MED, HIGH) },
    { band: `HIGH [${HIGH},${EMERGENCY}]`, rows: bandRows(HIGH, EMERGENCY, true) },
    { band: `EMERGENCY >${EMERGENCY}`, rows: rows.filter((r) => r.blend > EMERGENCY) },
  ];
  const bands = bandDefs.map((b) => ({
    band: b.band,
    n: b.rows.length,
    meanJComp: mean(b.rows.map((r) => r.jComp)),
  }));
  // Monotonicity is judged over the NON-EMPTY bands only — an empty band has no
  // mean to be out of order.
  const populated = bands.filter((b) => b.n > 0);
  const bandsMonotone = populated.every(
    (b, i) => i === 0 || b.meanJComp >= populated[i - 1].meanJComp,
  );

  // Judge top decile by j_comp over the scored population.
  const decileCount = Math.max(1, Math.round(rows.length * 0.1));
  const topDecile = [...rows].sort((a, b) => b.jComp - a.jComp).slice(0, decileCount);
  const topDecileHighPlus = pct(topDecile.filter((r) => r.blend >= HIGH).length, topDecile.length);

  const skips = rows.filter((r) => r.verdict === 'skip');
  const skipMedPlus = pct(skips.filter((r) => r.blend >= MED).length, skips.length);

  const reasons =
    res.variant === 'merged'
      ? {
          aboveGateWithWhy: included.filter((r) => r.why).length,
          aboveGateTotal: included.length,
          // The prompt's reason gate is weighted >= 34 (blend 0.407) but the
          // render gate is 0.400 (weighted 33.33) — rows in [0.400, 0.407) are
          // included and CORRECTLY carry no why. Counted so a sub-100% rate
          // isn't misread as disobedience.
          aboveGateBelowWhyGate: included.filter((r) => r.blend < blendToScore(34, 34)).length,
          belowGateWithWhy: excluded.filter((r) => r.why).length,
          belowGateTotal: excluded.length,
        }
      : null;

  // Diagnostic only (advisor note 6): if n > 130 at the 0.4 gate, what cutoff
  // gives n = 130 and what does recall cost there? The gate itself does not move.
  let cutoffFor130: VariantMetrics['cutoffFor130'] = null;
  if (included.length > 130) {
    const sorted = [...rows].sort((a, b) => b.blend - a.blend);
    const cutoff = sorted[129].blend;
    const at = rows.filter((r) => r.blend >= cutoff);
    cutoffFor130 = {
      cutoff,
      n: at.length,
      recall: at.filter((r) => r.verdict === 'must_show').length,
    };
  }

  return {
    variant: res.variant,
    n: rows.length,
    pearson: pearson(scores, judge),
    spearman: spearman(scores, judge),
    gate: {
      n: included.length,
      mustShowRecall: included.filter((r) => r.verdict === 'must_show').length,
      mustShowTotal,
      skipShare: pct(included.filter((r) => r.verdict === 'skip').length, included.length),
      meanJComp: mean(included.map((r) => r.jComp)),
    },
    histogram,
    maxIncludedBucketShare,
    bands,
    bandsMonotone,
    topDecileHighPlus,
    skipMedPlus,
    reasons,
    cutoffFor130,
  };
}

function printVariant(m: VariantMetrics): void {
  const log = (s: string) => console.log(s); // eslint-disable-line no-console
  log(`\n================ VARIANT: ${m.variant} ================`);
  log(`scored n = ${m.n}`);
  log(`Pearson r  (blend vs j_comp) = ${fmt(m.pearson)}   [v1 two-pass 0.63, v2 math 0.26]`);
  log(`Spearman ρ (blend vs j_comp) = ${fmt(m.spearman)}`);
  log(`\n-- At the inclusive gate (blend >= ${GATE}) --`);
  log(`feed size n            : ${m.gate.n}`);
  log(
    `must_show recall       : ${m.gate.mustShowRecall}/${m.gate.mustShowTotal} ` +
      `(${fmt(pct(m.gate.mustShowRecall, m.gate.mustShowTotal), 1)}%)`,
  );
  log(`judge-skip share       : ${fmt(m.gate.skipShare, 1)}%`);
  log(`mean j_comp (included) : ${fmt(m.gate.meanJComp, 2)}`);
  if (m.cutoffFor130) {
    log(
      `[diagnostic] cutoff for n=130: blend >= ${fmt(m.cutoffFor130.cutoff)} ` +
        `→ n=${m.cutoffFor130.n}, must_show recall ${m.cutoffFor130.recall}/${m.gate.mustShowTotal}`,
    );
  }

  log(`\n-- Score distribution (0.1 buckets; share = % of INCLUDED) --`);
  for (const h of m.histogram) {
    const bar = '#'.repeat(Math.round(h.count / 2));
    log(
      `${h.bucket.padEnd(9)} ${String(h.count).padStart(4)}  ` +
        `${(Number.isFinite(h.includedShare) ? `${h.includedShare.toFixed(1)}%` : '   -').padStart(6)}  ${bar}`,
    );
  }
  log(`max single-bucket share of included: ${fmt(m.maxIncludedBucketShare, 1)}%`);

  log(`\n-- Band purity (mean j_comp must be monotone) --`);
  for (const b of m.bands) log(`${b.band.padEnd(22)} n=${String(b.n).padStart(4)}  mean j_comp=${fmt(b.meanJComp, 2)}`);
  log(`monotone (over populated bands): ${m.bandsMonotone ? 'YES' : 'NO'}`);
  log(`judge top-decile landing HIGH+ : ${fmt(m.topDecileHighPlus, 1)}%`);
  log(`judge-skip landing MED+        : ${fmt(m.skipMedPlus, 1)}%`);

  if (m.reasons) {
    log(`\n-- Reason behaviour --`);
    log(
      `>= ${GATE} with a why : ${m.reasons.aboveGateWithWhy}/${m.reasons.aboveGateTotal} ` +
        `(${fmt(pct(m.reasons.aboveGateWithWhy, m.reasons.aboveGateTotal), 1)}%) ` +
        `— of which ${m.reasons.aboveGateBelowWhyGate} sit below the prompt's own why-gate (weighted 34) ` +
        `and correctly have none`,
    );
    log(
      `<  ${GATE} with a why : ${m.reasons.belowGateWithWhy}/${m.reasons.belowGateTotal} ` +
        `(${fmt(pct(m.reasons.belowGateWithWhy, m.reasons.belowGateTotal), 1)}%) — wasteful`,
    );
  }
}

interface AcceptanceCheck {
  bar: string;
  pass: boolean;
  observed: string;
}

function acceptance(m: VariantMetrics): AcceptanceCheck[] {
  return [
    {
      bar: 'recall >= 29/37 at n <= 130',
      pass: m.gate.mustShowRecall >= 29 && m.gate.n <= 130,
      observed: `recall ${m.gate.mustShowRecall}/${m.gate.mustShowTotal}, n=${m.gate.n}`,
    },
    {
      bar: 'judge-skip share <= 20%',
      pass: m.gate.skipShare <= 20,
      observed: `${fmt(m.gate.skipShare, 1)}%`,
    },
    {
      bar: 'no 0.1-bucket > 40% of included',
      pass: m.maxIncludedBucketShare <= 40,
      observed: `${fmt(m.maxIncludedBucketShare, 1)}%`,
    },
    {
      bar: 'Pearson r >= 0.55',
      pass: m.pearson >= 0.55,
      observed: fmt(m.pearson),
    },
  ];
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<number> {
  ensureLocalTestData();
  const args = parseArgs(process.argv.slice(2));
  const env = loadHarnessEnv();
  const log = (s: string) => console.log(s); // eslint-disable-line no-console

  // --- Load the gold set. ---
  const matrix = readJson<MatrixRow[]>(args.matrix);
  const personaFacts = readJson<PersonaFact[]>(args.facts);
  const { text, facts } = loadFromDb(args.db);

  const missingText: string[] = [];
  const factless: string[] = [];
  const articles: GoldArticle[] = [];
  for (const row of matrix) {
    const t = text.get(row.article_id);
    if (!t) {
      missingText.push(row.article_id);
      continue;
    }
    const related = facts.get(row.article_id) ?? [];
    if (related.length === 0) factless.push(row.article_id);
    articles.push({
      articleId: row.article_id,
      // Prefer the DB's English title (the exact text production scores);
      // matrix.json's `title` is the display copy and matches it in practice.
      title: t.title || row.title,
      description: t.description,
      countryCode: t.countryCode,
      relatedFacts: related,
      jComp: row.j_comp,
      verdict: row.verdict,
      v1Relevance: row.v1_relevance ?? null,
    });
  }
  const scoped =
    typeof args.limit === 'number' && !Number.isNaN(args.limit)
      ? articles.slice(0, args.limit)
      : articles;

  const mustShowTotal = scoped.filter((a) => a.verdict === 'must_show').length;
  const userContext = buildUserContext(personaFacts.map((f) => f.statement));

  // --- Baseline plumbing check: reproduce the shipped v1 correlation. ---
  const v1Rows = scoped.filter((a) => typeof a.v1Relevance === 'number');
  const v1Corr = pearson(
    v1Rows.map((a) => a.v1Relevance as number),
    v1Rows.map((a) => a.jComp),
  );

  const scoreOnlyPrompt = deriveScoreOnlyPrompt();

  const writer = createRunWriter({ label: args.label });
  writer.writeJson('config', {
    target: env.target,
    model: CFG.model,
    gitSha: captureGitSha(),
    matrix: args.matrix,
    facts: args.facts,
    db: args.db,
    variants: args.variants,
    articlesPerScorePrompt: CFG.articlesPerScorePrompt,
    scoreTemperature: CFG.scoreTemperature,
    v3ScoreBatchMaxTokens: CFG.v3ScoreBatchMaxTokens,
    discardFloor: GATE,
    articleCount: scoped.length,
    mustShowTotal,
    missingText,
    factless,
  });
  writeFileSync(join(writer.dir, 'system-prompt-merged.txt'), CLOUD_SCORE_V3_SYSTEM_PROMPT, 'utf8');
  writeFileSync(join(writer.dir, 'system-prompt-score-only.txt'), scoreOnlyPrompt, 'utf8');
  writer.writeJson('articles', scoped);
  writeFileSync(
    join(writer.dir, 'sample-user-message-merged.txt'),
    buildUserMessage(
      'merged',
      userContext,
      scoped.slice(0, CFG.articlesPerScorePrompt).map((a) => ({
        title: a.title,
        description: a.description,
        country: resolveCountryName(a.countryCode),
        relatedFacts: a.relatedFacts,
      })),
    ),
    'utf8',
  );

  log(`\nGold set: ${scoped.length} articles (${mustShowTotal} must_show), ` +
      `${Math.ceil(scoped.length / CFG.articlesPerScorePrompt)} chunks/variant`);
  log(`Baseline plumbing check — Pearson(v1_relevance, j_comp) = ${fmt(v1Corr)} over n=${v1Rows.length} (expect ~0.63)`);
  if (missingText.length > 0) log(`WARNING: ${missingText.length} matrix rows absent from the frozen DB`);
  if (factless.length > 0) log(`NOTE: ${factless.length} articles have no linked fact (Related User Fact: none)`);
  log(`Run dir: ${writer.dir}`);

  if (args.dryRun) {
    log('\n--dry-run: prompts written, no provider calls made.');
    return 0;
  }

  // --- Score both variants. ---
  const llmFactory = (sink: LlmCallRecord[]) =>
    createNearAiLlm({
      apiKey: env.nearAiApiKey,
      baseUrl: env.nearAiBaseUrl,
      defaultModel: CFG.model,
      onCall: (rec) => sink.push(rec),
    });

  const results: VariantResult[] = [];
  for (const variant of args.variants) {
    const started = Date.now();
    log(`\n[${variant}] scoring ${scoped.length} articles…`);
    const res = await scoreVariant(
      variant,
      variant === 'merged' ? CLOUD_SCORE_V3_SYSTEM_PROMPT : scoreOnlyPrompt,
      scoped,
      userContext,
      llmFactory,
    );
    log(
      `[${variant}] done in ${Math.round((Date.now() - started) / 1000)}s — ` +
        `${res.rows.length} scored, ${res.unscored.length} unscored, ` +
        `${res.chunkAttempts} calls, ${res.parseNullChunks} parse-nulls, ` +
        `${res.truncatedCalls} truncated, ${res.errorCalls} errors`,
    );
    writer.writeJson(`scores-${variant}`, res.rows);
    writer.writeJson(`llm-calls-${variant}`, res.llmCalls);
    results.push(res);
  }

  // --- Report. ---
  const metrics = results.map((r) => computeMetrics(r, mustShowTotal));
  for (const m of metrics) printVariant(m);

  // --- Decision gate (on the intersection of rows both variants scored). ---
  let gateBlock: Record<string, unknown> | null = null;
  const merged = results.find((r) => r.variant === 'merged');
  const scoreOnly = results.find((r) => r.variant === 'score-only');
  if (merged && scoreOnly) {
    const byIdA = new Map(merged.rows.map((r) => [r.articleId, r]));
    const byIdB = new Map(scoreOnly.rows.map((r) => [r.articleId, r]));
    const shared = scoped
      .map((a) => a.articleId)
      .filter((id) => byIdA.has(id) && byIdB.has(id));
    const sa = shared.map((id) => byIdA.get(id)!.blend);
    const sb = shared.map((id) => byIdB.get(id)!.blend);
    const sj = shared.map((id) => byIdA.get(id)!.jComp);
    const rA = pearson(sa, sj);
    const rB = pearson(sb, sj);
    const delta = rA - rB;
    const boot = bootstrapDeltaR(sa, sb, sj);
    const noisy = boot.lo <= -0.03 && boot.hi >= -0.03;
    const decision = delta < -0.03 ? 'FALLBACK: split design' : 'MERGED OK';

    log(`\n================ DECISION GATE ================`);
    log(`intersection n = ${shared.length}`);
    log(`r(merged)     = ${fmt(rA)}`);
    log(`r(score-only) = ${fmt(rB)}`);
    log(`Δr = r(merged) − r(score-only) = ${delta >= 0 ? '+' : ''}${fmt(delta)}`);
    log(`paired bootstrap 95% CI on Δr : [${fmt(boot.lo)}, ${fmt(boot.hi)}] (4000 resamples)`);
    log(`DECISION: ${decision}${noisy ? '  — Δr threshold sits INSIDE the resampling CI (noise-limited)' : ''}`);

    gateBlock = {
      intersectionN: shared.length,
      rMerged: rA,
      rScoreOnly: rB,
      deltaR: delta,
      bootstrap: boot,
      thresholdInsideCI: noisy,
      decision,
    };
  }

  // --- Acceptance bars. ---
  log(`\n================ ACCEPTANCE BARS ================`);
  const acceptanceByVariant: Record<string, AcceptanceCheck[]> = {};
  for (const m of metrics) {
    const checks = acceptance(m);
    acceptanceByVariant[m.variant] = checks;
    log(`\n[${m.variant}]`);
    for (const c of checks) log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.bar.padEnd(34)} observed: ${c.observed}`);
  }

  writer.finish({
    baselineV1Pearson: v1Corr,
    baselineV1N: v1Rows.length,
    articleCount: scoped.length,
    mustShowTotal,
    factlessCount: factless.length,
    metrics,
    gate: gateBlock,
    acceptance: acceptanceByVariant,
    slippage: results.map((r) => ({
      variant: r.variant,
      chunkAttempts: r.chunkAttempts,
      parseNullChunks: r.parseNullChunks,
      retriedChunks: r.retriedChunks,
      truncatedCalls: r.truncatedCalls,
      errorCalls: r.errorCalls,
      unscored: r.unscored,
    })),
  });

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
