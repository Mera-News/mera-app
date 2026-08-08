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
  parseV3NoteResponse,
  isReasonGrounded,
  CLOUD_V3_NOTE_SYSTEM_PROMPT,
  buildReasonUserMessage,
  blendToScore,
  buildUserContext,
  resolveCountryName,
  chunk,
  // --- the LEGACY ("v1") path, so the v1 arms run the SHIPPED code ----------
  buildScoreCallForChunk,
  parseBatchRelevanceResponse,
  // The SHIPPED reason/note wiring — the exact builder the pipeline calls and
  // the exact keep/demote rules `applyV3NoteResults` now delegates to.
  buildReasonCallsForSubset,
  decodeV3NoteResults,
  type ScoringCandidate,
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

/** The RECOVERED gold set — the fixture that replaces all three paths above.
 *
 *  `matrix.json`, `persona_facts.json` and `v1.db` lived in the scratchpad
 *  named in SCRATCH, which has since been DELETED. Every default above is now
 *  a dead path, which is why the instrument had to be recovered before it
 *  could be re-run. `--goldset` loads the assembled rows and the persona
 *  straight from a tracked fixture and needs none of the three. */
const DEFAULT_GOLDSET = join(__dirname, '..', 'fixtures', 'goldset-348.json');

/**
 * v3 designs, plus the four LEGACY ("v1") arms added 2026-08-08 to answer
 * "can v1 be improved by adopting what v3 computes pre- or post-inference?".
 *
 * The four v1 arms are NOT four LLM runs. They are ONE legacy scoring pass
 * (CLOUD_RELEVANCE_SYSTEM_PROMPT, chunk 5, temp `scoreTemperature`) read through
 * different POST-INFERENCE treatments, so they are perfectly paired: the model
 * output is byte-identical across A0/A1/A2 and only deterministic code varies.
 * That is what makes the ablation attributable — a resampling interval between
 * them would be measuring nothing, because nothing stochastic differs.
 *
 *   v1-legacy      A0  stake-band clamp → bucketScores      (= what ships today)
 *   v1-unbucketed  A1  stake-band clamp, NO bucketScores    (C1: v3 persists continuously)
 *   v1-noband      A2  NO stake-band clamp, NO bucketScores (C3: v3 has no categorical ceiling)
 *   v1-note        A3  A1 + the v3 per-article keep/demote note pass (C2)
 */
type VariantName =
  | 'merged'
  | 'score-only'
  | 'split'
  | 'v1-legacy'
  | 'v1-unbucketed'
  | 'v1-noband'
  | 'v1-note';

const V1_VARIANTS: VariantName[] = ['v1-legacy', 'v1-unbucketed', 'v1-noband', 'v1-note'];
const isV1Variant = (v: VariantName): boolean => V1_VARIANTS.includes(v);

interface Args {
  label: string;
  matrix: string;
  facts: string;
  db: string;
  /** Tracked fixture holding the already-assembled gold rows + persona. When
   *  set, `matrix`/`facts`/`db` are not read at all. */
  goldset?: string;
  /** Gate the REPORT (and the acceptance bars) are computed at. */
  gate?: number;
  variants: VariantName[];
  limit?: number;
  dryRun: boolean;
  /** Experiment knob: override the pass-1 scoring temperature. The shipped
   *  value is 0.1, at which the score-only prompt degenerates structurally —
   *  it emits `{"i": 2": 78, "impact": 50}`, collapsing `"i": 2, "rel": 78`
   *  into one token run. Monotonous all-numeric output is where that happens;
   *  the merged prompt's prose appears to break the model out of it. */
  p1Temp?: number;
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
    else if (a === '--goldset') args.goldset = argv[++i] ?? DEFAULT_GOLDSET;
    else if (a === '--gate') args.gate = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--p1-temp') args.p1Temp = Number(argv[++i]);
    else if (a === '--variants') {
      const raw = (argv[++i] ?? '').split(',').map((s) => s.trim());
      const known: string[] = ['merged', 'score-only', 'split', ...V1_VARIANTS];
      const ok = raw.filter((s): s is VariantName => known.includes(s));
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

/** Shape of `harness-local/fixtures/goldset-348.json`. */
interface GoldsetFixture {
  _provenance: {
    name: string;
    articleCount: number;
    mustShowTotal: number;
    persona: { recoveredFrom: string };
    [k: string]: unknown;
  };
  personaFacts: PersonaFact[];
  articles: GoldArticle[];
}

/**
 * Load the recovered gold set: rows AND persona, from one tracked file.
 *
 * The persona is the part that can silently rot. It was recovered by splitting
 * a RENDERED `User Context:` header back into statements, and that split is
 * lossy in principle — the `[User facts] ` prefix, the `'. '` joiner and the
 * trailing period are a formatting contract, not decoration. If the recovered
 * facts do not rebuild that header BYTE-FOR-BYTE, the run is a NEW experiment
 * with a slightly different prompt rather than a comparison against the
 * baseline this fixture is adjudicated on. So it is asserted, loudly, on every
 * run rather than eyeballed once.
 */
function loadGoldset(path: string): {
  articles: GoldArticle[];
  personaFacts: PersonaFact[];
  userContext: string;
  provenance: GoldsetFixture['_provenance'];
} {
  const fx = readJson<GoldsetFixture>(path);
  if (!Array.isArray(fx.articles) || fx.articles.length === 0) {
    throw new Error(`score-v3-goldset: ${path} has no articles`);
  }
  if (!Array.isArray(fx.personaFacts) || fx.personaFacts.length === 0) {
    throw new Error(`score-v3-goldset: ${path} has no personaFacts`);
  }
  if (fx.articles.length !== fx._provenance.articleCount) {
    throw new Error(
      `score-v3-goldset: ${path} claims ${fx._provenance.articleCount} articles but holds ` +
        `${fx.articles.length} — the fixture has been edited without updating its provenance.`,
    );
  }
  const mustShow = fx.articles.filter((a) => a.verdict === 'must_show').length;
  if (mustShow !== fx._provenance.mustShowTotal) {
    throw new Error(
      `score-v3-goldset: ${path} claims ${fx._provenance.mustShowTotal} must_show but holds ` +
        `${mustShow} — labels have moved. The gold set is FROZEN; re-adjudicate explicitly.`,
    );
  }
  const statements = fx.personaFacts.map((f) => f.statement);
  const userContext = buildUserContext(statements);
  const expected = `[User facts] ${statements.join('. ')}.`;
  if (userContext !== expected) {
    throw new Error(
      'score-v3-goldset: the recovered persona does not round-trip through buildUserContext ' +
        `byte-for-byte.\n  built:    ${userContext}\n  expected: ${expected}\n` +
        'Refusing to run — a near-miss persona is a different prompt, and its numbers are not ' +
        'comparable to the baseline this fixture is adjudicated against.',
    );
  }
  return { articles: fx.articles, personaFacts: fx.personaFacts, userContext, provenance: fx._provenance };
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

// --- Variant (b): the score-only prompt ------------------------------------
//
// This USED to be derived by string surgery over CLOUD_SCORE_V3_SYSTEM_PROMPT,
// because that prompt asked for a conditional user-facing `why` and the
// experiment needed a copy that did not. The experiment settled it: 4.9% of
// those notes described a different article than the one they sat on, so v3
// pass 1 stopped asking for prose at all. The shipped prompt IS the score-only
// prompt now, and carving is no longer meaningful.
//
// The assertion stays, inverted: if a `why` contract ever reappears in pass 1,
// this run must stop rather than silently measure a design nobody chose.
function deriveScoreOnlyPrompt(): string {
  const p = CLOUD_SCORE_V3_SYSTEM_PROMPT;
  const reintroduced = ['(0.65 × rel) + (0.35 × impact)', '25 words or fewer'].filter((m) =>
    p.includes(m),
  );
  if (reintroduced.length > 0) {
    throw new Error(
      'score-v3-goldset: CLOUD_SCORE_V3_SYSTEM_PROMPT asks for a user-facing sentence again ' +
        `(${reintroduced.join(', ')}). Pass 1 is score-only by design — see CLOUD_V3_NOTE_SYSTEM_PROMPT.`,
    );
  }
  return p;
}

/** The trailer the SHIPPED v3 user message ends with. Pass 1 asks for three
 *  keys and no prose, so every variant now sends the same message — the old
 *  swap that carved `"why"?` out of it has nothing left to carve. */
const TRAILER_SCORE_ONLY = '({"i","rel","impact"})';

function buildUserMessage(
  _variant: VariantName,
  userContext: string,
  articles: { title: string; description: string; country?: string; relatedFacts?: string[] }[],
): string {
  const msg = buildBatchScoringUserMessage({ userContext, articles, v3: true });
  if (!msg.includes(TRAILER_SCORE_ONLY)) {
    throw new Error(
      'score-v3-goldset: the score-only trailer is missing from the built user message — ' +
        'buildBatchScoringUserMessage has drifted.',
    );
  }
  return msg;
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
  /** Carried so the grounding metric compares against title + description, the
   *  same pair the app checks. Measuring on the title alone overstates the flag
   *  rate badly — 11.3% vs 6.5% on the first run that had this bug. */
  description: string;
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
  /** Rewritten in place by `runSplitPass2` for the 'split' variant. */
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
  scoreTemp: number = CFG.scoreTemperature,
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
      temperature: scoreTemp,
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
        description: a.description,
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

// --- The LEGACY ("v1") arms -------------------------------------------------
//
// ONE scoring pass, three post-inference readings. See the VariantName comment.
//
// The shipped decode (`parseBatchRelevanceResponse`) throws away two things this
// experiment needs to see: the stake TAG the model emitted, and the score it
// emitted BEFORE `clampToStakeBand` moved it. So the raw array is extracted here
// as well, and the shipped decoder is still called for A0/A1 so those arms are
// byte-identical to production rather than a re-implementation of it.

/** One article's raw legacy output, before any clamping. `k` is the stake tag
 *  (`home`/`family`/`travel`/`domain`/`attend`/`interest`/`none`), `s` the
 *  model's own float. Both null when the chunk had to be regex-salvaged. */
interface LegacyRawEntry {
  k: string | null;
  s: number | null;
}

/**
 * Extract `{"k","s"}` (or bare float) entries from a legacy batch response
 * WITHOUT clamping. Returns null when the output is not a well-formed array of
 * the expected length — in that case the arms all fall back to the shipped
 * decoder's value, so an unparseable chunk can never manufacture a difference
 * between arms.
 */
function parseLegacyRawEntries(output: string, expectedCount: number): LegacyRawEntry[] | null {
  const trimmed = output.trim();
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedCount) return null;
  return parsed.map((v): LegacyRawEntry => {
    if (typeof v === 'number') return { k: null, s: v };
    if (v && typeof v === 'object') {
      const o = v as { k?: unknown; s?: unknown };
      return {
        k: typeof o.k === 'string' ? o.k : null,
        s: typeof o.s === 'number' ? o.s : null,
      };
    }
    return { k: null, s: null };
  });
}

/** `bucketScores` for ONE value — the same thresholds, without needing a Map. */
function bucketOne(raw: number): number {
  if (raw < CFG.discardFloor) return raw;
  if (raw > CFG.emergencyPriorityCutoff) return CFG.emergencyPriorityScore;
  if (raw >= CFG.highPriorityCutoff) return CFG.highPriorityScore;
  if (raw >= CFG.mediumPriorityCutoff) return CFG.mediumPriorityScore;
  return CFG.lowPriorityScore;
}

/** Per-article record the three A0/A1/A2 readings are projected from. */
interface LegacyScoredRow {
  article: GoldArticle;
  /** Shipped decode: stake-band clamped, pre-bucket. */
  clamped: number;
  /** Model's own float, clamped only to [0, 1.1]. Falls back to `clamped`. */
  unbanded: number;
  tag: string | null;
  /** True when the stake band actually MOVED the score — the measurement C3
   *  stands or falls on. */
  bandBit: boolean;
}

interface LegacyPassResult {
  rows: LegacyScoredRow[];
  unscored: string[];
  chunkAttempts: number;
  salvagedChunks: number;
  llmCalls: LlmCallRecord[];
}

async function runLegacyPass(
  articles: GoldArticle[],
  userContext: string,
  llm: ReturnType<typeof createNearAiLlm>,
  llmCalls: LlmCallRecord[],
): Promise<LegacyPassResult> {
  const chunks = chunk(articles, CFG.articlesPerScorePrompt);
  const calls: BatchCall[] = chunks.map((chunkArticles, idx) => {
    const { prompt, system } = buildScoreCallForChunk(
      chunkArticles.map(toScoringCandidate),
      // The FULL fact bank, exactly as `buildRelevanceCalls` sends it in the app.
      personaStatements,
      CFG.relevanceSystemPrompt,
    );
    // buildScoreCallForChunk derives the user context from the fact bank; assert
    // it produced the same header the fixture round-trips on, so a legacy arm
    // can never be scored against a different persona than the v3 arms.
    if (!prompt.includes(userContext)) {
      throw new Error(
        'score-v3-goldset: the legacy user message does not carry the fixture user context — ' +
          'buildScoreCallForChunk and buildUserContext have drifted apart.',
      );
    }
    return {
      id: `v1:chunk-${idx}`,
      system,
      prompt,
      temperature: CFG.scoreTemperature,
      maxTokens: CFG.scoreBatchMaxTokens,
    };
  });

  const results = await llm.batchComplete(calls, { model: CFG.model });
  const byId = new Map(results.map((r) => [r.id, r]));

  const rows: LegacyScoredRow[] = [];
  const unscored: string[] = [];
  let salvagedChunks = 0;

  chunks.forEach((chunkArticles, idx) => {
    const res = byId.get(`v1:chunk-${idx}`);
    if (!res || res.error) {
      chunkArticles.forEach((a) => unscored.push(a.articleId));
      return;
    }
    // The SHIPPED decoder — not a re-implementation. A0/A1 must be production.
    const clamped = parseBatchRelevanceResponse(
      res.output,
      chunkArticles.length,
      `v1:chunk-${idx}`,
      undefined,
      CFG,
      consoleLogger,
    );
    const raw = parseLegacyRawEntries(res.output, chunkArticles.length);
    if (!raw) salvagedChunks += 1;
    chunkArticles.forEach((a, i) => {
      const entry = raw?.[i];
      const modelS = entry && typeof entry.s === 'number' ? entry.s : null;
      const unbanded = modelS == null ? clamped[i] : Math.max(0, Math.min(1.1, modelS));
      rows.push({
        article: a,
        clamped: clamped[i],
        unbanded,
        tag: entry?.k ?? null,
        bandBit: modelS != null && Math.abs(unbanded - clamped[i]) > 1e-9,
      });
    });
  });

  return { rows, unscored, chunkAttempts: calls.length, salvagedChunks, llmCalls };
}

/** Project the shared legacy pass onto one arm's post-inference treatment. */
function projectLegacyVariant(variant: VariantName, pass: LegacyPassResult): VariantResult {
  const score = (r: LegacyScoredRow): number => {
    if (variant === 'v1-legacy') return bucketOne(r.clamped);
    if (variant === 'v1-noband') return r.unbanded;
    return r.clamped; // v1-unbucketed and v1-note both start here
  };
  return {
    variant,
    systemPrompt: CFG.relevanceSystemPrompt,
    rows: pass.rows.map((r) => ({
      articleId: r.article.articleId,
      title: r.article.title,
      description: r.article.description,
      // The legacy prompt emits ONE axis. `rel`/`impact` do not exist on this
      // path and are recorded as the score itself rather than invented, so a
      // reader of scores-*.json cannot mistake them for a two-axis decomposition.
      rel: score(r) * 100,
      impact: score(r) * 100,
      blend: score(r),
      why: null,
      jComp: r.article.jComp,
      verdict: r.article.verdict,
      factless: r.article.relatedFacts.length === 0,
    })),
    unscored: pass.unscored,
    chunkAttempts: pass.chunkAttempts,
    parseNullChunks: pass.salvagedChunks,
    retriedChunks: 0,
    truncatedCalls: pass.llmCalls.filter((c) => c.finishReason === 'length').length,
    errorCalls: pass.llmCalls.filter((c) => c.error).length,
    llmCalls: pass.llmCalls,
  };
}

/** The gold row → `ScoringCandidate` adapter the legacy builders need. */
function toScoringCandidate(a: GoldArticle): ScoringCandidate {
  return {
    id: a.articleId,
    titleEn: a.title,
    descriptionEn: a.description,
    countryCode: a.countryCode,
    userTopicIds: [],
    relatedFacts: a.relatedFacts.map((statement, i) => ({
      id: `${a.articleId}:f${i}`,
      statement,
    })),
  };
}

/** Set by main() before `runLegacyPass` — the fact bank the app would send. */
let personaStatements: string[] = [];

/**
 * The C2 note/demote pass, run through the SHIPPED wiring rather than a
 * look-alike.
 *
 * Everything decision-bearing here is app code:
 *   - `buildReasonCallsForSubset(..., v3)` is the same builder
 *     `scoring-pipeline::submitNeedsReasons` calls, so the subset predicate, the
 *     one-article-per-call shape, the system prompt (`v3NoteSystemPrompt` vs
 *     `reasonSystemPrompt`) and the token ceiling are the shipped ones;
 *   - `decodeV3NoteResults` is the same decode `applyV3NoteResults` delegates
 *     to, so keep / demote / fail-open are decided identically.
 * Only the PERSISTENCE differs — the pipeline writes rows, this writes a map.
 *
 * COST HONESTY: the flag-OFF arm's calls are BUILT (so their count is exact and
 * comparable) and deliberately NOT executed. The legacy reason prompt only emits
 * prose, and `decodeCloudBatchResults` routes that to `reasonMap` — it cannot
 * move a score. Spending ~100 provider calls to observe a no-op would measure
 * nothing; the call COUNT is the only thing that arm contributes, and building
 * is enough to report it exactly.
 */
async function runShippedNotePass(
  rows: ScoredRow[],
  articleById: Map<string, GoldArticle>,
  llm: ReturnType<typeof createNearAiLlm>,
): Promise<{
  rows: ScoredRow[];
  demoted: number;
  kept: number;
  unusable: number;
  callsOn: number;
  callsOff: number;
}> {
  const candidates = rows
    .map((r) => articleById.get(r.articleId))
    .filter((a): a is GoldArticle => a != null)
    .map(toScoringCandidate);
  const relevanceMap: Record<string, number> = {};
  for (const r of rows) relevanceMap[r.articleId] = r.blend;

  // Flag OFF — built only, to pin the call count (see the doc comment).
  const off = buildReasonCallsForSubset(
    candidates,
    relevanceMap,
    CFG.reasonRelevanceThreshold,
    personaStatements,
    CFG,
    consoleLogger,
    false,
  );
  // Flag ON — the arm that actually runs.
  const on = buildReasonCallsForSubset(
    candidates,
    relevanceMap,
    CFG.reasonRelevanceThreshold,
    personaStatements,
    CFG,
    consoleLogger,
    true,
  );

  if (on.calls[0] && on.calls[0].system !== CFG.v3NoteSystemPrompt) {
    throw new Error(
      'score-v3-goldset: the flag-ON arm is not sending v3NoteSystemPrompt — ' +
        'buildReasonCallsForSubset has drifted and this is no longer a measurement of the shipped path.',
    );
  }

  const results = await llm.batchComplete(on.calls, { model: CFG.model });
  const { demoteIds, reasons, unusableIds } = decodeV3NoteResults(
    results.map((r) => ({ id: r.id, output: r.output ?? '', error: r.error })),
  );

  const demoteSet = new Set(demoteIds);
  const out = rows.map((r) => {
    if (demoteSet.has(r.articleId)) {
      return { ...r, blend: CFG.feedVerifierDemoteScore, why: null };
    }
    const why = reasons.get(r.articleId);
    return why ? { ...r, why } : r;
  });

  return {
    rows: out,
    demoted: demoteIds.length,
    kept: reasons.size,
    unusable: unusableIds.length,
    callsOn: on.calls.length,
    callsOff: off.calls.length,
  };
}

// --- Variant (c): the SPLIT design -----------------------------------------
//
// Pass 1 is the derived score-only prompt above (same batching, same chunk
// size). Pass 2 visits ONE article per call and does two jobs at once: decide
// whether the story really carries a stake, and — if so — write the sentence.
//
// WHY ONE ARTICLE PER CALL. The merged design's failure is not a parser bug and
// not an indexing bug. Replaying this same gold set showed the model returning a
// well-formed array with "i" = 1,2,3,4,5, in input order, while the PROSE in the
// tail slots belonged to neighbouring articles — an "Apple removes Telegram over
// CSAM" note on the AI-companies article and vice versa, an F1 note on an
// AI-agents article, an Amsterdam-drought note on an Anthropic funding story.
// The model emits the right index with the wrong sentence, so no index scheme —
// not "i", not an opaque echoed token — can detect it. Only removing the
// neighbours from the context does. (The on-device path already reached this
// conclusion independently: LOCAL_ARTICLES_PER_SCORE_PROMPT is 1 because
// "per-article attention still wins for calibration".)
//
// The precision half reuses CLOUD_FEED_VERIFIER_SYSTEM_PROMPT verbatim rather
// than inventing new demote rules: its NO-patterns were validated against the
// golden 1000-article run (FEED precision 73.2% -> 80.4%), and v3 dropped that
// pass entirely when it merged everything into one call. Only the output
// contract is replaced, since the verifier's own is written for a batch.
// Pass 2 uses the SHIPPED prompt, not a local copy — the point of this run is
// to measure what the app actually sends.
const SPLIT_PASS2_SYSTEM = CLOUD_V3_NOTE_SYSTEM_PROMPT;

/** Kept as a thin alias so the call sites below read the same as before; the
 *  decode itself is the shipped one. */
function parseSplitPass2(output: string): { keep: boolean; why: string | null } | null {
  return parseV3NoteResponse(output);
}

/**
 * Run pass 2 over the rows pass 1 put at or above the gate. Rows below it are
 * returned untouched and noteless — they are not rendered, so a note for them is
 * spend with no reader. That is also where the split earns back some of its
 * cost: pass 1 gets its `why` budget back, and pass 2 only visits the minority
 * of articles that reached the feed.
 */
async function runSplitPass2(
  rows: ScoredRow[],
  articleById: Map<string, GoldArticle>,
  userContext: string,
  llm: ReturnType<typeof createNearAiLlm>,
): Promise<{ rows: ScoredRow[]; demoted: number; unusable: number }> {
  const eligible = rows.filter((r) => r.blend >= CFG.discardFloor);
  const calls: BatchCall[] = eligible.map((r) => {
    const a = articleById.get(r.articleId);
    return {
      id: `split:pass2:${r.articleId}`,
      system: SPLIT_PASS2_SYSTEM,
      prompt: buildReasonUserMessage({
        userContext,
        articleTitle: r.title,
        articleDescription: r.description,
        articleCountry: resolveCountryName(a?.countryCode ?? null),
        relevance: r.blend,
        relatedFacts: a?.relatedFacts ?? [],
      }),
      temperature: CFG.reasonTemperature,
      // Room for the sentence plus the tiny JSON wrapper. The merged design gave
      // each article ~128 tokens for BOTH its numbers and its prose.
      maxTokens: CFG.reasonMaxTokens + 32,
    };
  });

  const results = await llm.batchComplete(calls, { model: CFG.model });
  const byId = new Map<string, { keep: boolean; why: string | null }>();
  let unusable = 0;
  results.forEach((res, k) => {
    const verdict = parseSplitPass2(res.output ?? '');
    if (!verdict) {
      unusable++;
      return;
    }
    byId.set(eligible[k].articleId, verdict);
  });

  let demoted = 0;
  const out = rows.map((r) => {
    const verdict = byId.get(r.articleId);
    // Fail open: no verdict ⇒ the pass-1 score stands and the row owes a note,
    // exactly as a failed reason call behaves in the app today.
    if (!verdict) return r;
    if (!verdict.keep) {
      demoted++;
      return { ...r, blend: CFG.feedVerifierDemoteScore, why: null };
    }
    return { ...r, why: verdict.why };
  });
  return { rows: out, demoted, unusable };
}

// --- Reporting --------------------------------------------------------------

/** The gate the REPORT is computed at. Defaults to `discardFloor` (0.4) for
 *  continuity with the 2026-08-05/06 artifacts, and is overridable with
 *  `--gate` so the bars can be read at the SHIPPED v3 render gate
 *  (`V3_RENDER_GATE` = 0.55, lib/stores/fact-rows-selector.ts). Reporting at
 *  0.4 while the app renders at 0.55 measures a configuration nobody ships.
 *
 *  This is the REPORTING gate only. Pass-2 eligibility (line ~509) stays on
 *  `CFG.discardFloor`, because that is the scoring pipeline's own discard
 *  floor and does not move with the render gate. */
let GATE = CFG.discardFloor; // 0.4 — the inclusive render gate
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
  /** Max 0.1-bucket share over the TOP-`ACCEPTANCE_TARGET_N` rows by score.
   *
   *  `maxIncludedBucketShare` is measured over each arm's own gate, so arms with
   *  different gates (v1 renders at 0.4, v3 at 0.55) are read over different-sized
   *  populations and a spread comparison between them is not like-for-like. This
   *  is the same statistic at ONE matched feed size, which is the number the
   *  cross-arm claim has to be made on. Diagnostic only — `acceptance()` is
   *  untouched and still reads the gated version. */
  maxBucketShareTopN: number;
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
    /** Emitted notes that share NO content token with their own article — the
     *  measurement the original merged-vs-two-pass A/B never took. It compared
     *  ranking quality (r) only, so a design that scores well while attaching
     *  sentences to the wrong articles would have passed that gate silently,
     *  which is exactly what shipped. Any non-zero value here is a defect the
     *  correlation numbers cannot see. */
    ungroundedWhy: number;
    /** Denominator for the above: notes actually emitted, at any score. */
    whyTotal: number;
    /** Up to 5 offenders, so a non-zero count can be read rather than trusted. */
    ungroundedSamples: { title: string; why: string; blend: number }[];
  } | null;
  cutoffFor130: { cutoff: number; n: number; recall: number } | null;
}

/**
 * v1's OWN must_show recall — the number this script has never computed.
 *
 * Without it the sentence "v3 recall X vs v1 Y" has no provenance: the script
 * only ever reported v1 as a single Pearson r, so every recall comparison in
 * the record came from a different instrument (the on-device two-sim A/B) on a
 * different article set. This computes both sides on the SAME rows and the
 * SAME labels.
 *
 * v1's scores are QUANTISED — 25 distinct values over 348 rows, with 89 rows
 * tied at 0.6 and 25 tied at exactly 0.4. So "top 130" is not well defined:
 * you cannot take 130 of a 41-way tie. The equivalent-size point is therefore
 * the smallest threshold whose included set is closest to the target n, and the
 * ACHIEVABLE n is reported next to it. Recall at a bigger feed is not
 * comparable recall, so the n always travels with the number.
 */
interface V1Metrics {
  /** Pearson(v1_relevance, j_comp) over every row that has a v1 score. */
  pearson: number;
  n: number;
  mustShowTotal: number;
  /** At v1's own shipped inclusive render gate (RENDER_GATE = 0.4). */
  atOwnGate: { gate: number; n: number; recall: number; skipShare: number };
  /** Closest achievable feed size to `targetN`, and the recall there. */
  atTargetSize: { targetN: number; cutoff: number; n: number; recall: number };
  /** Full sweep, so the tie structure is readable rather than trusted. */
  sweep: { threshold: number; n: number; recall: number }[];
}

function computeV1Metrics(
  articles: GoldArticle[],
  mustShowTotal: number,
  ownGate: number,
  targetN: number,
): V1Metrics | null {
  const rows = articles.filter((a) => typeof a.v1Relevance === 'number');
  if (rows.length === 0) return null;
  const score = (a: GoldArticle) => a.v1Relevance as number;

  const thresholds = [...new Set(rows.map(score))].sort((a, b) => b - a);
  const at = (t: number) => {
    const inc = rows.filter((a) => score(a) >= t);
    return {
      threshold: t,
      n: inc.length,
      recall: inc.filter((a) => a.verdict === 'must_show').length,
      skipShare: pct(inc.filter((a) => a.verdict === 'skip').length, inc.length),
    };
  };
  const sweep = thresholds.map(at);

  const own = at(ownGate);
  // Closest achievable n to the target; ties in |n - target| break toward the
  // SMALLER feed, so v1 is never flattered by a bigger one.
  const best = sweep.reduce((a, b) => {
    const da = Math.abs(a.n - targetN);
    const db = Math.abs(b.n - targetN);
    return db < da || (db === da && b.n < a.n) ? b : a;
  });

  return {
    pearson: pearson(rows.map(score), rows.map((a) => a.jComp)),
    n: rows.length,
    mustShowTotal,
    atOwnGate: { gate: ownGate, n: own.n, recall: own.recall, skipShare: own.skipShare },
    atTargetSize: { targetN, cutoff: best.threshold, n: best.n, recall: best.recall },
    sweep: sweep.map((s) => ({ threshold: s.threshold, n: s.n, recall: s.recall })),
  };
}

function printV1(m: V1Metrics): void {
  const log = (s: string) => console.log(s); // eslint-disable-line no-console
  log(`\n================ BASELINE: v1 (shipped legacy scorer) ================`);
  log(`Pearson r (v1_relevance vs j_comp) = ${fmt(m.pearson)} over n=${m.n}   [script expects ~0.63]`);
  log(
    `at v1's own gate (>= ${m.atOwnGate.gate}): n=${m.atOwnGate.n}, ` +
      `must_show recall ${m.atOwnGate.recall}/${m.mustShowTotal}, judge-skip ${fmt(m.atOwnGate.skipShare, 1)}%`,
  );
  log(
    `at equivalent feed size (target n=${m.atTargetSize.targetN}): cutoff >= ${m.atTargetSize.cutoff}, ` +
      `n=${m.atTargetSize.n}, must_show recall ${m.atTargetSize.recall}/${m.mustShowTotal}`,
  );
  log(`-- v1 threshold sweep (scores are quantised; the ties are the point) --`);
  for (const s of m.sweep) {
    log(`  >= ${s.threshold.toFixed(2)}  n=${String(s.n).padStart(4)}  recall ${s.recall}/${m.mustShowTotal}`);
  }
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

  // Same statistic at a MATCHED feed size, so arms gated differently are still
  // comparable. Ties at the cutoff are kept (a quantised arm cannot be cut
  // mid-tie), so `topN.length` can exceed the target — reported, not hidden.
  const sortedDesc = [...rows].sort((a, b) => b.blend - a.blend);
  const cutN = sortedDesc[Math.min(sortedDesc.length, ACCEPTANCE_TARGET_N) - 1]?.blend ?? 0;
  const topN = rows.filter((r) => r.blend >= cutN);
  const topNCounts = new Map<string, number>();
  for (const r of topN) topNCounts.set(bucketLabel(r.blend), (topNCounts.get(bucketLabel(r.blend)) ?? 0) + 1);
  const maxBucketShareTopN = Math.max(
    0,
    ...[...topNCounts.values()].map((c) => pct(c, topN.length)),
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
    res.variant === 'merged' || res.variant === 'split'
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
          ...(() => {
            const withWhy = rows.filter((r) => r.why);
            const ungrounded = withWhy.filter(
              (r) => !isReasonGrounded(r.why, { title: r.title, description: r.description }),
            );
            return {
              ungroundedWhy: ungrounded.length,
              whyTotal: withWhy.length,
              ungroundedSamples: ungrounded.slice(0, 5).map((r) => ({
                title: r.title.slice(0, 90),
                why: (r.why ?? '').slice(0, 120),
                blend: r.blend,
              })),
            };
          })(),
        }
      : null;

  // Diagnostic only (advisor note 6): if n > 130 at the 0.4 gate, what cutoff
  // gives n = 130 and what does recall cost there? The gate itself does not move.
  let cutoffFor130: VariantMetrics['cutoffFor130'] = null;
  if (included.length > ACCEPTANCE_TARGET_N) {
    const sorted = [...rows].sort((a, b) => b.blend - a.blend);
    const cutoff = sorted[ACCEPTANCE_TARGET_N - 1].blend;
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
    maxBucketShareTopN,
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
  log(`max single-bucket share @ top-${ACCEPTANCE_TARGET_N} (matched size): ${fmt(m.maxBucketShareTopN, 1)}%`);

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
    // The measurement the original A/B never took. Ranking correlation is blind
    // to it: a note can describe a completely different article while the two
    // numbers beside it are perfectly calibrated.
    log(
      `notes about ANOTHER article : ${m.reasons.ungroundedWhy}/${m.reasons.whyTotal} ` +
        `(${fmt(pct(m.reasons.ungroundedWhy, m.reasons.whyTotal), 1)}%) — shares no content token with its own article`,
    );
    for (const s of m.reasons.ungroundedSamples) {
      log(`   [${fmt(s.blend)}] ${s.title}`);
      log(`        ↳ ${s.why}`);
    }
  }
}

interface AcceptanceCheck {
  bar: string;
  pass: boolean;
  observed: string;
}

/** The feed size bar 1 is stated at. Shared with the v1 comparison so both
 *  sides are read at the same size. */
const ACCEPTANCE_TARGET_N = 130;

function acceptance(m: VariantMetrics): AcceptanceCheck[] {
  // BAR 1 — EVALUATION POINT, pinned in the pre-registration BEFORE this run.
  //
  // The bar as encoded is a CONJUNCTION: `mustShowRecall >= 29 && gate.n <= 130`.
  // Read that way it fails MECHANICALLY at any gate admitting more than 130 rows
  // — for v1 and v3 alike, and independently of quality. Taken at its own word,
  // though, the bar says "recall >= 29/37 **at n <= 130**": it is a statement
  // about recall AT that feed size, and the script already computes exactly that
  // construction in `cutoffFor130` (code that predates this run). So when the
  // gate admits more than 130, the bar is read at that cutoff; when the gate
  // already admits <= 130, the gate itself IS the n <= 130 point.
  //
  // The bar TEXT is unchanged. Only the point it is measured at is pinned.
  const at =
    m.gate.n > ACCEPTANCE_TARGET_N && m.cutoffFor130
      ? { n: m.cutoffFor130.n, recall: m.cutoffFor130.recall, where: `top-n cutoff >= ${fmt(m.cutoffFor130.cutoff)}` }
      : { n: m.gate.n, recall: m.gate.mustShowRecall, where: `at the gate` };
  return [
    {
      bar: 'recall >= 29/37 at n <= 130',
      pass: at.recall >= 29 && at.n <= ACCEPTANCE_TARGET_N,
      observed: `recall ${at.recall}/${m.gate.mustShowTotal}, n=${at.n} (${at.where})`,
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

  if (typeof args.gate === 'number' && Number.isFinite(args.gate)) GATE = args.gate;

  // --- Load the gold set. ---
  const missingText: string[] = [];
  const factless: string[] = [];
  const articles: GoldArticle[] = [];
  let personaFacts: PersonaFact[];
  let goldProvenance: unknown = null;

  if (args.goldset) {
    const g = loadGoldset(args.goldset);
    articles.push(...g.articles);
    personaFacts = g.personaFacts;
    goldProvenance = g.provenance;
    log(`Gold set loaded from FIXTURE ${args.goldset} (persona round-trip: byte-exact)`);
    for (const a of articles) if (a.relatedFacts.length === 0) factless.push(a.articleId);
  } else {
  const matrix = readJson<MatrixRow[]>(args.matrix);
  personaFacts = readJson<PersonaFact[]>(args.facts);
  const { text, facts } = loadFromDb(args.db);

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
  }
  const scoped =
    typeof args.limit === 'number' && !Number.isNaN(args.limit)
      ? articles.slice(0, args.limit)
      : articles;

  const mustShowTotal = scoped.filter((a) => a.verdict === 'must_show').length;
  const userContext = buildUserContext(personaFacts.map((f) => f.statement));

  // --- Baseline: the shipped v1 correlation AND, new here, v1's own recall. ---
  const v1Rows = scoped.filter((a) => typeof a.v1Relevance === 'number');
  const v1Corr = pearson(
    v1Rows.map((a) => a.v1Relevance as number),
    v1Rows.map((a) => a.jComp),
  );
  // v1's own inclusive render gate is 0.4 (RENDER_GATE, lib/stores/fact-rows-selector.ts)
  // and does NOT move with the v3 gate — that is the whole point of the per-row
  // mitigation. So it is pinned here rather than read off `GATE`.
  const V1_OWN_GATE = 0.4;
  const v1Metrics = computeV1Metrics(scoped, mustShowTotal, V1_OWN_GATE, ACCEPTANCE_TARGET_N);

  const scoreOnlyPrompt = deriveScoreOnlyPrompt();

  const writer = createRunWriter({ label: args.label });
  writer.writeJson('config', {
    target: env.target,
    model: CFG.model,
    gitSha: captureGitSha(),
    goldset: args.goldset ?? null,
    goldsetProvenance: goldProvenance,
    matrix: args.goldset ? null : args.matrix,
    facts: args.goldset ? null : args.facts,
    db: args.goldset ? null : args.db,
    variants: args.variants,
    articlesPerScorePrompt: CFG.articlesPerScorePrompt,
    scoreTemperature: CFG.scoreTemperature,
    v3ScoreBatchMaxTokens: CFG.v3ScoreBatchMaxTokens,
    reportGate: GATE,
    pipelineDiscardFloor: CFG.discardFloor,
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
  log(`Report gate = ${GATE} (pipeline discard floor stays ${CFG.discardFloor})`);
  if (v1Metrics) printV1(v1Metrics);
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

  // --- The LEGACY ("v1") arms: ONE pass, several post-inference readings. ----
  //
  // Run before the v3 arms and OUTSIDE the per-variant loop on purpose. A0/A1/A2
  // must share one set of model outputs — re-scoring per arm would reintroduce
  // sampling noise into an ablation whose whole point is that only deterministic
  // code varies between arms.
  const requestedV1 = args.variants.filter(isV1Variant);
  if (requestedV1.length > 0) {
    personaStatements = personaFacts.map((f) => f.statement);
    const started = Date.now();
    const v1Calls: LlmCallRecord[] = [];
    log(
      `\n[v1] ONE legacy scoring pass over ${scoped.length} articles ` +
        `(chunk ${CFG.articlesPerScorePrompt}, temp ${CFG.scoreTemperature}) → ` +
        `arms: ${requestedV1.join(', ')}`,
    );
    const pass = await runLegacyPass(scoped, userContext, llmFactory(v1Calls), v1Calls);
    log(
      `[v1] pass done in ${Math.round((Date.now() - started) / 1000)}s — ` +
        `${pass.rows.length} scored, ${pass.unscored.length} unscored, ` +
        `${pass.chunkAttempts} calls, ${pass.salvagedChunks} chunks regex-salvaged`,
    );

    // The C3 pre-check. Whether removing the categorical stake-band ceiling can
    // possibly help is a question about the model's RAW output, and it is
    // answered here for free rather than inferred from the arm's score.
    const moved = pass.rows.filter((r) => r.bandBit);
    const tagCounts = new Map<string, number>();
    for (const r of pass.rows) tagCounts.set(r.tag ?? '(unparsed)', (tagCounts.get(r.tag ?? '(unparsed)') ?? 0) + 1);
    log(`\n-- STAKE-BAND DIAGNOSTIC (C3 pre-check) --`);
    log(`stake tags emitted: ${[...tagCounts.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    log(
      `rows the band clamp MOVED: ${moved.length}/${pass.rows.length} ` +
        `(${fmt(pct(moved.length, pass.rows.length), 1)}%)`,
    );
    const movedDown = moved.filter((r) => r.unbanded > r.clamped);
    const movedDownMustShow = movedDown.filter((r) => r.article.verdict === 'must_show');
    log(
      `  of which clamped DOWNWARD: ${movedDown.length} ` +
        `(${movedDownMustShow.length} of them must_show)`,
    );
    log(
      `  downward-clamped rows the ceiling pushed BELOW the 0.4 gate: ` +
        `${movedDown.filter((r) => r.unbanded >= 0.4 && r.clamped < 0.4).length} ` +
        `(${movedDown.filter((r) => r.unbanded >= 0.4 && r.clamped < 0.4 && r.article.verdict === 'must_show').length} must_show)`,
    );
    for (const r of movedDown.slice(0, 6)) {
      log(`   k=${r.tag} model s=${fmt(r.unbanded)} → clamped ${fmt(r.clamped)}  [${r.article.verdict}] ${r.article.title.slice(0, 70)}`);
    }
    writer.writeJson('v1-legacy-raw', pass.rows.map((r) => ({
      articleId: r.article.articleId,
      tag: r.tag,
      modelScore: r.unbanded,
      clamped: r.clamped,
      bucketed: bucketOne(r.clamped),
      bandMoved: r.bandBit,
      verdict: r.article.verdict,
      jComp: r.article.jComp,
      frozenV1: r.article.v1Relevance,
    })));
    writer.writeJson('llm-calls-v1', v1Calls);

    for (const variant of requestedV1) {
      const res = projectLegacyVariant(variant, pass);
      if (variant === 'v1-note') {
        // C2 through the SHIPPED wiring — `buildReasonCallsForSubset` +
        // `decodeV3NoteResults`, i.e. the same builder and the same rules the
        // pipeline runs. The 2026-08-08 first pass measured a hand-rolled
        // look-alike; this re-measures the code that actually ships.
        const p2Started = Date.now();
        const articleById = new Map(scoped.map((a) => [a.articleId, a]));
        const p2Calls: LlmCallRecord[] = [];
        const pass2 = await runShippedNotePass(res.rows, articleById, llmFactory(p2Calls));
        res.rows = pass2.rows;
        res.llmCalls = [...res.llmCalls, ...p2Calls];
        log(
          `[${variant}] SHIPPED note/demote pass in ${Math.round((Date.now() - p2Started) / 1000)}s — ` +
            `flag ON built ${pass2.callsOn} calls, flag OFF would build ${pass2.callsOff} ` +
            `(delta ${pass2.callsOn - pass2.callsOff}); ` +
            `${pass2.demoted} demoted, ${pass2.kept} captioned, ${pass2.unusable} unusable`,
        );
        if (pass2.callsOn !== pass2.callsOff) {
          log(
            `[${variant}] WARNING: the flag CHANGES the call count. "Zero net calls" was the ` +
              `whole basis for this candidate — report the delta, do not bury it.`,
          );
        }
      }
      writer.writeJson(`scores-${variant}`, res.rows);
      results.push(res);
    }
  }

  for (const variant of args.variants.filter((v) => !isV1Variant(v))) {
    const started = Date.now();
    log(`\n[${variant}] scoring ${scoped.length} articles…`);
    const res = await scoreVariant(
      variant,
      variant === 'merged' ? CLOUD_SCORE_V3_SYSTEM_PROMPT : scoreOnlyPrompt,
      scoped,
      userContext,
      llmFactory,
      args.p1Temp ?? CFG.v3ScoreTemperature,
    );
    log(
      `[${variant}] done in ${Math.round((Date.now() - started) / 1000)}s — ` +
        `${res.rows.length} scored, ${res.unscored.length} unscored, ` +
        `${res.chunkAttempts} calls, ${res.parseNullChunks} parse-nulls, ` +
        `${res.truncatedCalls} truncated, ${res.errorCalls} errors`,
    );
    if (variant === 'split') {
      const p2Started = Date.now();
      const articleById = new Map(scoped.map((a) => [a.articleId, a]));
      const p2Calls: LlmCallRecord[] = [];
      const pass2 = await runSplitPass2(
        res.rows,
        articleById,
        userContext,
        llmFactory(p2Calls),
      );
      res.rows = pass2.rows;
      res.llmCalls = [...res.llmCalls, ...p2Calls];
      log(
        `[${variant}] pass 2 done in ${Math.round((Date.now() - p2Started) / 1000)}s — ` +
          `${p2Calls.length} per-article calls, ${pass2.demoted} demoted, ` +
          `${pass2.unusable} unusable (kept pass-1 score)`,
      );
    }
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

  // --- The head-to-head the decision rule is read off. ---
  if (v1Metrics) {
    log(`\n================ v3 vs v1 HEAD-TO-HEAD (report gate ${GATE}) ================`);
    log(`pearson  v1 = ${fmt(v1Metrics.pearson)}`);
    for (const m of metrics) {
      log(
        `pearson  ${m.variant.padEnd(10)} = ${fmt(m.pearson)}   ` +
          `(v3 - v1 = ${m.pearson - v1Metrics.pearson >= 0 ? '+' : ''}${fmt(m.pearson - v1Metrics.pearson)})`,
      );
    }
    log(
      `recall @ n~${ACCEPTANCE_TARGET_N}: v1 ${v1Metrics.atTargetSize.recall}/${mustShowTotal} (n=${v1Metrics.atTargetSize.n})`,
    );
    for (const m of metrics) {
      const pt = m.gate.n > ACCEPTANCE_TARGET_N && m.cutoffFor130 ? m.cutoffFor130 : { n: m.gate.n, recall: m.gate.mustShowRecall };
      log(`recall @ n~${ACCEPTANCE_TARGET_N}: ${m.variant} ${pt.recall}/${mustShowTotal} (n=${pt.n})`);
    }
    log(
      `recall @ own gate  : v1 ${v1Metrics.atOwnGate.recall}/${mustShowTotal} (n=${v1Metrics.atOwnGate.n}, gate ${v1Metrics.atOwnGate.gate})`,
    );
    for (const m of metrics) {
      log(`recall @ own gate  : ${m.variant} ${m.gate.mustShowRecall}/${mustShowTotal} (n=${m.gate.n}, gate ${GATE})`);
    }
  }

  writer.finish({
    reportGate: GATE,
    baselineV1Pearson: v1Corr,
    baselineV1N: v1Rows.length,
    v1: v1Metrics,
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
