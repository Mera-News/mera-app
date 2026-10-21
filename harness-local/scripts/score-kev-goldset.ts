// EXPERIMENT: can jaredpalmer/kev-4b (a "System One" decision model, Redpill
// /v1/systemone) replace the SMALL chat model for PASS-1 RELEVANCE? Reason
// generation is out of scope: kev returns probabilities, not text.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/score-kev-goldset.ts \
//     [--label kev] [--reps 3] [--concurrency 4] [--arms near-small,redpill-small,kev] [--limit N]
//     [--kev-url http://127.0.0.1:8090/v1]   (kev against a local llama-server GGUF)
//
// ARMS (each a separately timed pass at the same concurrency; rounds alternate
// arms so NEAR's time-of-day drift lands on every arm, not one)
//   near-small     the SHIPPED path: CFG.model via NEAR direct, shipped system
//                  prompt, 5 articles per call, shipped decoder. The baseline.
//   redpill-small  the same model through Redpill (`qwen/qwen3.6-35b-a3b`, served
//                  by near-ai). A NETWORK control: kev also goes through Redpill,
//                  so kev vs this arm is model vs model, kev vs near-small is not.
//   kev            one /v1/systemone request per article, three independent
//                  questions on one shared state. Each question is its own
//                  signal:
//                    kev-score   PRE-REGISTERED PRIMARY. 4-level score, mapped /3.
//                    kev-geo     same + ONE foreign-domestic sentence.
//                    kev-noul    P(the reader wants it in their feed).
//
// Same inputs for every arm: the 9-fact persona, the article's related facts,
// title, description capped at 500 raw chars (asUntrusted's default), country
// name (omitted for null / GLOBAL). Gold set: fixtures/goldset-348.json, frozen.
//
// Neither arm measures the app's real path (E2EE gateway submit + poll). Kev on
// Redpill is TEE but NOT E2EE through our gateway; the fixture persona is
// synthetic, so this experiment leaks nothing, but shipping kev needs an E2EE
// route first (owner rule: inference is always E2EE).

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadHarnessEnv } from '../config/env';
import { ensureLocalTestData } from '../config/local-data';
import { createNearAiLlm, type LlmCallRecord } from '../adapters/nearai-llm';
import { consoleLogger } from '../adapters/console-logger';
import { createRunWriter, captureGitSha } from '../lib/run-writer';
import {
  DEFAULT_HARNESS_CONFIG,
  buildScoreCallForChunk,
  parseBatchRelevanceResponse,
  resolveCountryName,
  chunk,
  type ScoringCandidate,
  type BatchCall,
} from '../../lib/news-harness';

const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;
const RENDER_GATE = 0.4;
const SIZE_GRID = [60, 80, 100, 120, 150];
const REDPILL_BASE = 'https://api.redpill.ai/v1';
const REDPILL_SMALL_MODEL = 'qwen/qwen3.6-35b-a3b';
const KEV_MODEL = 'jaredpalmer/kev-4b';
/** --kev-url points kev at another /v1 base, e.g. a local llama-server running a GGUF quant. */
let kevBase = REDPILL_BASE;
/** --kev-provider pins an OpenRouter provider (e.g. Phala = full precision, SiliconFlow = fp8). */
let kevProvider: string | null = null;
const DESC_CAP = 500;

type PassArm = 'near-small' | 'redpill-small' | 'kev';
type Signal = 'near-small' | 'redpill-small' | 'kev-score' | 'kev-geo' | 'kev-noul';
const PASS_ARMS: PassArm[] = ['near-small', 'redpill-small', 'kev'];

// --- kev questions (fixed BEFORE the run; kev-score is the primary) ----------

const LEVELS = [
  "Not relevant: no real link to the reader's life, work, location or interests",
  'Low: only a loose or generic link to the reader',
  "Medium: clearly about one of the reader's interests, their work field, or their country",
  "High: directly affects the reader's daily life, job or home area, or is a major development in a core interest",
];
const SCORE_INSTRUCTIONS =
  'How relevant is this news article to this reader, given everything known about them?';
const GEO_SENTENCE =
  ' A story about the domestic affairs of a country the reader has no link to is not relevant, even when its subject matches one of their interests.';

const KEV_QUESTIONS = {
  score: { type: 'score', instructions: SCORE_INSTRUCTIONS, criteria: LEVELS },
  geo: { type: 'score', instructions: SCORE_INSTRUCTIONS + GEO_SENTENCE, criteria: LEVELS },
  feed: {
    type: 'noul',
    instructions: 'Would this reader want to see this article in their personal news feed?',
  },
} as const;

// --- fixture ----------------------------------------------------------------

interface GoldArticle {
  articleId: string;
  title: string;
  description: string;
  countryCode: string | null;
  relatedFacts: string[];
  jComp: number;
  verdict: 'must_show' | 'nice_to_have' | 'skip';
  v1Relevance: number;
}
interface Fixture {
  _provenance: { articleCount: number; mustShowTotal: number };
  personaFacts: { statement: string }[];
  articles: GoldArticle[];
}

function toCandidate(a: GoldArticle): ScoringCandidate {
  return {
    id: a.articleId,
    titleEn: a.title,
    descriptionEn: a.description,
    countryCode: a.countryCode,
    userTopicIds: [],
    relatedFacts: a.relatedFacts.map((statement, i) => ({ id: `${a.articleId}:f${i}`, statement })),
  };
}

function kevState(a: GoldArticle, persona: string[]) {
  const country =
    a.countryCode && a.countryCode !== 'GLOBAL' ? resolveCountryName(a.countryCode) : undefined;
  return {
    reader: persona,
    reader_facts_this_article_matched: a.relatedFacts,
    article: {
      title: a.title,
      description: a.description.slice(0, DESC_CAP),
      ...(country ? { country } : {}),
    },
  };
}

// --- one pass ---------------------------------------------------------------

interface Row {
  articleId: string;
  scores: Partial<Record<Signal, number>>;
}
interface PassResult {
  arm: PassArm;
  rep: number;
  rows: Row[];
  wallMs: number;
  latencies: number[]; // per request
  errors: number;
  truncated: number;
  unscored: number;
  inputTokens: number;
  cost: number;
  raw?: unknown[];
}

async function runSmallPass(
  arm: 'near-small' | 'redpill-small',
  rep: number,
  articles: GoldArticle[],
  persona: string[],
  opts: { apiKey: string; baseUrl: string; model: string; concurrency: number },
): Promise<PassResult> {
  const sink: LlmCallRecord[] = [];
  const llm = createNearAiLlm({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    defaultModel: opts.model,
    concurrency: opts.concurrency,
    onCall: (r) => sink.push(r),
  });
  const chunks = chunk(articles.map(toCandidate), CFG.articlesPerScorePrompt);
  const calls: BatchCall[] = chunks.map((cs, i) => {
    const { prompt, system } = buildScoreCallForChunk(cs, persona);
    return {
      id: `${arm}:${rep}:${i}`,
      system,
      prompt,
      temperature: CFG.scoreTemperature,
      maxTokens: CFG.scoreBatchMaxTokens,
    };
  });
  const t0 = Date.now();
  const results = await llm.batchComplete(calls, { model: opts.model });
  const wallMs = Date.now() - t0;
  const byId = new Map(results.map((r) => [r.id, r]));
  const rows: Row[] = [];
  let unscored = 0;
  chunks.forEach((cs, i) => {
    const res = byId.get(`${arm}:${rep}:${i}`);
    if (!res || res.error || !res.output) {
      unscored += cs.length;
      return;
    }
    const s = parseBatchRelevanceResponse(res.output, cs.length, res.id, undefined, CFG, consoleLogger);
    cs.forEach((c, j) => rows.push({ articleId: c.id, scores: { [arm]: s[j] } }));
  });
  return {
    arm,
    rep,
    rows,
    wallMs,
    latencies: sink.filter((c) => !c.error).map((c) => c.latencyMs),
    errors: sink.filter((c) => c.error).length,
    truncated: sink.filter((c) => c.finishReason === 'length').length,
    unscored,
    inputTokens: sink.reduce((t, c) => t + (c.usage?.promptTokens ?? 0), 0),
    cost: NaN,
  };
}

interface KevAnswer {
  type: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
}
interface KevResponse {
  answers?: Record<string, KevAnswer>;
  usage?: { input_tokens?: number; cost?: number };
  /** OpenRouter names the provider that served the call; checked against --kev-provider. */
  provider?: string;
}

async function kevRequest(apiKey: string, state: unknown): Promise<{ data: KevResponse; ms: number; retries: number }> {
  let retries = 0;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch(`${kevBase}/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: KEV_MODEL,
        state,
        questions: KEV_QUESTIONS,
        ...(kevProvider ? { provider: { only: [kevProvider], allow_fallbacks: false } } : {}),
      }),
    });
    if (res.ok) return { data: (await res.json()) as KevResponse, ms: Date.now() - t0, retries };
    const body = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      retries++;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`kev ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function runKevPass(
  rep: number,
  articles: GoldArticle[],
  persona: string[],
  apiKey: string,
  concurrency: number,
): Promise<PassResult> {
  const rows: Row[] = [];
  const raw: unknown[] = [];
  const latencies: number[] = [];
  let errors = 0;
  let retries = 0;
  let inputTokens = 0;
  let cost = 0;
  let next = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < articles.length) {
        const a = articles[next++];
        try {
          const { data, ms, retries: r } = await kevRequest(apiKey, kevState(a, persona));
          retries += r;
          if (kevProvider && data.provider !== kevProvider) throw new Error(`served by ${data.provider}, pinned ${kevProvider}`);
          latencies.push(ms);
          inputTokens += data.usage?.input_tokens ?? 0;
          cost += data.usage?.cost ?? 0;
          const ans = data.answers ?? {};
          const lv = LEVELS.length - 1;
          rows.push({
            articleId: a.articleId,
            scores: {
              'kev-score': (ans.score?.score ?? NaN) / lv,
              'kev-geo': (ans.geo?.score ?? NaN) / lv,
              'kev-noul': ans.feed?.noul ?? NaN,
            },
          });
          raw.push({ articleId: a.articleId, provider: data.provider, answers: ans });
        } catch (e) {
          errors++;
          raw.push({ articleId: a.articleId, error: String(e) });
        }
      }
    }),
  );
  if (retries) console.log(`  kev retries (429/5xx): ${retries}`); // eslint-disable-line no-console
  return {
    arm: 'kev',
    rep,
    rows,
    wallMs: Date.now() - t0,
    latencies,
    errors,
    truncated: 0,
    unscored: articles.length - rows.length,
    inputTokens,
    cost,
    raw,
  };
}

// --- metrics ----------------------------------------------------------------

const mean = (xs: number[]) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const fmt = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');

function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? NaN : num / Math.sqrt(dx * dy);
}

/** Average ranks, ties shared. */
function ranks(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) out[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}
const spearman = (xs: number[], ys: number[]) => pearson(ranks(xs), ranks(ys));

/** P(score of a random positive > a random negative), ties count half. */
function auc(pos: number[], neg: number[]): number {
  const r = ranks([...pos, ...neg]);
  const sumPos = r.slice(0, pos.length).reduce((a, b) => a + b, 0);
  return (sumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

interface Scored {
  score: number;
  verdict: GoldArticle['verdict'];
  jComp: number;
}

/** Closest ACHIEVABLE feed size to `target` (ties toward smaller): scores are
 *  heavily tied for the chat models, so n travels with the recall. */
function atSize(rows: Scored[], target: number): { n: number; recall: number; skip: number } {
  const ts = [...new Set(rows.map((r) => r.score))].sort((a, b) => b - a);
  let best = { n: 0, recall: 0, skip: 0 };
  let bestD = Infinity;
  for (const t of ts) {
    const inc = rows.filter((r) => r.score >= t);
    const d = Math.abs(inc.length - target);
    if (d < bestD) {
      bestD = d;
      best = {
        n: inc.length,
        recall: inc.filter((r) => r.verdict === 'must_show').length,
        skip: inc.filter((r) => r.verdict === 'skip').length,
      };
    }
  }
  return best;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// --- main -------------------------------------------------------------------

async function main(): Promise<number> {
  ensureLocalTestData();
  const argv = process.argv.slice(2);
  const arg = (f: string, d: string) => (argv.includes(f) ? (argv[argv.indexOf(f) + 1] ?? d) : d);
  const label = arg('--label', 'kev');
  kevBase = arg('--kev-url', REDPILL_BASE);
  kevProvider = arg('--kev-provider', '') || null;
  const kevKeyEnv = arg('--kev-key-env', 'REDPILL_API_KEY');
  const reps = Number(arg('--reps', '3'));
  const concurrency = Number(arg('--concurrency', '4'));
  const arms = arg('--arms', PASS_ARMS.join(',')).split(',') as PassArm[];
  const log = (s: string) => console.log(s); // eslint-disable-line no-console

  const fx = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'goldset-348.json'), 'utf8'),
  ) as Fixture;
  const limit = Number(arg('--limit', String(fx.articles.length)));
  const articles = fx.articles.slice(0, limit);
  const persona = fx.personaFacts.map((f) => f.statement);
  const gold = new Map(articles.map((a) => [a.articleId, a]));
  const mustShow = articles.filter((a) => a.verdict === 'must_show').length;

  const env = loadHarnessEnv();
  const redpillKey = process.env.REDPILL_API_KEY ?? '';
  if (!redpillKey && arms.includes('redpill-small')) throw new Error('REDPILL_API_KEY missing (harness-local/.env.harness)');
  const kevKey = process.env[kevKeyEnv];
  if (!kevKey && arms.includes('kev')) throw new Error(`${kevKeyEnv} missing (harness-local/.env.harness)`);

  const writer = createRunWriter({ label });
  writer.writeJson('config', {
    gitSha: captureGitSha(),
    smallModel: CFG.model,
    redpillSmallModel: REDPILL_SMALL_MODEL,
    kevModel: KEV_MODEL,
    kevBase,
    kevProvider,
    kevQuestions: KEV_QUESTIONS,
    primarySignal: 'kev-score',
    reps,
    concurrency,
    articles: articles.length,
    mustShow,
    articlesPerScorePrompt: CFG.articlesPerScorePrompt,
  });
  log(`articles ${articles.length} (${mustShow} must_show) | arms ${arms.join(',')} x${reps} | concurrency ${concurrency}`);
  log(`small model ${CFG.model} | run dir ${writer.dir}`);

  const passes: PassResult[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    // Rotate the order each round so no arm always runs first.
    const order = arms.map((_, i) => arms[(i + rep - 1) % arms.length]);
    for (const arm of order) {
      const p =
        arm === 'kev'
          ? await runKevPass(rep, articles, persona, kevKey as string, concurrency)
          : await runSmallPass(arm, rep, articles, persona, {
              apiKey: arm === 'near-small' ? env.nearAiApiKey : redpillKey,
              baseUrl: arm === 'near-small' ? env.nearAiBaseUrl : REDPILL_BASE,
              model: arm === 'near-small' ? CFG.model : REDPILL_SMALL_MODEL,
              concurrency,
            });
      passes.push(p);
      writer.writeJson(`scores-${arm}-${rep}`, p.rows);
      if (p.raw) writer.writeJson(`kev-raw-${rep}`, p.raw);
      log(
        `[${arm} #${rep}] wall ${fmt(p.wallMs / 1000, 1)}s  req p50 ${pct(p.latencies, 50)}ms p95 ${pct(p.latencies, 95)}ms  ` +
          `errors ${p.errors} truncated ${p.truncated} unscored ${p.unscored}`,
      );
    }
  }

  // --- accuracy, per signal per rep -------------------------------------------
  const signals: Signal[] = [];
  if (arms.includes('near-small')) signals.push('near-small');
  if (arms.includes('redpill-small')) signals.push('redpill-small');
  if (arms.includes('kev')) signals.push('kev-score', 'kev-geo', 'kev-noul');

  const scoredFor = (sig: Signal, rep: number): Scored[] => {
    const arm: PassArm = sig.startsWith('kev') ? 'kev' : (sig as PassArm);
    const p = passes.find((x) => x.arm === arm && x.rep === rep);
    return (p?.rows ?? [])
      .filter((r) => Number.isFinite(r.scores[sig]))
      .map((r) => {
        const g = gold.get(r.articleId) as GoldArticle;
        return { score: r.scores[sig] as number, verdict: g.verdict, jComp: g.jComp };
      });
  };
  const v1: Scored[] = articles.map((a) => ({ score: a.v1Relevance, verdict: a.verdict, jComp: a.jComp }));

  const summarize = (rows: Scored[]) => ({
    n: rows.length,
    pearson: pearson(rows.map((r) => r.score), rows.map((r) => r.jComp)),
    spearman: spearman(rows.map((r) => r.score), rows.map((r) => r.jComp)),
    aucMust: auc(
      rows.filter((r) => r.verdict === 'must_show').map((r) => r.score),
      rows.filter((r) => r.verdict !== 'must_show').map((r) => r.score),
    ),
    aucSkip: auc(
      rows.filter((r) => r.verdict !== 'skip').map((r) => r.score),
      rows.filter((r) => r.verdict === 'skip').map((r) => r.score),
    ),
    sizes: SIZE_GRID.map((g) => atSize(rows, g)),
    gate: (() => {
      const inc = rows.filter((r) => r.score >= RENDER_GATE);
      return {
        n: inc.length,
        recall: inc.filter((r) => r.verdict === 'must_show').length,
        skip: inc.filter((r) => r.verdict === 'skip').length,
      };
    })(),
  });

  const table: Record<string, ReturnType<typeof summarize>[]> = {};
  for (const s of signals) table[s] = Array.from({ length: reps }, (_, i) => summarize(scoredFor(s, i + 1)));
  table['v1-historic'] = [summarize(v1)];

  const avg = (xs: number[]) => fmt(mean(xs));
  log(`\n${'='.repeat(100)}\nACCURACY vs the blind-judged gold set (mean over reps; range in brackets)\n${'='.repeat(100)}`);
  log(`${'signal'.padEnd(15)}${'n'.padStart(5)}${'pearson'.padStart(10)}${'spearman'.padStart(10)}${'AUC must'.padStart(10)}${'AUC skip'.padStart(10)}   gate0.4 n/recall/skip`);
  for (const [s, v] of Object.entries(table)) {
    const p = v.map((x) => x.pearson);
    log(
      `${s.padEnd(15)}${String(v[0].n).padStart(5)}${avg(p).padStart(10)}${avg(v.map((x) => x.spearman)).padStart(10)}` +
        `${avg(v.map((x) => x.aucMust)).padStart(10)}${avg(v.map((x) => x.aucSkip)).padStart(10)}   ` +
        `${fmt(mean(v.map((x) => x.gate.n)), 0)}/${fmt(mean(v.map((x) => x.gate.recall)), 1)}/${fmt(mean(v.map((x) => x.gate.skip)), 0)}` +
        (v.length > 1 ? `   [pearson ${fmt(Math.min(...p))}..${fmt(Math.max(...p))}]` : ''),
    );
  }

  log(`\nMATCHED FEED SIZE — must_show recall (of ${mustShow}) / skip rows included, @ achieved n`);
  log(`${'signal'.padEnd(15)}${SIZE_GRID.map((g) => `n≈${g}`.padStart(16)).join('')}`);
  for (const [s, v] of Object.entries(table)) {
    log(
      s.padEnd(15) +
        SIZE_GRID.map((_, gi) => {
          const c = v.map((x) => x.sizes[gi]);
          return `${fmt(mean(c.map((x) => x.recall)), 1)}/${fmt(mean(c.map((x) => x.skip)), 0)}@${fmt(mean(c.map((x) => x.n)), 0)}`.padStart(16);
        }).join(''),
    );
  }
  log(`(v1-historic = the fixture's stored August prod scores: reference only, old prompt + model)`);

  // --- speed ------------------------------------------------------------------
  log(`\n${'='.repeat(100)}\nSPEED (from this laptop; NOT the app's gateway submit+poll path)\n${'='.repeat(100)}`);
  log(`${'arm'.padEnd(15)}${'req p50'.padStart(10)}${'req p95'.padStart(10)}${'art/req'.padStart(9)}${'wall all'.padStart(10)}${'art/s'.padStart(8)}${'in tok'.padStart(9)}${'errors'.padStart(8)}`);
  for (const arm of arms) {
    const ps = passes.filter((p) => p.arm === arm);
    const lat = ps.flatMap((p) => p.latencies);
    const wall = mean(ps.map((p) => p.wallMs));
    log(
      `${arm.padEnd(15)}${`${pct(lat, 50)}ms`.padStart(10)}${`${pct(lat, 95)}ms`.padStart(10)}` +
        `${String(arm === 'kev' ? 1 : CFG.articlesPerScorePrompt).padStart(9)}${`${fmt(wall / 1000, 1)}s`.padStart(10)}` +
        `${fmt(articles.length / (wall / 1000), 1).padStart(8)}${fmt(mean(ps.map((p) => p.inputTokens)), 0).padStart(9)}` +
        `${ps.map((p) => p.errors).join('/').padStart(8)}`,
    );
  }
  const kevCost = passes.filter((p) => p.arm === 'kev').map((p) => p.cost);
  if (kevCost.length) log(`kev cost per full pass: $${fmt(mean(kevCost), 5)}`);

  // Determinism check: kev reps must agree exactly to justify a single rep.
  const kevPasses = passes.filter((p) => p.arm === 'kev');
  if (kevPasses.length > 1) {
    const a = new Map(kevPasses[0].rows.map((r) => [r.articleId, r.scores['kev-score']]));
    const diff = kevPasses[1].rows.filter((r) => Math.abs((a.get(r.articleId) ?? NaN) - (r.scores['kev-score'] as number)) > 1e-6).length;
    log(`kev determinism: ${diff} of ${kevPasses[1].rows.length} kev-score values differ between rep 1 and rep 2`);
  }

  writer.finish({ table, speed: passes.map(({ raw: _r, rows: _rows, ...rest }) => rest) });
  return 0;
}

if (require.main === module) {
  main()
    .then((c) => process.exit(c))
    .catch((e) => {
      console.error(e); // eslint-disable-line no-console
      process.exit(1);
    });
}
