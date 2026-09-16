// harness-local — the topic-generation prompt runner.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/run-topicgen-corpus.ts \
//       --target staging --graphql-endpoint ... --auth-endpoint ... \
//       --cohort heavy --accept 6 --totals 10,4 --repeat 3
//
// WHAT IT MEASURES. The topic-generation pass, which is where the "weird
// topics" complaint actually comes from. Per fact it builds the same up-to-two
// calls production builds, factOnly and combo, across model arms and count
// arms, repeated.
//
// SEQUENTIAL ACCEPT. Facts are accepted one after another, and each call
// excludes the topics the PREVIOUS facts produced, which is what the app does
// when a user confirms several facts from one turn. That ordering is the whole
// reason `excludeTopics` exists, and running the facts independently would
// hide the failure it guards against.
//
// THE MECHANICAL CHECK. A topic that appears under two different facts in the
// same accept batch is a hard fail, not a matter of taste: the exclude list was
// supposed to prevent exactly that. It is counted per arm and printed, so it
// can be compared between arms without a rater.
//
// ONE ARM BY DEFAULT. GLM 5.3 Flash is closed for selection here: it returns
// its reasoning trace inside content, ignores enable_thinking:false, runs about
// 10x slower per call, and a bigger budget does not reliably fix it. Pass
// --arms to probe it anyway; that should be a decision someone types.
//
// GEAR. Thinking OFF, temperature 0.3, maxTokens max(cloudMaxTokens, total*30),
// all of it read from the builder rather than restated here, so this cannot
// drift from production. topic-generation.ts documents WHY thinking is off:
// with it on, the trace ate the whole budget and content came back empty on 8
// of 10 probe runs. This runner records whether each arm actually honoured it.
//
// Node-only: never imported by the app bundle.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadHarnessEnv } from '../config/env';
import {
  applyEndpointOverrides,
  applyTargetOverride,
  requireStagingTarget,
} from '../lib/staging-guard';
import { createRunWriter } from '../lib/run-writer';
import { createJsonlWriter, hashMessages, newRowId, type CallType, type RunRow } from '../lib/jsonl-writer';
import { computeAgreement, formatAgreementReport, readJsonl } from '../lib/agreement';
import { costOf, fetchModelCatalog, rosterWarnings, TOPICGEN_ARM_MODELS } from '../lib/model-catalog';
import { hasReasoningLeak, postCompletion } from '../lib/near-call';
import { COHORTS, loadCohort, type CorpusFact } from '../lib/corpus';
import {
  buildCloudBatchCallsForFact,
  parseTopicsFromOutput,
  splitCount,
} from '../../lib/news-harness/persona-management/topic-generation';

interface Args {
  label: string;
  cohort: string;
  arms: string[];
  totals: number[];
  accept: number;
  repeat: number;
  variant: string;
  dryRun: boolean;
  duplicateEvery: number;
  maxTokens: Record<string, number>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    label: 'topicgen',
    cohort: 'heavy',
    arms: [...TOPICGEN_ARM_MODELS],
    totals: [10],
    accept: 6,
    repeat: 3,
    variant: 'baseline',
    dryRun: false,
    duplicateEvery: 0,
    maxTokens: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i] ?? args.label;
    else if (a === '--cohort') args.cohort = argv[++i] ?? args.cohort;
    else if (a === '--arms') args.arms = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--totals') args.totals = (argv[++i] ?? '').split(',').map(Number).filter((n) => n > 0);
    else if (a === '--accept') args.accept = Number(argv[++i]);
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--variant') args.variant = argv[++i] ?? args.variant;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--duplicate-every') args.duplicateEvery = Number(argv[++i]);
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
  if (!(COHORTS as readonly string[]).includes(args.cohort)) {
    throw new Error(`harness-local: unknown cohort '${args.cohort}'. Known: ${COHORTS.join(', ')}.`);
  }
  if (args.totals.length === 0) throw new Error('harness-local: --totals resolved to nothing.');
  if (args.repeat < 3) {
    // eslint-disable-next-line no-console
    console.warn(`\n!!  --repeat ${args.repeat} does not measure a noise floor.\n`);
  }
  return args;
}

/** The user's location fact, which the builder takes separately. Matched on the
 *  attribute rather than the text, the same key the app's own resolver uses. */
function locationOf(facts: CorpusFact[]): string | null {
  const hit = facts.find((f) => f.questionnaireAttribute.toLowerCase().startsWith('location'));
  return hit ? hit.statement : null;
}

function dryRunTopics(factIndex: number, count: number, kind: string, repeat: number): string {
  // Deterministic, and deliberately made to COLLIDE across facts on REPEAT 0
  // only. That keeps the dry run a real control in both directions whatever the
  // arm roster is: repeat 0 must report the collision and repeats 1 and 2 must
  // report none. A detector that has only ever printed "none" is not evidence
  // of anything, and this used to be planted on the GLM arm, so it went silent
  // and unnoticed the moment that arm was dropped from the default.
  const topics = Array.from({ length: count }, (_, i) =>
    i === 0 && repeat === 0 ? 'Shared planted topic' : `${kind} topic ${factIndex}-${i}`,
  );
  return JSON.stringify(topics);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  applyTargetOverride(argv);
  const overridden = applyEndpointOverrides(argv);
  const args = parseArgs(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);

  const cohort = loadCohort(args.cohort);
  const facts = cohort.persona.facts.slice(0, args.accept);
  if (facts.length === 0) throw new Error('harness-local: --accept selected no facts.');
  const userLocation = locationOf(cohort.persona.facts);
  const existingTopics = cohort.persona.topics.map((t) => t.text);

  const run = createRunWriter({ label: args.label });
  const rows = createJsonlWriter({ dir: run.dir });
  const runId = run.dir.split('/').pop() ?? args.label;

  const catalog = args.dryRun
    ? {}
    : await fetchModelCatalog({ baseUrl: env.nearAiBaseUrl, apiKey: env.nearAiApiKey, runDir: run.dir });
  const warnings = args.dryRun ? [] : rosterWarnings(catalog, args.arms);

  // eslint-disable-next-line no-console
  console.log(
    `run      : ${runId}\ntarget   : ${env.target}` +
      `${overridden.length ? `\noverride : ${overridden.join(', ')}` : ''}` +
      `\ncohort   : ${args.cohort}, accepting ${facts.length} fact(s) sequentially` +
      `\nexisting : ${existingTopics.length} topics on the persona, all passed as excludeTopics` +
      `\narms     : ${args.arms.join(', ')}\ntotals   : ${args.totals.join(', ')}` +
      `\nrepeat   : ${args.repeat}\nvariant  : ${args.variant}` +
      `\nmode     : ${args.dryRun ? 'DRY RUN, no calls' : 'live'}\n`,
  );
  for (const w of warnings) console.warn(`!!  ${w}`);

  let emitted = 0;
  const writeRow = (row: RunRow): void => {
    rows.write(row);
    emitted += 1;
    if (args.duplicateEvery > 0 && emitted % args.duplicateEvery === 0) rows.writeDuplicate(row);
  };

  /** topic (lowercased) -> the facts it was generated under, per arm+total+rep. */
  const crossFact = new Map<string, Map<string, Set<string>>>();

  for (const total of args.totals) {
    for (let rep = 0; rep < args.repeat; rep++) {
      // Each arm walks the SAME sequential accept, so their exclude lists grow
      // the same way and the comparison stays fair.
      const acquired = new Map<string, string[]>(args.arms.map((m) => [m, [...existingTopics]]));

      for (let fi = 0; fi < facts.length; fi++) {
        const fact = facts[fi];
        const otherFacts = facts.filter((_, i) => i !== fi).map((f) => f.statement);
        const { factOnly: factOnlyCount, combo: comboCount } = splitCount(total, otherFacts.length > 0);

        for (const model of args.arms) {
          const excludeTopics = acquired.get(model) ?? [];
          // The production builder, so gear and prompts cannot drift from it.
          const calls = buildCloudBatchCallsForFact(
            {
              factStatement: fact.statement,
              userLocation,
              otherFacts,
              totalCount: total,
              excludeTopics,
            },
            `fact${fi}`,
          );

          for (const call of calls) {
            const kind = call.id.endsWith(':combo') ? 'combo' : 'factOnly';
            const callType: CallType = kind === 'combo' ? 'topicgen-combo' : 'topicgen-factOnly';
            const requested = kind === 'combo' ? comboCount : factOnlyCount;

            const result = args.dryRun
              ? {
                  content: dryRunTopics(fi, requested, kind, rep),
                  toolCalls: [], finishReason: 'stop', truncated: false,
                  usage: { promptTokens: 700, completionTokens: 60, cachedTokens: 0, reasoningTokens: 0 },
                  modelSent: model, latencyMs: 12 + fi, error: null,
                }
              : await postCompletion({
                  baseUrl: env.nearAiBaseUrl,
                  apiKey: env.nearAiApiKey,
                  model,
                  messages: [
                    { role: 'system', content: call.system },
                    { role: 'user', content: call.prompt },
                  ],
                  temperature: call.temperature,
                  maxTokens: args.maxTokens[model] ?? call.maxTokens,
                  // Read from the builder, not restated: topic-generation.ts
                  // turns thinking OFF and documents why, and this runner must
                  // not quietly disagree with it.
                  enableThinking: call.enableThinking ?? false,
                });

            const topics = result.error ? [] : parseTopicsFromOutput(result.content, fact.statement);

            // Cross-fact collision bookkeeping, per arm and per count arm.
            const bucketKey = `${model}|${total}|${rep}`;
            const bucket = crossFact.get(bucketKey) ?? new Map<string, Set<string>>();
            for (const t of topics) {
              const key = t.toLowerCase().trim();
              const owners = bucket.get(key) ?? new Set<string>();
              owners.add(fact.id);
              bucket.set(key, owners);
            }
            crossFact.set(bucketKey, bucket);

            // The exclude list grows as production's does, so the next fact in
            // this accept is told what this one already produced.
            acquired.set(model, [...(acquired.get(model) ?? []), ...topics]);

            const info = catalog[model];
            writeRow({
              rowId: newRowId(), dupOf: null, runId, repeat: rep,
              cohort: `${args.cohort}/total${total}`, turnIndex: fi,
              arm: `${model}@${total}`, callType,
              interleaveGroup: `${total}:${fi}:${kind}`, lane: 'near', surface: 'TOPICGEN',
              variant: args.variant,
              promptHash: hashMessages([
                { role: 'system', content: call.system },
                { role: 'user', content: call.prompt },
              ]),
              // The prompt depends on the exclude list, which depends on what
              // THIS arm generated for earlier facts, so only the first fact is
              // fixture-determined.
              promptDeterministic: fi === 0,
              fenceNonce: null,
              modelRequested: model, modelSent: result.modelSent,
              fallbackFrom: null, hedged: false,
              input: {
                systemPrompt: call.system,
                messages: [{ role: 'user', content: call.prompt }],
                toolSchemaNames: [],
              },
              personaStateIn: {
                factCount: facts.length,
                topicCount: excludeTopics.length,
                factsInPrompt: otherFacts.length + 1,
                turnsInPrompt: 1,
              },
              rawOutput: result.content,
              toolCalls: [],
              parsedSchema: topics,
              items: [{ id: fact.id }],
              // The ceiling the prompt asked for, against what came back. The
              // combo prompt says "at most", so over is a real violation and
              // under is expected and correct.
              requestedCount: requested,
              returnedCount: result.error ? null : topics.length,
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
  }

  await rows.close();
  const report = computeAgreement(readJsonl(rows.path), catalog);
  const text = formatAgreementReport(report);
  // eslint-disable-next-line no-console
  console.log(`\n${text}`);

  // ---- the two mechanical checks -------------------------------------------
  const overCount: string[] = [];
  const emptyYield: string[] = [];
  for (const row of readJsonl(rows.path)) {
    if (row.dupOf !== null || row.error !== null) continue;
    if (row.returnedCount !== null && row.requestedCount !== null) {
      if (row.callType === 'topicgen-factOnly' && row.returnedCount !== row.requestedCount) {
        overCount.push(`  ${row.arm} ${row.callType} fact ${row.turnIndex} rep ${row.repeat}: asked ${row.requestedCount}, got ${row.returnedCount}`);
      }
      if (row.callType === 'topicgen-combo' && row.returnedCount > row.requestedCount) {
        overCount.push(`  ${row.arm} combo fact ${row.turnIndex} rep ${row.repeat}: ceiling ${row.requestedCount}, got ${row.returnedCount} OVER`);
      }
      if (row.returnedCount === 0) {
        emptyYield.push(`  ${row.arm} ${row.callType} fact ${row.turnIndex} rep ${row.repeat}`);
      }
    }
  }

  const dupLines: string[] = [];
  for (const [bucketKey, bucket] of crossFact) {
    const collisions = [...bucket.entries()].filter(([, owners]) => owners.size > 1);
    if (collisions.length > 0) {
      dupLines.push(
        `  ${bucketKey}: ${collisions.length} topic(s) generated under more than one fact in the same accept`,
      );
      for (const [topic, owners] of collisions.slice(0, 5)) {
        dupLines.push(`      "${topic}" under ${[...owners].join(', ')}`);
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    '\nCOUNT CONTRACT (factOnly is an exact count, combo is a CEILING so under is correct)\n' +
      (overCount.length > 0 ? overCount.slice(0, 15).join('\n') : '  every call respected its count') +
      '\n\nCROSS-FACT DUPLICATES (a hard fail: excludeTopics exists to prevent these)\n' +
      (dupLines.length > 0 ? dupLines.join('\n') : '  none, no topic was generated under two facts in one accept') +
      (emptyYield.length > 0
        ? `\n\nEMPTY GENERATIONS\n${emptyYield.slice(0, 10).join('\n')}`
        : ''),
  );

  run.finish({
    args, target: env.target, rows: rows.path, agreement: report,
    countViolations: overCount.length, crossFactDuplicates: dupLines.length,
    emptyGenerations: emptyYield.length, rosterWarnings: warnings,
  });
  writeFileSync(join(run.dir, 'agreement.txt'), `${text}\n`, 'utf8');
  return report.integrityFailures.some((fl) => fl.startsWith('RUNNER BUG')) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
