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
  newRowId,
  type CallType,
  type RunRow,
} from '../lib/jsonl-writer';
import { computeAgreement, formatAgreementReport, readJsonl } from '../lib/agreement';
import { costOf, fetchModelCatalog, HARNESS_ARM_MODELS, rosterWarnings } from '../lib/model-catalog';
import { postCompletion } from '../lib/near-call';
import {
  buildReasonCallsForSubset,
  buildScoreCallForChunk,
  chunk,
  DEFAULT_HARNESS_CONFIG,
  newRelevanceDecodeStats,
  parseBatchRelevanceResponse,
  parseReasonResponse,
  promptHash,
  relevanceSystemPromptFor,
  reasonSystemPromptFor,
  resolveScoringVariant,
  scoreChunkSizeFor,
  type RelevanceDecodeStats,
  type ScoringCandidate,
} from '../../lib/news-harness';

interface GoldsetArticle {
  articleId: string;
  title: string;
  description: string;
  countryCode: string | null;
  relatedFacts: string[];
  /** Present on goldset-348, absent on the synthetic injected fixture. Carried
   *  through to the row so the golden join needs no second lookup. */
  verdict?: string | null;
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
  variant: string;
  fixture: string;
  dryRun: boolean;
  reason: boolean;
  duplicateEvery: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    label: 'newsharness',
    arms: [...HARNESS_ARM_MODELS],
    repeat: 3,
    limit: 40,
    variant: 'baseline',
    fixture: resolve(__dirname, '..', 'fixtures', 'goldset-348.json'),
    dryRun: false,
    reason: true,
    duplicateEvery: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i] ?? args.label;
    else if (a === '--arms') args.arms = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--variant') args.variant = argv[++i] ?? args.variant;
    else if (a === '--fixture') args.fixture = resolve(argv[++i] ?? args.fixture);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-reason') args.reason = false;
    else if (a === '--duplicate-every') args.duplicateEvery = Number(argv[++i]);
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

  const catalog = args.dryRun
    ? {}
    : await fetchModelCatalog({ baseUrl: env.nearAiBaseUrl, apiKey: env.nearAiApiKey, runDir: run.dir });
  const warnings = args.dryRun ? [] : rosterWarnings(catalog, args.arms);

  // eslint-disable-next-line no-console
  console.log(
    `run      : ${runId}\ntarget   : ${env.target} (${env.graphqlEndpoint})` +
      `${overridden.length ? `\noverride : ${overridden.join(', ')}` : ''}` +
      `\narms     : ${args.arms.join(', ')}\nrepeat   : ${args.repeat}` +
      `\narticles : ${candidates.length} from ${args.fixture}` +
      `\nvariant  : ${args.variant}\nmode     : ${args.dryRun ? 'DRY RUN, no calls' : 'live'}\n`,
  );
  for (const w of warnings) console.warn(`!!  ${w}`);

  // DEFAULT_HARNESS_CONFIG is the whole harness config; the scoring builders
  // take the articlePipeline slice of it.
  const config = DEFAULT_HARNESS_CONFIG.articlePipeline;
  const scoringVariant = resolveScoringVariant(candidates);
  const chunks = chunk(candidates, scoreChunkSizeFor(config, scoringVariant));
  const systemPrompt = relevanceSystemPromptFor(config, scoringVariant, args.variant);
  const reasonSystem = reasonSystemPromptFor(config, scoringVariant, args.variant);

  // One accumulator per (arm, repeat), so the instruction-following rate is
  // attributable to an arm rather than smeared across the run.
  const decodeStats = new Map<string, RelevanceDecodeStats>();
  const relevanceByArm = new Map<string, Record<string, number>>();
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
    const built = buildScoreCallForChunk(
      chunkCandidates,
      factStatements,
      systemPrompt,
      config,
      args.variant,
    );
    // The news-harness scout's hash, not a raw one: it normalises the fence
    // nonce first, so two identical calls agree instead of reporting a change
    // on every single call.
    const hash = promptHash(built.system, built.prompt);

    for (let rep = 0; rep < args.repeat; rep++) {
      for (const model of args.arms) {
        const statsKey = `${model}::${rep}`;
        const stats = decodeStats.get(statsKey) ?? newRelevanceDecodeStats();
        decodeStats.set(statsKey, stats);

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
              maxTokens: config.scoreBatchMaxTokens,
              enableThinking: false,
            });

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
            );
        if (!result.error) {
          const map = relevanceByArm.get(model) ?? {};
          chunkCandidates.forEach((c, i) => { map[c.id] = scores[i] ?? 0; });
          relevanceByArm.set(model, map);
        }

        const info = catalog[model];
        writeRow({
          rowId: newRowId(), dupOf: null, runId, repeat: rep,
          cohort: 'goldset', turnIndex: ci, arm: model, callType: 'relevance-batch',
          interleaveGroup: `chunk:${ci}`, lane: 'near', surface: 'SCORING',
          variant: args.variant, promptHash: hash, fenceNonce: null,
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
          parsedSchema: scores,
          items: itemsFor(chunkCandidates),
          requestedCount: chunkCandidates.length,
          returnedCount: result.error ? null : scores.length,
          personaStateDelta: null,
          finishReason: result.finishReason, truncated: result.truncated,
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

  // ---- reason, over each arm's OWN feed-tier subset -------------------------
  // Deliberately each arm's own subset, not a shared one: the reason prompt is
  // judged on the articles that arm actually promoted, which is the situation
  // it faces in production.
  if (args.reason) {
    for (const model of args.arms) {
      const relevanceMap = relevanceByArm.get(model) ?? {};
      const reasonBundle = buildReasonCallsForSubset(
        candidates,
        relevanceMap,
        config.reasonRelevanceThreshold,
        factStatements,
        config,
        undefined,
        false,
        args.variant,
      );
      // CloudCallBundle, not an array: the calls live on `.calls`.
      const reasonCalls = reasonBundle.calls;
      for (let ri = 0; ri < reasonCalls.length; ri++) {
        const call = reasonCalls[ri];
        for (let rep = 0; rep < args.repeat; rep++) {
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
                  { role: 'system', content: call.system ?? reasonSystem },
                  { role: 'user', content: call.prompt },
                ],
                temperature: config.reasonTemperature,
                maxTokens: config.reasonMaxTokens,
                enableThinking: false,
              });
          const info = catalog[model];
          writeRow({
            rowId: newRowId(), dupOf: null, runId, repeat: rep,
            cohort: 'goldset', turnIndex: ri, arm: model, callType: 'reason',
            interleaveGroup: `reason:${ri}`, lane: 'near', surface: 'SCORING',
            variant: args.variant,
            promptHash: promptHash(call.system ?? reasonSystem, call.prompt),
            fenceNonce: null, modelRequested: model, modelSent: result.modelSent,
            fallbackFrom: null, hedged: false,
            input: {
              systemPrompt: call.system ?? reasonSystem,
              messages: [{ role: 'user', content: call.prompt }],
              toolSchemaNames: [],
            },
            personaStateIn: {
              factCount: factStatements.length, topicCount: 0,
              factsInPrompt: factStatements.length, turnsInPrompt: 1,
            },
            rawOutput: result.content,
            toolCalls: [],
            parsedSchema: result.error ? null : parseReasonResponse(result.content, call.id, call.prompt),
            // The call id IS the join: buildReasonCallsForSubset builds
            // `reason:<candidateId>` and ships chunkIdToCandidates EMPTY for
            // reason bundles (verified in article-pipeline/scoring.ts), so the
            // map lookup this used to do returned nothing and every reason row
            // carried an empty items array. reasonItems throws on a miss rather
            // than emitting a row the golden join cannot use.
            items: reasonItems(call.id),
            requestedCount: null, returnedCount: null, personaStateDelta: null,
            finishReason: result.finishReason, truncated: result.truncated,
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
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
