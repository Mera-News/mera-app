// harness-local — the news-harness prompt runner.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/run-newsharness-corpus.ts \
//       --target staging --repeat 3 --limit 40 \
//       [--arms <id>,<id>] [--variant baseline] [--dry-run]
//
// WHAT IT MEASURES. The shipped relevance and reason prompts, over a FIXED
// article set, across model arms, repeated so the noise floor is known before
// anyone edits a prompt. Output is one JSONL row per call, which is the only
// thing the blind rater reads.
//
// INTERLEAVING IS THE POINT. Arms alternate PER CHUNK, not per pass. NEAR
// latency swings several-fold by time of day, so a run that finishes arm A
// before starting arm B measures the clock. The reporter then keeps only the
// work units every arm completed.
//
// NO QUOTA IS SPENT. The article set is the tracked goldset-348 fixture, not a
// live fetch, so `articlesForTopicsByIds` is never called and the daily
// per-user delivery cap is untouched. Staging credentials are still required,
// and refused unless they are staging (lib/staging-guard).
//
// Node-only: never imported by the app bundle.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadHarnessEnv } from '../config/env';
import {
  applyEndpointOverrides,
  applyTargetOverride,
  requireStagingTarget,
} from '../lib/staging-guard';
import { createRunWriter } from '../lib/run-writer';
import {
  createJsonlWriter,
  extractFenceNonce,
  newRowId,
  type CallType,
  type RunRow,
} from '../lib/jsonl-writer';
import { computeAgreement, formatAgreementReport, readJsonl } from '../lib/agreement';
import { estimateRunCost, formatCostEstimate, type PlannedCall } from '../lib/cost-estimate';
import { costOf, fetchModelCatalog, HARNESS_ARM_MODELS, rosterWarnings } from '../lib/model-catalog';
import { hasReasoningLeak, postCompletion, SpendLimitError } from '../lib/near-call';
import { decodeReason } from '../lib/reason-decode';
import {
  bandHistogram,
  formatBandHistogram,
  formatPrecisionRecall,
  formatRescoreSummary,
  gateCount,
  precisionRecallAt,
  rescoreSummary,
} from '../lib/rescore-metrics';
import {
  buildReasonCallsForSubset,
  buildScoreCallForChunk,
  chunk,
  DEFAULT_HARNESS_CONFIG,
  newRelevanceDecodeStats,
  parseBatchRelevanceResponse,
  promptHash,
  relevanceSystemPromptFor,
  reasonSystemPromptFor,
  resolveScoringVariant,
  scoreChunkSizeFor,
  type BatchCall,
  type RelevanceDecodeStats,
  type ScoringCandidate,
} from '../../lib/news-harness';
import { promptVariantIds, resolvePromptVariant } from '../../lib/news-harness/prompts/prompt-variants';
import { registerV1ControlArms } from '../../lib/news-harness/prompts/prompt-archive-v1';

// Once per process, before any variant resolves. This runner's own arms are
// registered elsewhere, but registering here too keeps every runner able to
// name a v1 control without anyone remembering which module does it.
registerV1ControlArms();

interface GoldsetArticle {
  articleId: string;
  title: string;
  description: string;
  countryCode: string | null;
  relatedFacts: string[];
  /** Present on goldset-348, absent on the synthetic injected fixture. Carried
   *  through to the row so the golden join needs no second lookup. */
  verdict?: string | null;
  /** Publisher display name + language tag. Optional: older fixtures (and the
   *  synthetic injected fixture) predate these fields. Absent here means the
   *  built prompt carries no `Publication:` line at all — the same
   *  no-signal path production takes for a row with no publisher metadata,
   *  not a runner bug. See `fetch-staging-fixture.ts --merge-into` to add
   *  them to an existing fixture. */
  publicationName?: string | null;
  languageCode?: string | null;
}
interface Goldset {
  personaFacts: { statement: string }[];
  articles: GoldsetArticle[];
}

interface Args {
  label: string;
  arms: string[];
  repeat: number;
  limit: number;
  variants: string[];
  fixture: string;
  dryRun: boolean;
  reason: boolean;
  duplicateEvery: number;
  /** Per-arm output budget, `<model>=<n>` pairs. An arm that truncates most of
   *  its calls produced no result at all, so it needs its own budget before its
   *  numbers mean anything, and a single global value would change the control
   *  arm too. */
  maxTokens: Record<string, number>;
  /** Empty string = off (today's behaviour: each arm's own pass-1 scores pick
   *  its own reason subset). Set to a registered variant id to pin gate
   *  membership to THAT variant's pass-1 scores, per (model, repeat) cell, and
   *  reuse the same article set for every other variant in that cell — so a
   *  rescore arm is judged on the same articles as baseline instead of
   *  inheriting the ~8% membership churn a fresh gate decision carries. */
  pinGate: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    label: 'newsharness',
    arms: [...HARNESS_ARM_MODELS],
    repeat: 3,
    limit: 40,
    variants: ['baseline'],
    fixture: resolve(__dirname, '..', 'fixtures', 'goldset-348.json'),
    dryRun: false,
    reason: true,
    duplicateEvery: 0,
    maxTokens: {},
    pinGate: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i] ?? args.label;
    else if (a === '--arms') args.arms = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--variant') {
      args.variants = (argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    }
    else if (a === '--fixture') args.fixture = resolve(argv[++i] ?? args.fixture);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-reason') args.reason = false;
    else if (a === '--duplicate-every') args.duplicateEvery = Number(argv[++i]);
    else if (a === '--pin-gate') args.pinGate = argv[++i] ?? args.pinGate;
    else if (a === '--max-tokens') {
      for (const pair of (argv[++i] ?? '').split(',').filter(Boolean)) {
        const eq = pair.lastIndexOf('=');
        const model = eq === -1 ? '' : pair.slice(0, eq);
        const n = Number(pair.slice(eq + 1));
        if (!model || !Number.isFinite(n) || n <= 0) {
          throw new Error(
            `harness-local: --max-tokens takes <model>=<n> pairs, e.g. 'z-ai/glm-5.3-flash=1024' (got ${JSON.stringify(pair)}).`,
          );
        }
        args.maxTokens[model] = n;
      }
    }
  }
  if (!Number.isFinite(args.repeat) || args.repeat < 1) {
    throw new Error('harness-local: --repeat must be 1 or more.');
  }
  if (args.repeat < 3) {
    // Not fatal: a --repeat 1 smoke run is legitimate. But the number it
    // produces is not a floor, and the report has to say so.
    // eslint-disable-next-line no-console
    console.warn(
      `\n!!  --repeat ${args.repeat} does not measure a noise floor. One comparison per cell is a coin flip.\n` +
        '!!  Use --repeat 3 or more for any number that will be quoted.\n',
    );
  }
  if (args.arms.length === 0) throw new Error('harness-local: --arms resolved to nothing.');
  if (args.variants.length === 0) throw new Error('harness-local: --variant resolved to nothing.');
  if (args.pinGate && !args.variants.includes(args.pinGate)) {
    throw new Error(
      `harness-local: --pin-gate '${args.pinGate}' must be one of --variant's list (${args.variants.join(', ')}) ` +
        'so its pass-1 scores are actually computed in this run.',
    );
  }
  return args;
}

/** The goldset rows carry the fields ScoringCandidate needs under different
 *  names. Mapping here, once, keeps the fixture readable and the builders
 *  untouched. */
function toCandidates(articles: GoldsetArticle[]): ScoringCandidate[] {
  return articles.map((a) => ({
    id: a.articleId,
    titleEn: a.title,
    descriptionEn: a.description,
    countryCode: a.countryCode,
    // buildScoreCallForChunk / buildReasonCallsForSubset read these two off
    // the candidate and run them through buildPublicationLabel themselves —
    // there is nothing else to do here to get the `Publication: ...` prompt
    // line production renders. Null on a fixture that predates these fields,
    // which renders no Publication line at all (production's own no-signal
    // path, not a gap this runner papers over).
    publicationName: a.publicationName ?? null,
    languageCode: a.languageCode ?? null,
    userTopicIds: [],
    relatedFacts: (a.relatedFacts ?? []).map((statement, i) => ({
      id: `${a.articleId}-f${i}`,
      statement,
    })),
  }));
}

/** Deterministic stand-in so the whole pipeline can be proven without spending
 *  a single call. It returns a WELL-FORMED tiered array, so a dry run exercises
 *  the real decoder rather than the fallback path. */
function dryRunOutput(callType: CallType, count: number, seed: number): string {
  if (callType === 'reason') return `Dry run reason ${seed}.`;
  const entries = Array.from({ length: count }, (_, i) => {
    const s = ((seed + i) % 9) / 10;
    const k = s >= 0.4 ? 'direct' : s >= 0.25 ? 'indirect' : 'none';
    return `{"k":"${k}","s":${s.toFixed(2)}}`;
  });
  return `[${entries.join(',')}]`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // Both overrides run BEFORE the env file is read, so a flag beats the file
  // without any runner editing a file the user also edits.
  applyTargetOverride(argv);
  const overridden = applyEndpointOverrides(argv);
  const args = parseArgs(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);


  // Resolve EVERY variant up front, before a single call is made. The builders
  // resolve lazily inside their loops, which means an unknown id in the second
  // or later position could otherwise throw partway through a PAID run, after
  // the first variant had already been billed. Resolving here makes an unknown
  // id a startup error in both dry and live modes.
  for (const v of args.variants) {
    try {
      resolvePromptVariant(v);
    } catch (err) {
      throw new Error(
        `harness-local: --variant '${v}' is not registered. Known: ${promptVariantIds().join(', ')}. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const goldset = JSON.parse(readFileSync(args.fixture, 'utf8')) as Goldset;
  const factStatements = goldset.personaFacts.map((f) => f.statement);
  const candidates = toCandidates(goldset.articles).slice(0, args.limit);
  // articleId -> fixture row, for the verdict column on each emitted row.
  const verdictById = new Map<string, string | null>(
    goldset.articles.map((a) => [a.articleId, a.verdict ?? null]),
  );
  const itemsFor = (cs: ScoringCandidate[]): { id: string; verdict?: string | null }[] =>
    cs.map((c) => ({ id: c.id, verdict: verdictById.get(c.id) ?? null }));
  const candidateIds = new Set(candidates.map((c) => c.id));
  /** Resolves a `reason:<candidateId>` call id to its one item. A row whose
   *  join cannot be resolved is worse than a missing row: it looks like data
   *  and cannot be joined to a label, so this fails the run instead. */
  const reasonItems = (callId: string): { id: string; verdict?: string | null }[] => {
    const id = callId.startsWith('reason:') ? callId.slice('reason:'.length) : '';
    if (!id || !candidateIds.has(id)) {
      throw new Error(
        `harness-local: cannot resolve a reason call id to an article (${callId}). ` +
          'The id shape from buildReasonCallsForSubset has changed; fix the join rather than emitting unjoinable rows.',
      );
    }
    return [{ id, verdict: verdictById.get(id) ?? null }];
  };
  if (candidates.length === 0) throw new Error('harness-local: fixture yielded no candidates.');

  const run = createRunWriter({ label: args.label });
  const rows = createJsonlWriter({ dir: run.dir });
  const runId = run.dir.split('/').pop() ?? args.label;

  // Fetched even on a dry run: /v1/models is free, still answers on an
  // exhausted key, and without it the cost estimate below cannot price
  // anything. A failure is tolerated and named rather than silently producing
  // a zero estimate.
  let catalog: Awaited<ReturnType<typeof fetchModelCatalog>> = {};
  let catalogError: string | null = null;
  try {
    catalog = await fetchModelCatalog({
      baseUrl: env.nearAiBaseUrl,
      apiKey: env.nearAiApiKey,
      runDir: args.dryRun ? undefined : run.dir,
    });
  } catch (err) {
    catalogError = err instanceof Error ? err.message : String(err);
  }
  const warnings = catalogError ? [`CATALOGUE UNAVAILABLE: ${catalogError}`] : rosterWarnings(catalog, args.arms);
  const planned: PlannedCall[] = [];

  // eslint-disable-next-line no-console
  console.log(
    `run      : ${runId}\nrun dir  : ${run.dir}\ntarget   : ${env.target} (${env.graphqlEndpoint})` +
      `${overridden.length ? `\noverride : ${overridden.join(', ')}` : ''}` +
      `\narms     : ${args.arms.join(', ')}\nrepeat   : ${args.repeat}` +
      `\narticles : ${candidates.length} from ${args.fixture}` +
      `\nvariants : ${args.variants.join(', ')} (interleaved per chunk, same time window)` +
      `\nmode     : ${args.dryRun ? 'DRY RUN, no calls' : 'live'}\n`,
  );
  for (const w of warnings) console.warn(`!!  ${w}`);

  // DEFAULT_HARNESS_CONFIG is the whole harness config; the scoring builders
  // take the articlePipeline slice of it.
  const config = DEFAULT_HARNESS_CONFIG.articlePipeline;
  const scoringVariant = resolveScoringVariant(candidates);
  const chunks = chunk(candidates, scoreChunkSizeFor(config, scoringVariant));
  // One system prompt PER PROMPT VARIANT. Unknown ids throw here, before any
  // call is made, rather than partway through a paid run.
  const systemByVariant = new Map(
    args.variants.map((v) => [v, relevanceSystemPromptFor(config, scoringVariant, v)]),
  );
  const reasonSystemByVariant = new Map(
    args.variants.map((v) => [v, reasonSystemPromptFor(config, scoringVariant, v)]),
  );

  // One accumulator per (arm, repeat), so the instruction-following rate is
  // attributable to an arm rather than smeared across the run.
  const decodeStats = new Map<string, RelevanceDecodeStats>();
  // Cumulative per-arm map: LAST repeat wins on a shared id (a pre-existing
  // property of this map, kept as-is because it is what today's default
  // reason-subset behaviour is keyed on — see the `--pin-gate` branch below
  // for the per-repeat map that behaviour needs instead).
  const relevanceByArm = new Map<string, Record<string, number>>();
  // Keyed `${model}@${variantId}::${rep}`, matching decodeStats' statsKey.
  // Never overwritten across repeats, unlike relevanceByArm above — this is
  // what makes `--pin-gate` (gate membership decided per repeat) and the
  // pass-1-vs-final metrics report (below) correct across repeats.
  const relevanceByArmRep = new Map<string, Record<string, number>>();
  // Populated only when a reason row's decoded rescore actually parsed
  // (`decodeReason(...).rescore`). Keyed the same as relevanceByArmRep; the
  // inner map is articleId -> the rescore's band-clamped `score`. Reading a
  // miss here means "no rescore for this id in this cell", which is exactly
  // "final = pass-1" (join rule: the pass-2 score lives ONLY on the reason
  // row's parsedSchema; score rows never carry it).
  const rescoreByArmRep = new Map<string, Map<string, number>>();
  let emitted = 0;

  const writeRow = (row: RunRow): void => {
    rows.write(row);
    emitted += 1;
    // A duplicated row lets the rater's own consistency be measured. The rater
    // is not told which rows these are.
    if (args.duplicateEvery > 0 && emitted % args.duplicateEvery === 0) {
      rows.writeDuplicate(row);
    }
  };

  // ---- relevance, arms interleaved PER CHUNK ------------------------------
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkCandidates = chunks[ci];
    // Built once per variant, reused across repeats, so a cell holds one prompt
    // and one fence nonce.
    const builtByVariant = new Map(
      args.variants.map((v) => [
        v,
        buildScoreCallForChunk(chunkCandidates, factStatements, systemByVariant.get(v) as string, config, v),
      ]),
    );

    for (let rep = 0; rep < args.repeat; rep++) {
      // PROMPT VARIANTS INTERLEAVE EXACTLY AS MODELS DO, inside the chunk loop.
      // A control arm that cannot touch scoring moved the kept count by 7
      // between two runs half an hour apart, against a within-run floor of 4,
      // so ANY comparison across separate runs is confounded by drift. Both
      // axes now sit in one run and one time window.
      for (const variantId of args.variants) {
      const built = builtByVariant.get(variantId) as { system: string; prompt: string };
      const hash = promptHash(built.system, built.prompt);
      for (const model of args.arms) {
        const statsKey = `${model}@${variantId}::${rep}`;
        const stats = decodeStats.get(statsKey) ?? newRelevanceDecodeStats();
        decodeStats.set(statsKey, stats);
        planned.push({
          model,
          systemChars: built.system.length,
          promptChars: built.prompt.length,
          maxOutputTokens: args.maxTokens[model] ?? config.scoreBatchMaxTokens,
        });

        const result = args.dryRun
          ? {
              content: dryRunOutput('relevance-batch', chunkCandidates.length, ci + rep),
              toolCalls: [], finishReason: 'stop', truncated: false,
              usage: { promptTokens: 900, completionTokens: 60, cachedTokens: 0, reasoningTokens: 0 },
              modelSent: model, latencyMs: 10 + ci, error: null,
            }
          : await postCompletion({
              baseUrl: env.nearAiBaseUrl,
              apiKey: env.nearAiApiKey,
              model,
              messages: [
                { role: 'system', content: built.system },
                { role: 'user', content: built.prompt },
              ],
              temperature: config.scoreTemperature,
              maxTokens: args.maxTokens[model] ?? config.scoreBatchMaxTokens,
              enableThinking: false,
            });

        // The pass-1 STAKE TAG, recorded alongside the score. Without it the
        // foreign-domestic criterion has no baseline to drop from: `home`,
        // `family`, `travel`, `domain` and `attend` all clamp into
        // [0.40, 1.10], so no score can tell you which one the model chose.
        // Sparse by construction — `null` for a legacy bare-number entry or an
        // entry that failed to decode, always the same length as `scores`.
        const stakeTags: (string | null)[] = [];
        const scores = result.error
          ? []
          : parseBatchRelevanceResponse(
              result.content,
              chunkCandidates.length,
              `score:${ci}`,
              built.prompt,
              config,
              undefined,
              stats,
              stakeTags,
            );
        if (!result.error) {
          const armId = `${model}@${variantId}`;
          const map = relevanceByArm.get(armId) ?? {};
          chunkCandidates.forEach((c, i) => { map[c.id] = scores[i] ?? 0; });
          relevanceByArm.set(armId, map);
          const repKey = `${armId}::${rep}`;
          const repMap = relevanceByArmRep.get(repKey) ?? {};
          chunkCandidates.forEach((c, i) => { repMap[c.id] = scores[i] ?? 0; });
          relevanceByArmRep.set(repKey, repMap);
        }

        const info = catalog[model];
        writeRow({
          rowId: newRowId(), dupOf: null, legIndex: null, runId, repeat: rep,
          cohort: 'goldset', turnIndex: ci, arm: `${model}@${variantId}`, callType: 'relevance-batch',
          interleaveGroup: `chunk:${ci}`, lane: 'near', surface: 'SCORING',
          variant: variantId, promptHash: hash,
          // Stateless: the same chunk always builds the same prompt, once the
          // per-build fence nonce is normalised out (which promptHash does).
          promptDeterministic: true,
          // Read back from the prompt that was actually sent, not assumed.
          fenceNonce: extractFenceNonce(built.prompt),
          modelRequested: model, modelSent: result.modelSent,
          fallbackFrom: null, hedged: false,
          input: {
            systemPrompt: built.system,
            messages: [{ role: 'user', content: built.prompt }],
            toolSchemaNames: [],
          },
          personaStateIn: {
            factCount: factStatements.length, topicCount: 0,
            factsInPrompt: factStatements.length, turnsInPrompt: 1,
          },
          rawOutput: result.content,
          toolCalls: [],
          // Scores AND tags, per article, in input order. `scores` stays a
          // bare array under `scores` so nothing reading the old shape breaks.
          parsedSchema: {
            scores,
            k: stakeTags,
            byId: chunkCandidates.map((c, i) => ({
              articleId: c.id,
              s: scores[i] ?? null,
              k: stakeTags[i] ?? null,
            })),
          },
          items: itemsFor(chunkCandidates),
          requestedCount: chunkCandidates.length,
          returnedCount: result.error ? null : scores.length,
          personaStateDelta: null,
          finishReason: result.finishReason, truncated: result.truncated,
          reasoningLeak: hasReasoningLeak(result.content),
          usage: result.usage,
          cost: result.usage && info
            ? {
                inputTokens: result.usage.promptTokens,
                cachedInputTokens: result.usage.cachedTokens,
                outputTokens: result.usage.completionTokens,
                usd: costOf(info, result.usage),
              }
            : null,
          latencyMs: result.latencyMs, ttVisibleMs: null, error: result.error,
        });
      }
      }
    }
  }

  // One reason-call execution, shared by both branches below so the row shape
  // and the rescore bookkeeping cannot drift apart between them.
  const runReasonCall = async (p: {
    call: BatchCall;
    model: string;
    variantId: string;
    armId: string;
    rep: number;
    ri: number;
    interleaveGroup: string;
    /** The agreement report's CELL key (grouped with `arm`/`variant`). Must be
     *  stable across repeats ONLY when the repeats truly share one prompt —
     *  the default path's `reasonCalls` is built ONCE outside the repeat loop
     *  so `ri` alone is stable and IS that key. Under `--pin-gate`, gate
     *  membership is decided PER REPEAT (by design — a repeat's own pass-1
     *  draw), so the prompt at "position ri" can legitimately differ between
     *  repeats; folding `rep` into this key stops the agreement reporter from
     *  reading that as `RUNNER BUG: repeats disagree on their prompt` (a
     *  same-fixture-prompt violation) when it is really `n=1, nothing to
     *  compare` (a thin cell, which is the true and correctly-reported
     *  state). */
    turnIndex: number;
  }): Promise<void> => {
    const { call, model, variantId, armId, rep, ri, interleaveGroup, turnIndex } = p;
    planned.push({
      model,
      systemChars: (call.system ?? '').length,
      promptChars: call.prompt.length,
      maxOutputTokens: args.maxTokens[model] ?? config.reasonMaxTokens,
      // Only articles at or above reasonRelevanceThreshold get a reason call
      // (or, under --pin-gate, whatever the pinned variant gated in), and a
      // dry run's scores are a stand-in, so this count is an upper bound
      // rather than a prediction.
      conditionalOn: `reasonRelevanceThreshold ${config.reasonRelevanceThreshold}`,
    });
    const result = args.dryRun
      ? {
          content: dryRunOutput('reason', 1, ri + rep),
          toolCalls: [], finishReason: 'stop', truncated: false,
          usage: { promptTokens: 400, completionTokens: 30, cachedTokens: 0, reasoningTokens: 0 },
          modelSent: model, latencyMs: 8 + ri, error: null,
        }
      : await postCompletion({
          baseUrl: env.nearAiBaseUrl, apiKey: env.nearAiApiKey, model,
          messages: [
            { role: 'system', content: call.system ?? (reasonSystemByVariant.get(variantId) as string) },
            { role: 'user', content: call.prompt },
          ],
          temperature: config.reasonTemperature,
          maxTokens: args.maxTokens[model] ?? config.reasonMaxTokens,
          enableThinking: false,
        });
    const info = catalog[model];
    const decoded = result.error ? null : decodeReason(result.content, call.id, call.prompt);
    if (decoded?.rescore) {
      // The call id IS the join (see the comment on `reasonItems`).
      const joinedId = reasonItems(call.id)[0]?.id;
      if (joinedId) {
        const key = `${armId}::${rep}`;
        const map = rescoreByArmRep.get(key) ?? new Map<string, number>();
        map.set(joinedId, decoded.rescore.score);
        rescoreByArmRep.set(key, map);
      }
    }
    writeRow({
      rowId: newRowId(), dupOf: null, legIndex: null, runId, repeat: rep,
      cohort: 'goldset', turnIndex, arm: armId, callType: 'reason',
      interleaveGroup, lane: 'near', surface: 'SCORING',
      variant: variantId,
      promptHash: promptHash(call.system ?? (reasonSystemByVariant.get(variantId) as string), call.prompt),
      promptDeterministic: true,
      fenceNonce: extractFenceNonce(call.prompt), modelRequested: model, modelSent: result.modelSent,
      fallbackFrom: null, hedged: false,
      input: {
        systemPrompt: call.system ?? (reasonSystemByVariant.get(variantId) as string),
        messages: [{ role: 'user', content: call.prompt }],
        toolSchemaNames: [],
      },
      personaStateIn: {
        factCount: factStatements.length, topicCount: 0,
        factsInPrompt: factStatements.length, turnsInPrompt: 1,
      },
      rawOutput: result.content,
      toolCalls: [],
      // {reason, k, s, score}: k/s/score are undefined whenever no rescore
      // parsed. Pre-P2's decodeReason (lib/reason-decode.ts) never produces
      // one, so every row is `{reason}` until that lands — the SAME shape a
      // post-P2 unparsed row reports, which is the point of coding to this
      // contract now rather than after the switch-over. The pass-2 score
      // lives ONLY here: score rows never carry it (join rule below).
      parsedSchema: decoded
        ? { reason: decoded.reason, k: decoded.rescore?.k, s: decoded.rescore?.s, score: decoded.rescore?.score }
        : null,
      // The call id IS the join: buildReasonCallsForSubset builds
      // `reason:<candidateId>` and ships chunkIdToCandidates EMPTY for
      // reason bundles (verified in article-pipeline/scoring.ts), so the
      // map lookup this used to do returned nothing and every reason row
      // carried an empty items array. reasonItems throws on a miss rather
      // than emitting a row the golden join cannot use.
      items: reasonItems(call.id),
      requestedCount: null, returnedCount: null, personaStateDelta: null,
      finishReason: result.finishReason, truncated: result.truncated,
      reasoningLeak: hasReasoningLeak(result.content),
      usage: result.usage,
      cost: result.usage && info
        ? {
            inputTokens: result.usage.promptTokens,
            cachedInputTokens: result.usage.cachedTokens,
            outputTokens: result.usage.completionTokens,
            usd: costOf(info, result.usage),
          }
        : null,
      latencyMs: result.latencyMs, ttVisibleMs: null, error: result.error,
    });
  };

  if (args.reason && args.pinGate) {
    // ---- reason, gate membership PINNED to one variant's pass-1 scores ------
    // Decided per (model, repeat) cell from --pin-gate's own scores in that
    // cell, then reused by every other variant in the SAME cell — so a
    // rescore arm is judged on the same articles as the pin, not its own
    // (~8% different) gate membership. Default is off; this branch only runs
    // when the flag is passed.
    for (let rep = 0; rep < args.repeat; rep++) {
      for (const model of args.arms) {
        const pinnedScores = relevanceByArmRep.get(`${model}@${args.pinGate}::${rep}`) ?? {};
        const pinnedIds = new Set(
          candidates
            .filter((c) => (pinnedScores[c.id] ?? Number.NEGATIVE_INFINITY) >= config.reasonRelevanceThreshold)
            .map((c) => c.id),
        );
        if (pinnedIds.size === 0) continue;
        const pinnedCandidates = candidates.filter((c) => pinnedIds.has(c.id));
        for (const variantId of args.variants) {
          const armId = `${model}@${variantId}`;
          const variantScores = relevanceByArmRep.get(`${armId}::${rep}`) ?? {};
          const reasonBundle = buildReasonCallsForSubset(
            pinnedCandidates,
            variantScores,
            // Membership is ALREADY decided (pinnedCandidates); this variant's
            // own score never gates it back out, even if it sits below its
            // own threshold — that is the whole point of pinning.
            Number.NEGATIVE_INFINITY,
            factStatements,
            config,
            undefined,
            false,
            variantId,
          );
          for (let ri = 0; ri < reasonBundle.calls.length; ri++) {
            await runReasonCall({
              call: reasonBundle.calls[ri],
              model, variantId, armId, rep, ri,
              interleaveGroup: `reason-pinned:${rep}:${ri}`,
              // `rep` folded in: see the param doc on runReasonCall. Gate
              // membership can legitimately differ per repeat under
              // --pin-gate, so "position ri" is not the same prompt across
              // reps here the way it is in the default path below.
              turnIndex: rep * 100000 + ri,
            });
          }
        }
      }
    }
  } else if (args.reason) {
    // ---- reason, over each arm's OWN feed-tier subset -------------------------
    // Deliberately each arm's own subset, not a shared one: the reason prompt
    // is judged on the articles that arm actually promoted, which is the
    // situation it faces in production. (This is what --pin-gate replaces.)
    for (const armId of [...relevanceByArm.keys()].sort()) {
      const [model, variantId] = armId.split('@');
      const relevanceMap = relevanceByArm.get(armId) ?? {};
      const reasonBundle = buildReasonCallsForSubset(
        candidates,
        relevanceMap,
        config.reasonRelevanceThreshold,
        factStatements,
        config,
        undefined,
        false,
        variantId,
      );
      // CloudCallBundle, not an array: the calls live on `.calls`.
      const reasonCalls = reasonBundle.calls;
      for (let ri = 0; ri < reasonCalls.length; ri++) {
        const call = reasonCalls[ri];
        for (let rep = 0; rep < args.repeat; rep++) {
          await runReasonCall({ call, model, variantId, armId, rep, ri, interleaveGroup: `reason:${ri}`, turnIndex: ri });
        }
      }
    }
  }

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log(`\n${formatCostEstimate(estimateRunCost(planned, catalog))}\n`);
  }

  await rows.close();

  // ---- report ---------------------------------------------------------------
  const report = computeAgreement(readJsonl(rows.path), catalog);
  const text = formatAgreementReport(report);
  // eslint-disable-next-line no-console
  console.log(`\n${text}`);

  // Instruction-following, free from the decode counters. A band violation is
  // NOT a leak (clampToStakeBand already clamps it); it is the model failing to
  // hold the contract its own stake tag declares.
  const followLines: string[] = [];
  for (const [key, s] of decodeStats) {
    const rate = s.tieredEntries > 0 ? s.bandViolations / s.tieredEntries : 0;
    followLines.push(
      `  ${key.padEnd(40)} tiered=${s.tieredEntries} legacy=${s.legacyNumberEntries} ` +
        `band-violations=${s.bandViolations} (${(rate * 100).toFixed(1)}%) mass=${s.bandViolationMass.toFixed(2)} ` +
        `regex-fallbacks=${s.regexFallbacks} length-mismatches=${s.lengthMismatches} total-failures=${s.totalFailures}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    '\nINSTRUCTION FOLLOWING (band violations are a contract metric, not a leak: the score was clamped)\n' +
      followLines.join('\n'),
  );

  // ---- rescore report, per model@variant -------------------------------------
  // final = pass-1 unless a reason row in the SAME cell (arm, repeat) carries
  // a parsed rescore (join rule: the pass-2 score lives only on the reason
  // row's parsedSchema, never on the score row). Pooled across all repeats —
  // n is printed on every figure below, since --limit defaults to 40 and a
  // smoke run's numbers must never be misread as the 348-article goldset
  // result.
  const positiveMustShow = new Set(['must_show']);
  const positiveMustShowOrNice = new Set(['must_show', 'nice_to_have']);
  const rescoreLines: string[] = [];
  for (const armId of [...relevanceByArm.keys()].sort()) {
    const pairs: { id: string; pass1: number; final: number; verdict: string | null }[] = [];
    for (let rep = 0; rep < args.repeat; rep++) {
      const scoreMap = relevanceByArmRep.get(`${armId}::${rep}`);
      if (!scoreMap) continue;
      const rescoreMap = rescoreByArmRep.get(`${armId}::${rep}`);
      for (const [id, pass1] of Object.entries(scoreMap)) {
        const final = rescoreMap?.get(id) ?? pass1;
        pairs.push({ id, pass1, final, verdict: verdictById.get(id) ?? null });
      }
    }
    if (pairs.length === 0) continue;

    const pass1Scores = pairs.map((p) => p.pass1);
    const finalScores = pairs.map((p) => p.final);
    const rescored = pairs
      .filter((p) => p.final !== p.pass1)
      .map((p) => ({ before: p.pass1, after: p.final }));

    rescoreLines.push(
      `\n${armId}\n` +
        `  n scored (pooled over ${args.repeat} repeat(s)) : ${pairs.length}\n` +
        `  gate >=${config.discardFloor} pass-1  : ${gateCount(pass1Scores, config.discardFloor)} of ${pairs.length}\n` +
        `  gate >=${config.discardFloor} final   : ${gateCount(finalScores, config.discardFloor)} of ${pairs.length}\n` +
        `  band histogram (final)   : ${formatBandHistogram(bandHistogram(finalScores))}\n` +
        `  ${formatRescoreSummary(rescoreSummary(rescored))}\n` +
        `  ${formatPrecisionRecall(
          'pass-1 (positive=must_show)         ',
          precisionRecallAt(pairs.map((p) => ({ score: p.pass1, verdict: p.verdict })), config.discardFloor, positiveMustShow),
        )}\n` +
        `  ${formatPrecisionRecall(
          'final  (positive=must_show)         ',
          precisionRecallAt(pairs.map((p) => ({ score: p.final, verdict: p.verdict })), config.discardFloor, positiveMustShow),
        )}\n` +
        `  ${formatPrecisionRecall(
          'pass-1 (positive=must_show+nice_to_have)',
          precisionRecallAt(pairs.map((p) => ({ score: p.pass1, verdict: p.verdict })), config.discardFloor, positiveMustShowOrNice),
        )}\n` +
        `  ${formatPrecisionRecall(
          'final  (positive=must_show+nice_to_have)',
          precisionRecallAt(pairs.map((p) => ({ score: p.final, verdict: p.verdict })), config.discardFloor, positiveMustShowOrNice),
        )}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    '\nRESCORE REPORT (band histogram collapses to 4 live bins by construction, not a distribution shape; ' +
      'a fixture with no verdict field reports precision/recall as excluded=n)' +
      rescoreLines.join('\n'),
  );

  run.finish({
    args: { ...args, arms: args.arms },
    target: env.target,
    rows: rows.path,
    agreement: report,
    decodeStats: Object.fromEntries(decodeStats),
    rosterWarnings: warnings,
  });
  writeFileSync(join(run.dir, 'agreement.txt'), `${text}\n`, 'utf8');

  // A run whose repeats were not given the same prompt has measured nothing.
  return report.integrityFailures.some((f) => f.startsWith('RUNNER BUG')) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // A spend limit ends the run on the FIRST refusal. Recording it as data
    // produces a file full of empty rows that reads as a model failing, which
    // is exactly what happened when the key hit its cap mid-run.
    if (err instanceof SpendLimitError) {
      // eslint-disable-next-line no-console
      console.error(
        `\nSPEND LIMIT REACHED, run aborted on the first refusal.\n` +
          `  spent : $${err.spent ?? 'unknown'}\n` +
          `  limit : $${err.limit ?? 'unknown'}\n` +
          `  rows written so far are in the run directory printed above.\n` +
          `  provider said: ${err.message}\n`,
      );
      process.exit(3);
    }
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
