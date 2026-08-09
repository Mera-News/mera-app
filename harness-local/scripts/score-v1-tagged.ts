// PHASE 2 of the tag-salvage experiment: does adding a compact structured TAG
// BLOCK to the LEGACY v1 pass-1 batch prompt improve what the legacy path ranks?
//
//   npx tsx harness-local/scripts/score-v1-tagged.ts --label p2 \
//     [--baselines 3] [--variants 3] [--goldset <path>] [--dry-run]
//
// WHAT THIS IS *NOT*
// ------------------
// It is NOT the (since-deleted) `USE_ARTICLE_TAGS: true`. That flag fed the same
// three columns to the ENGINE; at the time it also routed a tagged candidate to the
// deterministic math + judge path, because `isBackstop()` keys off exactly the
// triple `tag-policy.ts` strips, and the tagger emits an `event_type` on ~100% of
// rows. Flipping it measures v3, which is not the question.
//
// harness-local drives `DEFAULT_HARNESS_CONFIG` directly and never goes through
// `stage-scoring::buildStageCandidates` — the one seam the blanking used to be
// applied at. THAT is why this script can show tags to the PROMPT while leaving
// routing, chunk size and the pass-2 contract exactly as the legacy path has
// them. Nothing under `lib/` is touched.
//
// INVARIANTS (asserted at runtime, not just intended)
//   - chunk size stays `articlesPerScorePrompt` (5)
//   - system prompt stays `CFG.relevanceSystemPrompt` (the legacy one)
//   - temperature stays `CFG.scoreTemperature`, budget `CFG.scoreBatchMaxTokens`
//   - decoding stays the SHIPPED `parseBatchRelevanceResponse`
//   - stripping the injected metadata lines back out MUST reproduce
//     `buildScoreCallForChunk`'s prompt BYTE-FOR-BYTE, or the run aborts
//   - pass 2 is not run at all: the legacy reason prompt only writes prose and
//     cannot move a score, so recall depends on pass 1 alone
//
// Local-only: harness-local is excluded from tsconfig, jest and EAS bundling.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessEnv } from '../config/env';
import { ensureLocalTestData } from '../config/local-data';
import { createNearAiLlm, type LlmCallRecord } from '../adapters/nearai-llm';
import { consoleLogger } from '../adapters/console-logger';
import { createRunWriter, captureGitSha } from '../lib/run-writer';
import {
  DEFAULT_HARNESS_CONFIG,
  buildScoreCallForChunk,
  parseBatchRelevanceResponse,
  buildUserContext,
  chunk,
  type ScoringCandidate,
  type BatchCall,
} from '../../lib/news-harness';

const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

/**
 * The three arms.
 *
 * `shuffled` is the CONTROL that decides whether any measured gain is the
 * INFORMATION in the tags or merely the extra ~14% of prompt text and the extra
 * structure. It rotates the metadata lines by one WITHIN each chunk, so every
 * article gets a neighbour's metadata: identical format, near-identical token
 * count, signal destroyed. Without it, "tags help" and "a longer, more
 * structured prompt helps" are indistinguishable, and the second would be a
 * much cheaper thing to ship than a tagging pipeline.
 */
type Arm = 'baseline' | 'tagged' | 'shuffled';
const RENDER_GATE = 0.4; // v1's own inclusive render gate
const TARGET_N = 130; // the matched feed size the primary metric is read at

// --- fixture ----------------------------------------------------------------

interface GeoTag {
  city?: string;
  region?: string;
  countryCode: string;
}

interface TaggedArticle {
  articleId: string;
  title: string;
  description: string;
  countryCode: string | null;
  relatedFacts: string[];
  jComp: number;
  verdict: 'must_show' | 'nice_to_have' | 'skip';
  v1Relevance: number | null;
  geoTags: GeoTag[];
  entities: string[];
  eventType: string | null;
}

interface Fixture {
  _provenance: {
    articleCount: number;
    mustShowTotal: number;
    [k: string]: unknown;
  };
  personaFacts: { statement: string }[];
  articles: TaggedArticle[];
}

/** Same assertions `score-v3-goldset::loadGoldset` makes — the fixture is frozen,
 *  and a near-miss persona is a different prompt. */
function loadTagged(path: string): Fixture {
  const fx = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
  if (fx.articles.length !== fx._provenance.articleCount) {
    throw new Error(`score-v1-tagged: ${path} article count does not match its provenance`);
  }
  const ms = fx.articles.filter((a) => a.verdict === 'must_show').length;
  if (ms !== fx._provenance.mustShowTotal) {
    throw new Error(`score-v1-tagged: ${path} must_show total moved — the gold set is FROZEN`);
  }
  const statements = fx.personaFacts.map((f) => f.statement);
  const expected = `[User facts] ${statements.join('. ')}.`;
  if (buildUserContext(statements) !== expected) {
    throw new Error('score-v1-tagged: persona does not round-trip through buildUserContext');
  }
  if (fx.articles.some((a) => a.eventType === undefined)) {
    throw new Error('score-v1-tagged: fixture has no tags — run tag-goldset.ts first');
  }
  return fx;
}

function toCandidate(a: TaggedArticle): ScoringCandidate {
  return {
    id: a.articleId,
    titleEn: a.title,
    descriptionEn: a.description,
    countryCode: a.countryCode,
    userTopicIds: [],
    relatedFacts: a.relatedFacts.map((statement, i) => ({ id: `${a.articleId}:f${i}`, statement })),
  };
}

// --- the injection ----------------------------------------------------------

/**
 * One compact line of server metadata, appended to an article's existing block.
 *
 * Deliberately terse: the pass-1 output budget is `scoreBatchMaxTokens` (80) for
 * five articles, so an input that grows too fast risks truncation, and a
 * truncated chunk falls back to regex salvage — which would make the arms
 * unpaired rather than merely worse. Empty fields are omitted rather than sent
 * as "none": a tagged-but-place-less article is common (49.7% of this corpus)
 * and telling the model "places: none" five times a chunk is pure noise.
 *
 * Returns '' when the row carries nothing worth saying, which is also what a
 * never-tagged production row would produce.
 */
function metadataLine(a: TaggedArticle): string {
  const parts: string[] = [];
  if (a.geoTags.length > 0) {
    const places = a.geoTags
      .map((g) => [g.city, g.region, g.countryCode].filter(Boolean).join(', '))
      .join(' | ');
    parts.push(`places: ${places}`);
  }
  if (a.entities.length > 0) parts.push(`entities: ${a.entities.join(', ')}`);
  // 'other' is the enum's mandatory fallback and carries no information; the
  // degraded path emits it too. Sending it would be indistinguishable from a
  // real classification.
  if (a.eventType && a.eventType !== 'other') parts.push(`event: ${a.eventType}`);
  return parts.length === 0 ? '' : `Article Metadata: ${parts.join(' | ')}`;
}

const META_PREFIX = 'Article Metadata: ';

/**
 * Build the tag-injected user message for one chunk, by taking the SHIPPED
 * prompt and inserting one metadata line per article block.
 *
 * The inverse is asserted: deleting every `Article Metadata: ` line must return
 * the shipped prompt byte-for-byte. Without that check this script measures
 * "the shipped prompt plus whatever my string surgery did", which is a different
 * experiment with the same name.
 */
function injectMetadata(shippedPrompt: string, metaSource: TaggedArticle[]): string {
  const chunkArticles = metaSource;
  const lines = shippedPrompt.split('\n');
  const out: string[] = [];
  let seen = -1;
  for (const line of lines) {
    out.push(line);
    if (/^===== Article \d+ =====$/.test(line)) seen += 1;
    // The block's last line is `Related User Fact: ...`; the metadata line goes
    // directly after it, so the model reads the article, then its facts, then
    // the server's structured view of the same article.
    if (line.startsWith('Related User Fact: ') && seen >= 0 && seen < chunkArticles.length) {
      const meta = metadataLine(chunkArticles[seen]);
      if (meta) out.push(meta);
    }
  }
  const injected = out.join('\n');
  const stripped = injected
    .split('\n')
    .filter((l) => !l.startsWith(META_PREFIX))
    .join('\n');
  if (stripped !== shippedPrompt) {
    throw new Error(
      'score-v1-tagged: the injected prompt does not strip back to the shipped prompt ' +
        'byte-for-byte. Refusing to run — this would measure the surgery, not the tags.',
    );
  }
  return injected;
}

// --- one pass ---------------------------------------------------------------

interface PassRow {
  articleId: string;
  title: string;
  score: number; // the SHIPPED decode: stake-band clamped, pre-bucket
  jComp: number;
  verdict: TaggedArticle['verdict'];
  tagBearing: boolean;
}

interface PassResult {
  arm: Arm;
  replicate: number;
  rows: PassRow[];
  unscored: string[];
  chunkAttempts: number;
  salvagedChunks: number;
  truncatedCalls: number;
  errorCalls: number;
  promptChars: number;
}

/** A row "carries tags" when the metadata line would say something. */
function isTagBearing(a: TaggedArticle): boolean {
  return metadataLine(a).length > 0;
}

async function runPass(
  arm: Arm,
  replicate: number,
  articles: TaggedArticle[],
  personaStatements: string[],
  llm: ReturnType<typeof createNearAiLlm>,
  sink: LlmCallRecord[],
): Promise<PassResult> {
  const chunks = chunk(articles, CFG.articlesPerScorePrompt);
  let promptChars = 0;
  const calls: BatchCall[] = chunks.map((chunkArticles, idx) => {
    const { prompt, system } = buildScoreCallForChunk(
      chunkArticles.map(toCandidate),
      personaStatements,
      CFG.relevanceSystemPrompt,
    );
    if (system !== CFG.relevanceSystemPrompt) {
      throw new Error('score-v1-tagged: system prompt is not the legacy one');
    }
    const metaSource =
      arm === 'tagged'
        ? chunkArticles
        : arm === 'shuffled'
          ? chunkArticles.map((_, i) => chunkArticles[(i + 1) % chunkArticles.length])
          : null;
    const finalPrompt = metaSource ? injectMetadata(prompt, metaSource) : prompt;
    promptChars += finalPrompt.length;
    return {
      id: `${arm}:${replicate}:chunk-${idx}`,
      system,
      prompt: finalPrompt,
      temperature: CFG.scoreTemperature,
      maxTokens: CFG.scoreBatchMaxTokens,
    };
  });

  const results = await llm.batchComplete(calls, { model: CFG.model });
  const byId = new Map(results.map((r) => [r.id, r]));

  const rows: PassRow[] = [];
  const unscored: string[] = [];
  let salvaged = 0;

  chunks.forEach((chunkArticles, idx) => {
    const res = byId.get(`${arm}:${replicate}:chunk-${idx}`);
    if (!res || res.error) {
      chunkArticles.forEach((a) => unscored.push(a.articleId));
      return;
    }
    // Detect regex salvage the same way score-v3-goldset does: a well-formed
    // array of the expected length parses; anything else was salvaged.
    const m = (res.output ?? '').trim().match(/\[[\s\S]*\]/);
    let wellFormed = false;
    if (m) {
      try {
        const p: unknown = JSON.parse(m[0]);
        wellFormed = Array.isArray(p) && p.length === chunkArticles.length;
      } catch {
        wellFormed = false;
      }
    }
    if (!wellFormed) salvaged += 1;

    const scores = parseBatchRelevanceResponse(
      res.output,
      chunkArticles.length,
      `${arm}:${replicate}:chunk-${idx}`,
      undefined,
      CFG,
      consoleLogger,
    );
    chunkArticles.forEach((a, i) => {
      rows.push({
        articleId: a.articleId,
        title: a.title,
        score: scores[i],
        jComp: a.jComp,
        verdict: a.verdict,
        tagBearing: isTagBearing(a),
      });
    });
  });

  return {
    arm,
    replicate,
    rows,
    unscored,
    chunkAttempts: calls.length,
    salvagedChunks: salvaged,
    truncatedCalls: sink.filter((c) => c.finishReason === 'length').length,
    errorCalls: sink.filter((c) => c.error).length,
    promptChars,
  };
}

// --- metrics ----------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? NaN : num / Math.sqrt(dx * dy);
}

interface PassMetrics {
  arm: string;
  replicate: number;
  n: number;
  pearson: number;
  /** At v1's own inclusive render gate (0.4) — the population that renders. */
  gate: { n: number; recall: number; skipShare: number; meanJComp: number };
  /**
   * Recall at a MATCHED feed size, computed on THIS arm's own fresh scores.
   *
   * `computeV1Metrics.atTargetSize` in score-v3-goldset reads the FROZEN
   * `v1Relevance` column, and `computeMetrics.cutoffFor130` only fires when the
   * gate already admits >130 rows (a fresh v1 arm admits ~109, so it is always
   * null). Neither is usable here, so the construction is repeated on fresh
   * scores: the smallest threshold whose included set is closest to `TARGET_N`,
   * ties broken toward the SMALLER feed. v1's scores are heavily tied, so the
   * achievable n ALWAYS travels with the recall.
   */
  atTargetSize: { targetN: number; cutoff: number; n: number; recall: number };
  salvagedChunks: number;
  truncatedCalls: number;
  errorCalls: number;
  unscored: number;
  meanPromptChars: number;
}

function computePassMetrics(p: PassResult, mustShowTotal: number): PassMetrics {
  const rows = p.rows;
  const inc = rows.filter((r) => r.score >= RENDER_GATE);
  const thresholds = [...new Set(rows.map((r) => r.score))].sort((a, b) => b - a);
  const at = (t: number) => {
    const s = rows.filter((r) => r.score >= t);
    return { threshold: t, n: s.length, recall: s.filter((r) => r.verdict === 'must_show').length };
  };
  const sweep = thresholds.map(at);
  const best = sweep.reduce((a, b) => {
    const da = Math.abs(a.n - TARGET_N);
    const db = Math.abs(b.n - TARGET_N);
    return db < da || (db === da && b.n < a.n) ? b : a;
  });
  return {
    arm: p.arm,
    replicate: p.replicate,
    n: rows.length,
    pearson: pearson(
      rows.map((r) => r.score),
      rows.map((r) => r.jComp),
    ),
    gate: {
      n: inc.length,
      recall: inc.filter((r) => r.verdict === 'must_show').length,
      skipShare: inc.length === 0 ? NaN : (100 * inc.filter((r) => r.verdict === 'skip').length) / inc.length,
      meanJComp: mean(inc.map((r) => r.jComp)),
    },
    atTargetSize: { targetN: TARGET_N, cutoff: best.threshold, n: best.n, recall: best.recall },
    salvagedChunks: p.salvagedChunks,
    truncatedCalls: p.truncatedCalls,
    errorCalls: p.errorCalls,
    unscored: p.unscored.length,
    meanPromptChars: Math.round(p.promptChars / p.chunkAttempts),
  };
}

const fmt = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');

// --- main -------------------------------------------------------------------

async function main(): Promise<number> {
  ensureLocalTestData();
  const argv = process.argv.slice(2);
  const arg = (flag: string, dflt: string) =>
    argv.includes(flag) ? (argv[argv.indexOf(flag) + 1] ?? dflt) : dflt;
  const label = arg('--label', 'v1-tagged');
  const nBaseline = Number(arg('--baselines', '3'));
  const nTagged = Number(arg('--variants', '3'));
  const nShuffled = Number(arg('--shuffled', '0'));
  const goldsetPath = arg('--goldset', join(__dirname, '..', 'fixtures', 'goldset-348-tagged.json'));
  const dryRun = argv.includes('--dry-run');
  const log = (s: string) => console.log(s); // eslint-disable-line no-console

  const fx = loadTagged(goldsetPath);
  const articles = fx.articles;
  const personaStatements = fx.personaFacts.map((f) => f.statement);
  const mustShowTotal = articles.filter((a) => a.verdict === 'must_show').length;
  const tagBearing = articles.filter(isTagBearing);

  const writer = createRunWriter({ label });
  log(`gold set     : ${goldsetPath}`);
  log(`articles     : ${articles.length} (${mustShowTotal} must_show)`);
  log(`tag-bearing  : ${tagBearing.length} (${((100 * tagBearing.length) / articles.length).toFixed(1)}%) ` +
      `— rows whose metadata line says something`);
  log(`chunk size   : ${CFG.articlesPerScorePrompt} → ${Math.ceil(articles.length / CFG.articlesPerScorePrompt)} calls/pass`);
  log(`arms         : baseline x${nBaseline}, tagged x${nTagged}, shuffled-control x${nShuffled} = ` +
      `${(nBaseline + nTagged + nShuffled) * Math.ceil(articles.length / CFG.articlesPerScorePrompt)} LLM calls`);
  log(`model        : ${CFG.model}, temp ${CFG.scoreTemperature}, maxTokens ${CFG.scoreBatchMaxTokens}`);
  log(`run dir      : ${writer.dir}`);

  // Dump one sample of each arm so the injection is inspectable.
  const sampleChunk = articles.slice(0, CFG.articlesPerScorePrompt);
  const { prompt: samplePrompt } = buildScoreCallForChunk(
    sampleChunk.map(toCandidate),
    personaStatements,
    CFG.relevanceSystemPrompt,
  );
  writeFileSync(join(writer.dir, 'sample-user-message-baseline.txt'), samplePrompt, 'utf8');
  writeFileSync(
    join(writer.dir, 'sample-user-message-tagged.txt'),
    injectMetadata(samplePrompt, sampleChunk),
    'utf8',
  );
  writer.writeJson('config', {
    gitSha: captureGitSha(),
    goldset: goldsetPath,
    model: CFG.model,
    articlesPerScorePrompt: CFG.articlesPerScorePrompt,
    scoreTemperature: CFG.scoreTemperature,
    scoreBatchMaxTokens: CFG.scoreBatchMaxTokens,
    systemPrompt: 'CFG.relevanceSystemPrompt (LEGACY — no judge routing, no v3)',
    renderGate: RENDER_GATE,
    targetN: TARGET_N,
    baselines: nBaseline,
    variants: nTagged,
    shuffledControl: nShuffled,
    articleCount: articles.length,
    mustShowTotal,
    tagBearingCount: tagBearing.length,
  });

  if (dryRun) {
    log('\n--dry-run: sample prompts written, no provider calls made.');
    log('\n--- tagged sample (first chunk) ---\n');
    log(injectMetadata(samplePrompt, sampleChunk));
    return 0;
  }

  const env = loadHarnessEnv();
  const passes: PassResult[] = [];
  const metrics: PassMetrics[] = [];

  // Baselines FIRST and all of them, so the noise band exists before the
  // variant is looked at.
  const plan: { arm: Arm; rep: number }[] = [
    ...Array.from({ length: nBaseline }, (_, i) => ({ arm: 'baseline' as const, rep: i + 1 })),
    ...Array.from({ length: nTagged }, (_, i) => ({ arm: 'tagged' as const, rep: i + 1 })),
    ...Array.from({ length: nShuffled }, (_, i) => ({ arm: 'shuffled' as const, rep: i + 1 })),
  ];

  for (const step of plan) {
    const sink: LlmCallRecord[] = [];
    const llm = createNearAiLlm({
      apiKey: env.nearAiApiKey,
      baseUrl: env.nearAiBaseUrl,
      defaultModel: CFG.model,
      onCall: (rec) => sink.push(rec),
    });
    const started = Date.now();
    const p = await runPass(step.arm, step.rep, articles, personaStatements, llm, sink);
    passes.push(p);
    const m = computePassMetrics(p, mustShowTotal);
    metrics.push(m);
    writer.writeJson(`scores-${step.arm}-${step.rep}`, p.rows);
    log(
      `\n[${step.arm} #${step.rep}] ${Math.round((Date.now() - started) / 1000)}s — ` +
        `r=${fmt(m.pearson)}  gate n=${m.gate.n} recall ${m.gate.recall}/${mustShowTotal}  ` +
        `@n≈${TARGET_N}: cutoff ${fmt(m.atTargetSize.cutoff, 2)} n=${m.atTargetSize.n} ` +
        `recall ${m.atTargetSize.recall}/${mustShowTotal}  | salvaged ${m.salvagedChunks} ` +
        `truncated ${m.truncatedCalls} errors ${m.errorCalls} unscored ${m.unscored} ` +
        `| ${m.meanPromptChars} chars/call`,
    );
  }

  // --- report ---------------------------------------------------------------
  const bl = metrics.filter((m) => m.arm === 'baseline');
  const tg = metrics.filter((m) => m.arm === 'tagged');
  const sh = metrics.filter((m) => m.arm === 'shuffled');
  const band = (xs: number[]) =>
    `${fmt(Math.min(...xs))}..${fmt(Math.max(...xs))} (mean ${fmt(mean(xs))}, spread ${fmt(Math.max(...xs) - Math.min(...xs))})`;
  const bandI = (xs: number[]) =>
    `${Math.min(...xs)}..${Math.max(...xs)} (mean ${fmt(mean(xs), 1)}, spread ${Math.max(...xs) - Math.min(...xs)})`;

  log(`\n${'='.repeat(100)}`);
  log('IN-RUN NOISE BAND (established from the baseline replicates alone)');
  log('='.repeat(100));
  log(`Pearson r          baseline ${band(bl.map((m) => m.pearson))}`);
  log(`recall @ gate 0.4  baseline ${bandI(bl.map((m) => m.gate.recall))}   (feed n ${bandI(bl.map((m) => m.gate.n))})`);
  log(`recall @ n≈${TARGET_N}     baseline ${bandI(bl.map((m) => m.atTargetSize.recall))}   (achievable n ${bandI(bl.map((m) => m.atTargetSize.n))})`);

  log(`\n${'='.repeat(100)}`);
  log('VARIANT vs BASELINE');
  log('='.repeat(100));
  log(`Pearson r          tagged   ${band(tg.map((m) => m.pearson))}`);
  log(`  Δ mean           ${fmt(mean(tg.map((m) => m.pearson)) - mean(bl.map((m) => m.pearson)))}`);
  log(`recall @ gate 0.4  tagged   ${bandI(tg.map((m) => m.gate.recall))}   (feed n ${bandI(tg.map((m) => m.gate.n))})`);
  log(`  Δ mean           ${fmt(mean(tg.map((m) => m.gate.recall)) - mean(bl.map((m) => m.gate.recall)), 2)}`);
  log(`recall @ n≈${TARGET_N}     tagged   ${bandI(tg.map((m) => m.atTargetSize.recall))}   (achievable n ${bandI(tg.map((m) => m.atTargetSize.n))})`);
  log(`  Δ mean           ${fmt(mean(tg.map((m) => m.atTargetSize.recall)) - mean(bl.map((m) => m.atTargetSize.recall)), 2)}`);
  log(`judge-skip @ gate  baseline ${band(bl.map((m) => m.gate.skipShare))}  tagged ${band(tg.map((m) => m.gate.skipShare))}`);

  if (sh.length > 0) {
    log(`\n-- CONTROL: SHUFFLED metadata (same text, wrong article) --`);
    log(`Pearson r          shuffled ${band(sh.map((m) => m.pearson))}`);
    log(`  Δ vs baseline    ${fmt(mean(sh.map((m) => m.pearson)) - mean(bl.map((m) => m.pearson)))}`);
    log(`  Δ tagged−shuffled ${fmt(mean(tg.map((m) => m.pearson)) - mean(sh.map((m) => m.pearson)))}`);
    log(`recall @ gate 0.4  shuffled ${bandI(sh.map((m) => m.gate.recall))}   (feed n ${bandI(sh.map((m) => m.gate.n))})`);
    log(`recall @ n≈${TARGET_N}     shuffled ${bandI(sh.map((m) => m.atTargetSize.recall))}   (achievable n ${bandI(sh.map((m) => m.atTargetSize.n))})`);
    log(`salvaged/truncated shuffled ${sh.map((m) => m.salvagedChunks).join('/')} , ${sh.map((m) => m.truncatedCalls).join('/')}`);
  }

  log(`\n-- VALIDITY (the arms are only paired if these match) --`);
  log(`salvaged chunks    baseline ${bl.map((m) => m.salvagedChunks).join('/')}   tagged ${tg.map((m) => m.salvagedChunks).join('/')}`);
  log(`truncated calls    baseline ${bl.map((m) => m.truncatedCalls).join('/')}   tagged ${tg.map((m) => m.truncatedCalls).join('/')}`);
  log(`error calls        baseline ${bl.map((m) => m.errorCalls).join('/')}   tagged ${tg.map((m) => m.errorCalls).join('/')}`);
  log(`unscored rows      baseline ${bl.map((m) => m.unscored).join('/')}   tagged ${tg.map((m) => m.unscored).join('/')}`);
  log(`prompt chars/call  baseline ${bl[0]?.meanPromptChars}   tagged ${tg[0]?.meanPromptChars} ` +
      `(+${(((tg[0]?.meanPromptChars ?? 0) / (bl[0]?.meanPromptChars ?? 1) - 1) * 100).toFixed(1)}%)`);

  // --- per-article paired deltas -------------------------------------------
  const avgByArm = (arm: Arm) => {
    const acc = new Map<string, number[]>();
    for (const p of passes.filter((x) => x.arm === arm))
      for (const r of p.rows) acc.set(r.articleId, [...(acc.get(r.articleId) ?? []), r.score]);
    return new Map([...acc].map(([k, v]) => [k, mean(v)]));
  };
  const a0 = avgByArm('baseline');
  const a1 = avgByArm('tagged');
  const meta = new Map(articles.map((a) => [a.articleId, a]));
  const deltas = [...a0.keys()]
    .filter((k) => a1.has(k))
    .map((k) => ({
      id: k,
      base: a0.get(k) as number,
      tag: a1.get(k) as number,
      d: (a1.get(k) as number) - (a0.get(k) as number),
      art: meta.get(k) as TaggedArticle,
    }));
  writer.writeJson('paired-deltas', deltas.map((d) => ({
    articleId: d.id, baselineMean: d.base, taggedMean: d.tag, delta: d.d,
    verdict: d.art.verdict, jComp: d.art.jComp, tagBearing: isTagBearing(d.art),
  })));

  const moved = deltas.filter((d) => Math.abs(d.d) > 1e-9);
  log(`\n-- PAIRED PER-ARTICLE DELTAS (mean of ${nTagged} tagged − mean of ${nBaseline} baseline) --`);
  log(`rows that moved at all : ${moved.length}/${deltas.length}`);
  log(`mean Δ (all rows)      : ${fmt(mean(deltas.map((d) => d.d)))}`);
  log(`mean Δ (must_show)     : ${fmt(mean(deltas.filter((d) => d.art.verdict === 'must_show').map((d) => d.d)))}`);
  log(`mean Δ (judge skip)    : ${fmt(mean(deltas.filter((d) => d.art.verdict === 'skip').map((d) => d.d)))}`);
  log(`separation (must_show − skip) : ${fmt(
    mean(deltas.filter((d) => d.art.verdict === 'must_show').map((d) => d.d)) -
      mean(deltas.filter((d) => d.art.verdict === 'skip').map((d) => d.d)),
  )}  [>0 means tags helped the ranking]`);

  // --- the tag-bearing subset ----------------------------------------------
  const subMetrics = (only: (a: TaggedArticle) => boolean, name: string) => {
    const per = (arm: Arm) =>
      passes
        .filter((p) => p.arm === arm)
        .map((p) => {
          const rows = p.rows.filter((r) => only(meta.get(r.articleId) as TaggedArticle));
          const inc = rows.filter((r) => r.score >= RENDER_GATE);
          return {
            r: pearson(rows.map((x) => x.score), rows.map((x) => x.jComp)),
            recall: inc.filter((x) => x.verdict === 'must_show').length,
            ms: rows.filter((x) => x.verdict === 'must_show').length,
            n: inc.length,
          };
        });
    const b = per('baseline');
    const t = per('tagged');
    log(`\n-- ${name} (n=${articles.filter(only).length}, must_show ${b[0]?.ms}) --`);
    log(`  Pearson r        baseline ${band(b.map((x) => x.r))}   tagged ${band(t.map((x) => x.r))}   Δ ${fmt(mean(t.map((x) => x.r)) - mean(b.map((x) => x.r)))}`);
    log(`  recall @ 0.4     baseline ${bandI(b.map((x) => x.recall))}   tagged ${bandI(t.map((x) => x.recall))}   Δ ${fmt(mean(t.map((x) => x.recall)) - mean(b.map((x) => x.recall)), 2)}`);
    log(`  feed n @ 0.4     baseline ${bandI(b.map((x) => x.n))}   tagged ${bandI(t.map((x) => x.n))}`);
  };
  subMetrics(isTagBearing, 'TAG-BEARING SUBSET — the undiluted effect');
  subMetrics((a) => !isTagBearing(a), 'UNTAGGED SUBSET — should be unchanged apart from noise');
  // `entities` + a non-'other' `event_type` cover ~99% of rows, so the
  // tag-bearing subset is almost the whole corpus and is a weak discriminator.
  // `geo_tags` is the field that is genuinely present-or-absent (50.3%) AND the
  // one that can contradict the prompt's existing `Article Country` line, which
  // is the publisher's country, not the story's. That contrast is the most
  // plausible mechanism by which injection could help, so it gets its own cut.
  subMetrics((a) => a.geoTags.length > 0, 'GEO-BEARING SUBSET — places present');
  subMetrics((a) => a.geoTags.length === 0, 'GEO-LESS SUBSET');

  writer.finish({
    metrics,
    noiseBand: {
      pearson: { min: Math.min(...bl.map((m) => m.pearson)), max: Math.max(...bl.map((m) => m.pearson)) },
      recallAtGate: { min: Math.min(...bl.map((m) => m.gate.recall)), max: Math.max(...bl.map((m) => m.gate.recall)) },
      recallAtTargetSize: {
        min: Math.min(...bl.map((m) => m.atTargetSize.recall)),
        max: Math.max(...bl.map((m) => m.atTargetSize.recall)),
      },
    },
    mustShowTotal,
    tagBearingCount: tagBearing.length,
  });
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e); // eslint-disable-line no-console
    process.exit(1);
  });
