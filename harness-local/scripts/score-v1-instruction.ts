// EXPERIMENT 1 (follow-up to the tag-salvage wave): does TELLING the model what
// the `Article Metadata:` line is, and how to weigh it, beat just injecting it?
//
//   npx tsx harness-local/scripts/score-v1-instruction.ts --label e1 \
//     [--reps 3] [--arms baseline,instruction,placebo-neutral,placebo-salience] [--dry-run]
//
// THE QUESTION
// ------------
// v4 (shipped, default off) appends one `Article Metadata: places… | entities… |
// event…` line per article to the pass-1 USER message. No system prompt mentions
// it — grep for "Article Metadata" across lib/ returns only the constant that
// builds it. The model is inferring the contract from the label alone, and the
// 2026-08-08 shuffled control proved it IS using it (+2.0..+3.7 must_show recall
// at matched feed size, against a shuffled control at -1.0..+0.67).
//
// So this is not "does it work". It is "how much more with guidance", and — via
// arm D — "is guidance even needed, or does merely NAMING the field do it?"
//
// ARMS (all four inject the metadata; ONLY the system prompt varies)
//   A baseline          the shipped prompt, untouched = today's v4-on behaviour
//   B instruction       + a rubric: what the line is, that it is machine-extracted
//                       and fallible, and how to weigh it against the headline
//   C placebo-neutral   + a comparable-length TRUE block about the CORPUS.
//                       Deliberately says nothing about how to score and nothing
//                       about the output contract — a placebo that tightened
//                       format compliance would move scores for a reason that is
//                       neither bulk nor metadata, and would not be a placebo.
//   D placebo-salience  + a comparable-length block that describes the line
//                       TRUTHFULLY (format, provenance) but gives NO guidance on
//                       how to weigh it. Separates salience from instruction.
//
// PRE-REGISTERED READING (fixed before this ran; see scratchpad/prereg-followups.md)
//   B > A, B > C, B > D  ⇒ ADD the rubric
//   B ≈ D, both > A      ⇒ ADD one sentence naming the field, not the rubric
//   B ≈ C                ⇒ REJECT (prompt bulk)
//   B ≈ A                ⇒ REJECT (guidance changes nothing)
//
// NOTHING UNDER lib/ IS TOUCHED. The system prompt is DERIVED here by string
// surgery over the shipped constant, and the surgery is asserted invertible, in
// the same style as `score-v3-goldset.ts` derives its variants: this is an
// experiment prompt, not a shipped one, and `prompts.ts` is pinned by
// golden-prompts.test.ts and concurrently owned by another agent.
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
  injectArticleMetadata,
  articleMetadataLine,
  type ScoringCandidate,
  type StageCandidateRow,
  type BatchCall,
} from '../../lib/news-harness';

const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;
const RENDER_GATE = 0.4;
const SIZE_GRID = [80, 90, 100, 110, 120, 150];

type Arm =
  | 'baseline'
  | 'instruction'
  | 'placebo-neutral'
  | 'placebo-salience'
  // --- ENTITY-ABLATION arms (added 2026-08-09, owner is removing `entities`
  //     from the system). These vary the METADATA, not the system prompt.
  //     `no-metadata` is the true v4-OFF baseline the +2.0..+3.7 was measured
  //     against; `no-entities` is the block the owner intends to ship.
  | 'no-metadata'
  | 'no-entities';
const ALL_ARMS: Arm[] = [
  'baseline',
  'instruction',
  'placebo-neutral',
  'placebo-salience',
  'no-metadata',
  'no-entities',
];

/** What metadata each arm injects. Only the two ablation arms differ; every
 *  other arm carries the full block, because they vary the SYSTEM PROMPT. */
const METADATA_MODE: Record<Arm, 'full' | 'none' | 'no-entities'> = {
  baseline: 'full',
  instruction: 'full',
  'placebo-neutral': 'full',
  'placebo-salience': 'full',
  'no-metadata': 'none',
  'no-entities': 'no-entities',
};

// --- the three candidate blocks ---------------------------------------------

/** B — the real treatment. Explains the field, its fallibility, and its weight. */
const INSTRUCTION_BLOCK = `## Article Metadata
Some articles carry an extra \`Article Metadata:\` line after their Related User Fact. It is machine-extracted from the headline and description by a separate tagging step, and it is a HINT, not evidence.
- \`places\` — the location(s) the STORY is about. \`Article Country\`, where present, is the PUBLISHER's country; when the two disagree, \`places\` is the one that decides the geography stake test.
- \`entities\` — named organisations, people or products central to the story.
- \`event\` — one coarse category naming what kind of event it is.
The extraction is imperfect: fields are frequently missing, some values are wrong, and an absent field means "not extracted", never "none". The title and description remain the authority — where the metadata contradicts them, follow the article text and ignore the metadata. Never raise a tier on a metadata match alone; use it to confirm or sharpen a stake the article itself already shows.`;

/** C — placebo, neutral. True, comparable length, and deliberately about the
 *  corpus: it touches neither the scoring decision nor the output contract. */
const PLACEBO_NEUTRAL_BLOCK = `## Corpus Background
The articles you are scoring are drawn from a continuously updated pool gathered from several thousand news feeds across many countries. Feeds are polled on a fixed schedule, and each item is stored with the time it was first seen rather than the time it was written. Articles not originally published in English are machine-translated before they reach you, so the title and description you read may be a translation rather than the publisher's own wording, and translated phrasing is often flatter than the original. The pool mixes national outlets, regional papers, trade press and wire services, and the same underlying story frequently arrives from several publishers at once, in several languages. Feed coverage is uneven between countries: some markets contribute many hundreds of outlets and others only a handful, so the number of articles about a given place reflects how many publishers were polled there as much as anything else. Descriptions vary in length, and some publishers supply only a repeated headline.`;

/** D — placebo, salience. Names and truthfully describes the line, but gives no
 *  guidance whatsoever on how to weigh it. Isolates "the prompt mentions it". */
const PLACEBO_SALIENCE_BLOCK = `## Article Metadata
Some articles carry an extra \`Article Metadata:\` line after their Related User Fact. It is produced by a separate tagging step that runs after ingestion and is stored alongside the article. The line may list up to three places, up to five entities, and one event category drawn from a fixed vocabulary. City and region names appear lower-cased; country codes are two-letter ISO codes. Fields that were not extracted are omitted from the line entirely, so its length varies between articles, and articles tagged before the step existed carry no line at all. The same tagging step runs over every article in the pool regardless of its language or publisher. It reads only the headline and the description, not the full body text, and it processes articles in batches rather than one at a time. Its event vocabulary is a closed list fixed in advance, and entity names are recorded in their canonical English form where one exists. The line is written once, when the article is first tagged, and is not revised afterwards.`;

const BLOCK_FOR: Record<Arm, string | null> = {
  baseline: null,
  instruction: INSTRUCTION_BLOCK,
  'placebo-neutral': PLACEBO_NEUTRAL_BLOCK,
  'placebo-salience': PLACEBO_SALIENCE_BLOCK,
  // The ablation arms use the SHIPPED system prompt — they are a metadata
  // ablation, and adding a prompt block would confound the two variables.
  'no-metadata': null,
  'no-entities': null,
};

/** The seam the block is spliced at: between the shared scoring base and the
 *  output-contract section. Asserted to occur exactly once so a prompt edit
 *  upstream cannot silently move where the block lands. */
const TASK_MARKER = '\n\n## Task\n';

function systemPromptFor(arm: Arm): string {
  const shipped = CFG.relevanceSystemPrompt;
  const block = BLOCK_FOR[arm];
  if (!block) return shipped;
  const parts = shipped.split(TASK_MARKER);
  if (parts.length !== 2) {
    throw new Error(
      `score-v1-instruction: expected exactly one "${TASK_MARKER.trim()}" section in ` +
        `CLOUD_RELEVANCE_SYSTEM_PROMPT, found ${parts.length - 1}. The shipped prompt has ` +
        'drifted and the splice point is no longer where this experiment assumes.',
    );
  }
  const derived = `${parts[0]}\n\n${block}${TASK_MARKER}${parts[1]}`;
  // Invertibility: removing the block must return the shipped prompt exactly.
  if (derived.replace(`\n\n${block}`, '') !== shipped) {
    throw new Error(
      'score-v1-instruction: the derived system prompt does not invert back to the shipped ' +
        'one — refusing to measure a prompt nobody chose.',
    );
  }
  return derived;
}

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
  geoTags: GeoTag[];
  entities: string[];
  eventType: string | null;
}

interface Fixture {
  _provenance: { articleCount: number; mustShowTotal: number; [k: string]: unknown };
  personaFacts: { statement: string }[];
  articles: TaggedArticle[];
}

export function loadTagged(path: string): Fixture {
  const fx = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
  if (fx.articles.length !== fx._provenance.articleCount) {
    throw new Error('score-v1-instruction: fixture article count does not match its provenance');
  }
  const ms = fx.articles.filter((a) => a.verdict === 'must_show').length;
  if (ms !== fx._provenance.mustShowTotal) {
    throw new Error('score-v1-instruction: must_show total moved — the gold set is FROZEN');
  }
  const statements = fx.personaFacts.map((f) => f.statement);
  if (buildUserContext(statements) !== `[User facts] ${statements.join('. ')}.`) {
    throw new Error('score-v1-instruction: persona does not round-trip through buildUserContext');
  }
  return fx;
}

/** Fixture row → the SHIPPED candidate shape, with `meta` carrying the tags in
 *  exactly the columns `articleMetadataLine` reads in production. Using the
 *  shipped helpers (not a local copy) is what makes this measure v4. */
export function toCandidate(a: TaggedArticle): ScoringCandidate {
  const meta: StageCandidateRow = {
    id: a.articleId,
    titleEn: a.title,
    descriptionEn: a.description,
    publicationName: null,
    countryCode: a.countryCode,
    firstPubDateMs: null,
    maxClusterSize: null,
    eventType: a.eventType,
    category: null,
    geoTagsJson: JSON.stringify(a.geoTags),
    entitiesJson: JSON.stringify(a.entities),
    matchedTopicsJson: null,
    headlineScope: null,
    stableClusterId: null,
  };
  return {
    id: a.articleId,
    titleEn: a.title,
    descriptionEn: a.description,
    countryCode: a.countryCode,
    userTopicIds: [],
    relatedFacts: a.relatedFacts.map((statement, i) => ({ id: `${a.articleId}:f${i}`, statement })),
    meta,
  };
}

// --- one pass ---------------------------------------------------------------

interface PassRow {
  articleId: string;
  score: number;
  jComp: number;
  verdict: TaggedArticle['verdict'];
  tagBearing: boolean;
}

interface PassResult {
  arm: Arm;
  replicate: number;
  rows: PassRow[];
  unscored: number;
  chunkAttempts: number;
  salvagedChunks: number;
  truncatedCalls: number;
  errorCalls: number;
  systemChars: number;
}

async function runPass(
  arm: Arm,
  replicate: number,
  articles: TaggedArticle[],
  personaStatements: string[],
  llm: ReturnType<typeof createNearAiLlm>,
  sink: LlmCallRecord[],
): Promise<PassResult> {
  const system = systemPromptFor(arm);
  const mode = METADATA_MODE[arm];
  // `no-entities` is produced by emptying the entities COLUMN and letting the
  // SHIPPED `articleMetadataLine` render the line — not by writing a second
  // renderer here. That keeps the ablation on the production code path: the
  // shipped helper already omits an empty field, so the emitted line is exactly
  // the `places: … | event: …` block the owner intends to ship.
  const candidates = articles.map((a) =>
    mode === 'no-entities' ? toCandidate({ ...a, entities: [] }) : toCandidate(a),
  );
  const chunks = chunk(candidates, CFG.articlesPerScorePrompt);
  const byId = new Map(articles.map((a) => [a.articleId, a]));

  const calls: BatchCall[] = chunks.map((chunkCandidates, idx) => {
    // The SHIPPED builder, then the SHIPPED injector. Every arm gets the
    // metadata — only `system` differs between arms.
    const { prompt } = buildScoreCallForChunk(chunkCandidates, personaStatements, system);
    return {
      id: `${arm}:${replicate}:chunk-${idx}`,
      system,
      prompt: mode === 'none' ? prompt : injectArticleMetadata(prompt, chunkCandidates),
      temperature: CFG.scoreTemperature,
      maxTokens: CFG.scoreBatchMaxTokens,
    };
  });

  const results = await llm.batchComplete(calls, { model: CFG.model });
  const resById = new Map(results.map((r) => [r.id, r]));

  const rows: PassRow[] = [];
  let unscored = 0;
  let salvaged = 0;

  chunks.forEach((chunkCandidates, idx) => {
    const res = resById.get(`${arm}:${replicate}:chunk-${idx}`);
    if (!res || res.error) {
      unscored += chunkCandidates.length;
      return;
    }
    const m = (res.output ?? '').trim().match(/\[[\s\S]*\]/);
    let wellFormed = false;
    if (m) {
      try {
        const p: unknown = JSON.parse(m[0]);
        wellFormed = Array.isArray(p) && p.length === chunkCandidates.length;
      } catch {
        wellFormed = false;
      }
    }
    if (!wellFormed) salvaged += 1;

    const scores = parseBatchRelevanceResponse(
      res.output,
      chunkCandidates.length,
      `${arm}:${replicate}:chunk-${idx}`,
      undefined,
      CFG,
      consoleLogger,
    );
    chunkCandidates.forEach((c, i) => {
      const a = byId.get(c.id) as TaggedArticle;
      rows.push({
        articleId: c.id,
        score: scores[i],
        jComp: a.jComp,
        verdict: a.verdict,
        tagBearing: articleMetadataLine(c).length > 0,
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
    systemChars: system.length,
  };
}

// --- metrics ----------------------------------------------------------------

const mean = (xs: number[]) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);

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

/** Recall at the closest ACHIEVABLE feed size to `target`, ties broken toward the
 *  smaller feed. v1's scores are heavily tied, so the achievable n always
 *  travels with the recall — a recall at a bigger feed is not comparable. */
function recallAtSize(rows: PassRow[], target: number): { n: number; recall: number } {
  const thresholds = [...new Set(rows.map((r) => r.score))].sort((a, b) => b - a);
  const points = thresholds.map((t) => {
    const inc = rows.filter((r) => r.score >= t);
    return { n: inc.length, recall: inc.filter((r) => r.verdict === 'must_show').length };
  });
  return points.reduce((a, b) => {
    const da = Math.abs(a.n - target);
    const db = Math.abs(b.n - target);
    return db < da || (db === da && b.n < a.n) ? b : a;
  });
}

const fmt = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
const band = (xs: number[]) => `${fmt(Math.min(...xs))}..${fmt(Math.max(...xs))}`;
const bandI = (xs: number[]) => `${Math.min(...xs)}..${Math.max(...xs)}`;

// --- main -------------------------------------------------------------------

async function main(): Promise<number> {
  ensureLocalTestData();
  const argv = process.argv.slice(2);
  const arg = (f: string, d: string) => (argv.includes(f) ? (argv[argv.indexOf(f) + 1] ?? d) : d);
  const label = arg('--label', 'v1-instruction');
  const reps = Number(arg('--reps', '3'));
  const dryRun = argv.includes('--dry-run');
  const arms = (arg('--arms', ALL_ARMS.join(',')).split(',') as Arm[]).filter((a) =>
    ALL_ARMS.includes(a),
  );
  const goldset = arg('--goldset', join(__dirname, '..', 'fixtures', 'goldset-348-tagged.json'));
  const log = (s: string) => console.log(s); // eslint-disable-line no-console

  const fx = loadTagged(goldset);
  const articles = fx.articles;
  const personaStatements = fx.personaFacts.map((f) => f.statement);
  const mustShowTotal = articles.filter((a) => a.verdict === 'must_show').length;
  const candidates = articles.map(toCandidate);
  const tagBearing = candidates.filter((c) => articleMetadataLine(c).length > 0).length;

  const writer = createRunWriter({ label });
  log(`gold set    : ${goldset}`);
  log(`articles    : ${articles.length} (${mustShowTotal} must_show, ${tagBearing} tag-bearing)`);
  log(`arms        : ${arms.join(', ')} x${reps}`);
  log(`calls       : ${arms.length * reps * Math.ceil(articles.length / CFG.articlesPerScorePrompt)}`);
  log(`run dir     : ${writer.dir}`);
  log(`\n-- system prompt sizes (the placebo must be comparable to the treatment) --`);
  for (const a of ALL_ARMS) {
    const block = BLOCK_FOR[a];
    log(
      `  ${a.padEnd(18)} system ${String(systemPromptFor(a).length).padStart(5)} chars` +
        (block ? `  (block ${block.length})` : '  (shipped, unmodified)'),
    );
  }

  for (const a of arms) {
    writeFileSync(join(writer.dir, `system-prompt-${a}.txt`), systemPromptFor(a), 'utf8');
  }
  writer.writeJson('config', {
    gitSha: captureGitSha(),
    goldset,
    model: CFG.model,
    arms,
    reps,
    articlesPerScorePrompt: CFG.articlesPerScorePrompt,
    scoreTemperature: CFG.scoreTemperature,
    scoreBatchMaxTokens: CFG.scoreBatchMaxTokens,
    renderGate: RENDER_GATE,
    sizeGrid: SIZE_GRID,
    mustShowTotal,
    tagBearing,
    blockChars: Object.fromEntries(ALL_ARMS.map((a) => [a, BLOCK_FOR[a]?.length ?? 0])),
    note: 'All arms inject the metadata line (v4-on). ONLY the system prompt varies.',
  });

  if (dryRun) {
    log('\n--dry-run: system prompts written, no provider calls made.');
    return 0;
  }

  const env = loadHarnessEnv();
  const passes: PassResult[] = [];
  // Baselines first and all of them, so the noise band exists before any
  // treatment arm is looked at.
  const plan: { arm: Arm; rep: number }[] = [];
  for (const a of arms) for (let r = 1; r <= reps; r++) plan.push({ arm: a, rep: r });

  for (const step of plan) {
    const sink: LlmCallRecord[] = [];
    const llm = createNearAiLlm({
      apiKey: env.nearAiApiKey,
      baseUrl: env.nearAiBaseUrl,
      defaultModel: CFG.model,
      onCall: (rec) => sink.push(rec),
    });
    const t0 = Date.now();
    const p = await runPass(step.arm, step.rep, articles, personaStatements, llm, sink);
    passes.push(p);
    writer.writeJson(`scores-${step.arm}-${step.rep}`, p.rows);
    const inc = p.rows.filter((r) => r.score >= RENDER_GATE);
    log(
      `\n[${step.arm} #${step.rep}] ${Math.round((Date.now() - t0) / 1000)}s — ` +
        `r=${fmt(pearson(p.rows.map((r) => r.score), p.rows.map((r) => r.jComp)))} ` +
        `gate n=${inc.length} recall ${inc.filter((r) => r.verdict === 'must_show').length}/${mustShowTotal} ` +
        `| salvaged ${p.salvagedChunks} truncated ${p.truncatedCalls} errors ${p.errorCalls} unscored ${p.unscored}`,
    );
  }

  // --- report ---------------------------------------------------------------
  const byArm = (a: Arm) => passes.filter((p) => p.arm === a);
  const armPearson = (a: Arm) =>
    byArm(a).map((p) => pearson(p.rows.map((r) => r.score), p.rows.map((r) => r.jComp)));

  log(`\n${'='.repeat(104)}`);
  log('MATCHED-FEED-SIZE RECALL — the PRIMARY metric. Each arm read on its own fresh scores;');
  log('the achievable n travels with every recall because v1 scores are heavily tied.');
  log('='.repeat(104));
  const cells = new Map<string, { n: number; recall: number }[]>();
  for (const a of arms) {
    for (const g of SIZE_GRID) {
      cells.set(
        `${a}|${g}`,
        byArm(a).map((p) => recallAtSize(p.rows, g)),
      );
    }
  }
  log(`${'arm'.padEnd(18)}${SIZE_GRID.map((g) => `n≈${g}`.padStart(17)).join('')}`);
  for (const a of arms) {
    let line = a.padEnd(18);
    for (const g of SIZE_GRID) {
      const v = cells.get(`${a}|${g}`) as { n: number; recall: number }[];
      line += `${fmt(mean(v.map((x) => x.recall)), 2)}@n${fmt(mean(v.map((x) => x.n)), 0)}`.padStart(17);
    }
    log(line);
  }

  const baseAt = (g: number) =>
    mean((cells.get(`baseline|${g}`) ?? []).map((x) => x.recall));
  log(`\n-- Δ vs baseline (mean recall; the SIGN must be consistent across the curve) --`);
  log(`${'arm'.padEnd(18)}${SIZE_GRID.map((g) => `n≈${g}`.padStart(10)).join('')}${'  consistent?'}`);
  for (const a of arms.filter((x) => x !== 'baseline')) {
    const deltas = SIZE_GRID.map(
      (g) => mean((cells.get(`${a}|${g}`) ?? []).map((x) => x.recall)) - baseAt(g),
    );
    const allPos = deltas.every((d) => d > 0);
    const allNeg = deltas.every((d) => d < 0);
    log(
      a.padEnd(18) +
        deltas.map((d) => (d >= 0 ? `+${fmt(d, 2)}` : fmt(d, 2)).padStart(10)).join('') +
        `   ${allPos ? 'YES (+)' : allNeg ? 'YES (-)' : 'NO — mixed'}`,
    );
  }

  log(`\n-- RAW replicate recalls (so overlap is judged, not averaged away) --`);
  for (const g of SIZE_GRID) {
    log(
      `  n≈${String(g).padEnd(4)} ` +
        arms
          .map((a) => {
            const v = (cells.get(`${a}|${g}`) ?? []).map((x) => x.recall).sort((p, q) => p - q);
            return `${a.slice(0, 11)} [${v.join(',')}]`;
          })
          .join('   '),
    );
  }

  log(`\n-- SECONDARY: Pearson (report only outside the 0.03 noise floor) --`);
  for (const a of arms) {
    const v = armPearson(a);
    const d = a === 'baseline' ? 0 : mean(v) - mean(armPearson('baseline'));
    log(
      `  ${a.padEnd(18)} ${band(v)} (mean ${fmt(mean(v))})` +
        (a === 'baseline' ? '' : `   Δ ${fmt(d)}  ${Math.abs(d) >= 0.03 ? '[outside noise]' : '[INSIDE noise — not evidence]'}`),
    );
  }

  log(`\n-- VALIDITY (arms are only paired if these agree) --`);
  for (const a of arms) {
    const v = byArm(a);
    log(
      `  ${a.padEnd(18)} salvaged ${v.map((p) => p.salvagedChunks).join('/')}  ` +
        `truncated ${v.map((p) => p.truncatedCalls).join('/')}  ` +
        `errors ${v.map((p) => p.errorCalls).join('/')}  ` +
        `unscored ${v.map((p) => p.unscored).join('/')}  system ${v[0]?.systemChars} chars`,
    );
  }

  log(`\n-- TAG-BEARING SUBSET (undiluted) vs the rest --`);
  for (const a of arms) {
    const sub = (only: boolean) =>
      byArm(a).map((p) => {
        const rows = p.rows.filter((r) => r.tagBearing === only);
        const inc = rows.filter((r) => r.score >= RENDER_GATE);
        return inc.filter((r) => r.verdict === 'must_show').length;
      });
    log(`  ${a.padEnd(18)} tag-bearing recall@0.4 ${bandI(sub(true))}   untagged ${bandI(sub(false))}`);
  }

  writer.finish({
    arms,
    reps,
    mustShowTotal,
    tagBearing,
    blockChars: Object.fromEntries(ALL_ARMS.map((a) => [a, BLOCK_FOR[a]?.length ?? 0])),
    perPass: passes.map((p) => ({
      arm: p.arm,
      replicate: p.replicate,
      pearson: pearson(p.rows.map((r) => r.score), p.rows.map((r) => r.jComp)),
      gateN: p.rows.filter((r) => r.score >= RENDER_GATE).length,
      gateRecall: p.rows.filter((r) => r.score >= RENDER_GATE && r.verdict === 'must_show').length,
      atSize: Object.fromEntries(SIZE_GRID.map((g) => [g, recallAtSize(p.rows, g)])),
      salvagedChunks: p.salvagedChunks,
      truncatedCalls: p.truncatedCalls,
      errorCalls: p.errorCalls,
      unscored: p.unscored,
    })),
  });
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
