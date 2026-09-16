// harness-local — the chat persona-prompt runner.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/run-persona-corpus.ts \
//       --target staging --repeat 3 [--cohorts good,confused,adversarial,heavy] \
//       [--model <id>] [--variant baseline] [--dry-run]
//
// WHAT IT MEASURES. The shipped persona-update prompt and tool schema, driven
// through four scripted cohorts, repeated, with persona state carried ACROSS
// turns so the cohorts that depend on history mean something.
//
// The model default is BIG_MODEL, unchanged: the chat path needs function tool
// calling with schema-conformant arguments, which is a different requirement
// from the scoring path, so it keeps its own roster.
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
import { createJsonlWriter, hashMessages, newRowId, type RowToolCall, type RunRow } from '../lib/jsonl-writer';
import { computeAgreement, formatAgreementReport, readJsonl } from '../lib/agreement';
import { estimateRunCost, formatCostEstimate, type PlannedCall } from '../lib/cost-estimate';
import { costOf, fetchModelCatalog, rosterWarnings } from '../lib/model-catalog';
import { hasReasoningLeak, postBody, SpendLimitError } from '../lib/near-call';
import {
  buildChatTurnBody,
  withContextOnLastUserTurn,
  type ChatWireMessage,
} from '../lib/chat-turn';
import {
  applyToolCalls,
  COHORTS,
  freshState,
  loadCohort,
  measureFactsInPrompt,
  measureTurnsInPrompt,
  PROMPT_CAPS,
  renderKnownFacts,
  type CorpusPersona,
} from '../lib/corpus';
import { BIG_MODEL } from '../../lib/llm/constants';
import {
  buildPersonaUpdateContext,
  buildPersonaUpdateStaticPrompt,
  buildToolDefinitions,
} from '../../lib/news-harness/prompts/persona-prompts';

interface Args {
  label: string;
  cohorts: string[];
  models: string[];
  repeat: number;
  variants: string[];
  dryRun: boolean;
  duplicateEvery: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    label: 'persona',
    cohorts: [...COHORTS],
    models: [BIG_MODEL],
    repeat: 3,
    variants: ['baseline'],
    dryRun: false,
    duplicateEvery: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i] ?? args.label;
    else if (a === '--cohorts') args.cohorts = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--model' || a === '--arms') args.models = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--variant') {
      args.variants = (argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    }
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--duplicate-every') args.duplicateEvery = Number(argv[++i]);
  }
  if (!Number.isFinite(args.repeat) || args.repeat < 1) {
    throw new Error('harness-local: --repeat must be 1 or more.');
  }
  if (args.repeat < 3) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n!!  --repeat ${args.repeat} does not measure a noise floor. One comparison per cell is a coin flip.\n`,
    );
  }
  if (args.variants.length === 0) throw new Error('harness-local: --variant resolved to nothing.');
  const unknown = args.cohorts.filter((c) => !(COHORTS as readonly string[]).includes(c));
  if (unknown.length > 0) {
    throw new Error(`harness-local: unknown cohort(s): ${unknown.join(', ')}. Known: ${COHORTS.join(', ')}.`);
  }
  return args;
}

/** Parses a tool call's arguments. An unparseable or empty `{}` is a real
 *  result, not an error: a truncated tool call loses its arguments, which is
 *  exactly what the truncation flag on the row exists to explain. */
function parseToolCall(name: string, argumentsRaw: string): RowToolCall {
  let parsed: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(argumentsRaw);
    if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  // saveExtractedFacts is the only tool with a required payload worth checking
  // mechanically; everything else is judged by the rater.
  const schemaValid =
    name === 'saveExtractedFacts'
      ? Array.isArray(parsed?.extracted_user_information)
      : parsed !== null;
  return { name, argumentsRaw, parsed, schemaValid };
}

function dryRunToolCalls(cohort: string, turnIndex: number): { name: string; argumentsRaw: string }[] {
  // Deterministic and cohort-shaped, so a dry run exercises the state machine:
  // the heavy cohort keeps adding facts and crosses the context cap.
  const statement =
    cohort === 'heavy' ? `Dry run heavy fact ${turnIndex}` : `Dry run ${cohort} fact ${turnIndex}`;
  return [
    {
      name: 'saveExtractedFacts',
      argumentsRaw: JSON.stringify({
        extracted_user_information: [{ statement, questionnaire_attribute: 'interest: topic' }],
      }),
    },
  ];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  applyTargetOverride(argv);
  const overridden = applyEndpointOverrides(argv);
  const args = parseArgs(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);

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
  const warnings = catalogError ? [`CATALOGUE UNAVAILABLE: ${catalogError}`] : rosterWarnings(catalog, args.models);
  const planned: PlannedCall[] = [];

  // One system prompt per variant. An unknown id throws HERE, before any call.
  const systemByVariant = new Map(
    args.variants.map((v) => [
      v,
      buildPersonaUpdateStaticPrompt({
        surface: 'CONFIG',
        includeToolFormat: false, // the cloud path uses native tool calling
        languageName: 'English',
        mode: 'CLOUD',
        promptVariant: v,
      }),
    ]),
  );
  const tools = buildToolDefinitions('CONFIG');
  const toolNames = tools.map((t) => t.function.name);

  // eslint-disable-next-line no-console
  console.log(
    `run      : ${runId}\nrun dir  : ${run.dir}\ntarget   : ${env.target}` +
      `${overridden.length ? `\noverride : ${overridden.join(', ')}` : ''}` +
      `\ncohorts  : ${args.cohorts.join(', ')}\nmodels   : ${args.models.join(', ')}` +
      `\nrepeat   : ${args.repeat}\nvariants : ${args.variants.join(', ')} (interleaved per turn)` +
      `\ncaps     : facts-in-context ${PROMPT_CAPS.maxFactsInContext}, history user turns ${PROMPT_CAPS.maxHistoryUserTurns}` +
      `\nmode     : ${args.dryRun ? 'DRY RUN, no calls' : 'live'}\n`,
  );
  for (const w of warnings) console.warn(`!!  ${w}`);

  let emitted = 0;
  const writeRow = (row: RunRow): void => {
    rows.write(row);
    emitted += 1;
    if (args.duplicateEvery > 0 && emitted % args.duplicateEvery === 0) rows.writeDuplicate(row);
  };

  for (const cohortName of args.cohorts) {
    const cohort = loadCohort(cohortName);
    for (let rep = 0; rep < args.repeat; rep++) {
      // Prompt variants interleave with models: both arms in one run and one
      // time window, so between-run drift cannot be mistaken for a prompt effect.
      for (const variantId of args.variants) {
      for (const model of args.models) {
        const systemPrompt = systemByVariant.get(variantId) as string;
        // A repeat ALWAYS starts from the cohort's own state. Carrying the
        // previous repeat's mutations would make repeat 3 a different
        // experiment from repeat 1 while still reporting one floor.
        let state: CorpusPersona = freshState(cohort.persona);
        const history: ChatWireMessage[] = [];

        for (const turn of cohort.turns) {
          history.push({ role: 'user', content: turn.user });

          const knownFactsList = renderKnownFacts(state);
          const context = buildPersonaUpdateContext({ knownFactsList });
          const messages = withContextOnLastUserTurn(systemPrompt, context, history);
          const body = buildChatTurnBody({ model, messages, tools });

          planned.push({
            model,
            systemChars: systemPrompt.length,
            promptChars: messages.reduce((n, m) => n + m.content.length, 0) - systemPrompt.length,
            maxOutputTokens: Number(body.max_tokens ?? 0),
          });
          const result = args.dryRun
            ? {
                content: `Dry run reply ${turn.index}.`,
                toolCalls: dryRunToolCalls(cohortName, turn.index),
                finishReason: 'stop', truncated: false,
                usage: { promptTokens: 1200, completionTokens: 180, cachedTokens: 0, reasoningTokens: 120 },
                modelSent: model, latencyMs: 20 + turn.index, error: null,
              }
            : await postBody(env.nearAiBaseUrl, env.nearAiApiKey, body);

          const toolCalls = result.toolCalls.map((t) => parseToolCall(t.name, t.argumentsRaw));
          const applied = applyToolCalls(state, toolCalls.map((t) => ({ name: t.name, parsed: t.parsed })));

          const info = catalog[model];
          writeRow({
            rowId: newRowId(), dupOf: null, runId, repeat: rep,
            cohort: cohortName, turnIndex: turn.index, arm: `${model}@${variantId}`,
            callType: 'chat-extraction',
            interleaveGroup: `${cohortName}:${turn.index}`, lane: 'near', surface: 'CONFIG',
            variant: variantId,
            promptHash: hashMessages(messages),
            // Only turn 0 is fixture-determined. After that the prompt carries
            // what the model itself saved, so repeats diverge by design.
            promptDeterministic: turn.index === 0,
            fenceNonce: null,
            modelRequested: model, modelSent: result.modelSent,
            fallbackFrom: null, hedged: false,
            input: { systemPrompt, messages, toolSchemaNames: toolNames },
            personaStateIn: {
              factCount: state.facts.length,
              topicCount: state.topics.length,
              // MEASURED from the string that was hashed and sent, so the
              // context cap is observed rather than assumed.
              factsInPrompt: measureFactsInPrompt(knownFactsList),
              turnsInPrompt: measureTurnsInPrompt(messages),
            },
            rawOutput: result.content,
            toolCalls,
            parsedSchema: null,
            items: null,
            requestedCount: null, returnedCount: null,
            personaStateDelta: {
              added: applied.delta.added,
              conflicts: applied.delta.conflicts,
              rejectedByRails: applied.delta.rejectedByRails,
            },
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

          // The assistant turn goes into history so the next turn sees the
          // conversation that gave it meaning, and the state carries forward so
          // the confused and heavy cohorts test what they exist to test.
          history.push({ role: 'assistant', content: result.content });
          state = applied.state;
        }
      }
      }
    }
  }

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log(`\n${formatCostEstimate(estimateRunCost(planned, catalog))}\n`);
  }

  await rows.close();
  const report = computeAgreement(readJsonl(rows.path), catalog);
  const text = formatAgreementReport(report);
  // eslint-disable-next-line no-console
  console.log(`\n${text}`);

  // What the context cap actually did, per cohort. This is the R7 observation:
  // it has to be read off the prompts, not predicted from the constant.
  const capLines: string[] = [];
  for (const row of readJsonl(rows.path)) {
    if (row.dupOf !== null) continue;
    if (row.personaStateIn.factCount > row.personaStateIn.factsInPrompt) {
      capLines.push(
        `  ${row.cohort} turn ${row.turnIndex} rep ${row.repeat}: ` +
          `${row.personaStateIn.factCount} facts held, ${row.personaStateIn.factsInPrompt} reached the prompt`,
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nCONTEXT CAP (facts-in-context ${PROMPT_CAPS.maxFactsInContext}), measured from the prompts that were sent\n` +
      (capLines.length > 0
        ? capLines.slice(0, 12).join('\n') + (capLines.length > 12 ? `\n  ... and ${capLines.length - 12} more turns` : '')
        : '  no turn exceeded the cap in this run'),
  );

  run.finish({ args, target: env.target, rows: rows.path, agreement: report, rosterWarnings: warnings });
  writeFileSync(join(run.dir, 'agreement.txt'), `${text}\n`, 'utf8');
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
