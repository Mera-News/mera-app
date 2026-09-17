// harness-local — the agent-corpus CLI. THIN BY DESIGN.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/run-agent-corpus.ts \
//       --target staging --graphql-endpoint ... --auth-endpoint ... \
//       --inference-endpoint ... --scripts lib/mera-harness/eval/fixtures/scripts \
//       --variant baseline,null-control --repeat 3 [--dry-run]
//
// WHAT LIVES WHERE. The eval loop, the fixtures, the fakes and every metric
// are in lib/mera-harness/eval and are pure. This file supplies the four
// things they deliberately do not have: the NEAR caller, the staging rail, the
// JSONL sink and the reports. lib/mera-harness never imports back.
//
// Node-only: never imported by the app bundle.

import { createWriteStream, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { estimateRunCost, formatCostEstimate, type PlannedCall } from '../lib/cost-estimate';
import { costOf, fetchModelCatalog, rosterWarnings } from '../lib/model-catalog';
import { postBodyStream, SpendLimitError } from '../lib/near-call';
import { BIG_MODEL } from '../../lib/llm/constants';
// The AGENT's arms live in the harness's own module, not in
// news-harness/prompts/prompt-variants: adding them there reddened a test
// outside P1's write set, and they belong to the folder that is meant to lift
// out as its own package.
import { agentArmIds, resolveAgentArm } from '../../lib/mera-harness/core/arms';
import { NULL_CONTROL_ARM, ensureNullControlArm } from '../../lib/mera-harness/eval/null-control';

// ONCE, at module scope. registerAgentArm throws on a second registration, so
// this must not move inside a loop.
ensureNullControlArm();

import { PERSONA_SKILL_IDS } from '../../lib/mera-harness/skills/index.generated';
import { routeKindsFor } from '../../lib/mera-harness/eval/contract';
import { parseScript } from '../../lib/mera-harness/eval/script';
import { runAgentScript } from '../../lib/mera-harness/eval/run-agent-corpus';
import {
  consecutiveQuestionReport,
  routeOutcomes,
  routerReport,
  skillOutcomes,
  skillReport,
  firstProseGate,
  firstProseReport,
  groupTurns,
  inputTokenReport,
  percentile,
  proseReport,
  thinkingGearReport,
  toolValidityReport,
} from '../../lib/mera-harness/eval/agent-metrics';
import type { AgentScript, EvalModelRequest, EvalModelResult, EvalRow } from '../../lib/mera-harness/eval/types';

/**
 * Route kinds a fixture may name, derived from the skill library.
 *
 * `routeKindsFor` mirrors the core's own private mapping: the LEAF of the
 * skill id, with `generic` and a slash-less id (`router`) both meaning no
 * kind, spelled `none` in a fixture. My first version sliced the id blindly
 * and produced `router` where the core produces null, which would have scored
 * every such turn wrong.
 */
const ROUTE_KINDS: readonly string[] = routeKindsFor(PERSONA_SKILL_IDS);

interface Args {
  label: string;
  scriptsDir: string;
  models: string[];
  repeat: number;
  variants: string[];
  dryRun: boolean;
  oneShotVariant: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    label: 'agent',
    scriptsDir: 'lib/mera-harness/eval/fixtures/scripts',
    models: [BIG_MODEL],
    repeat: 3,
    variants: ['baseline'],
    dryRun: false,
    oneShotVariant: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--label') a.label = argv[++i] ?? a.label;
    else if (f === '--scripts') a.scriptsDir = argv[++i] ?? a.scriptsDir;
    else if (f === '--model' || f === '--arms') a.models = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (f === '--repeat') a.repeat = Number(argv[++i]);
    else if (f === '--variant') a.variants = (argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (f === '--one-shot-variant') a.oneShotVariant = argv[++i] ?? null;
    else if (f === '--dry-run') a.dryRun = true;
  }
  if (!Number.isFinite(a.repeat) || a.repeat < 1) throw new Error('harness-local: --repeat must be 1 or more.');
  if (a.repeat < 3) {
    // eslint-disable-next-line no-console
    console.warn(`\n!!  --repeat ${a.repeat} does not measure a noise floor. One comparison per cell is a coin flip.\n`);
  }
  if (a.variants.length === 0) throw new Error('harness-local: --variant resolved to nothing.');
  return a;
}

function loadScripts(dir: string): AgentScript[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    throw new Error(`harness-local: no scripts directory at ${dir}.`);
  }
  if (names.length === 0) throw new Error(`harness-local: ${dir} holds no .json scripts.`);
  return names.map((n) =>
    parseScript(JSON.parse(readFileSync(join(dir, n), 'utf8')), {
      routeKinds: ROUTE_KINDS,
      skillIds: PERSONA_SKILL_IDS,
    }),
  );
}

// ---------------------------------------------------------------------------
// The dry-run model: PLANTED DAMAGE ON REPEAT 0 ONLY
// ---------------------------------------------------------------------------
//
// Copying the discipline that run-topicgen-corpus's collision plant already
// uses. Every console block must print NON-ZERO for repeat 0 and ZERO for
// repeats 1 and 2. A detector that has only ever seen clean input cannot fail,
// and this repo has already had a control go silent unnoticed once.

function dryRunModel(repeat: number): (req: EvalModelRequest) => Promise<EvalModelResult> {
  let call = 0;
  return async (req: EvalModelRequest): Promise<EvalModelResult> => {
    call += 1;
    const damaged = repeat === 0;
    const isRoute = req.role === 'route';
    const toolCalls = isRoute
      ? [
          {
            name: damaged && call === 1 ? 'teleport' : 'lookup_place',
            // Malformed JSON on the damaged path, so the unparseable counter fires.
            argumentsRaw: damaged && call === 1 ? '{"query": ' : JSON.stringify({ query: 'Amsterdam' }),
          },
        ]
      : [];
    return {
      content: isRoute ? '' : damaged ? 'A reply — with an em dash.' : 'A plain reply.',
      toolCalls,
      finishReason: damaged && !isRoute ? 'length' : 'stop',
      truncated: damaged && !isRoute,
      usage: { promptTokens: 600, completionTokens: 40, cachedTokens: 200, reasoningTokens: damaged ? 30 : 0 },
      modelSent: req.model,
      latencyMs: 20,
      ttVisibleMs: isRoute ? null : 200,
      error: null,
    };
  };
}

function toRunRow(e: EvalRow, runId: string, catalog: Awaited<ReturnType<typeof fetchModelCatalog>>): RunRow {
  const info = catalog[e.modelRequested];
  return {
    rowId: newRowId(), dupOf: null, runId, repeat: e.repeat,
    // THE SCRIPT ID, not the cohort. cellKey identifies a cell by cohort, and
    // three production scripts share the cohort "production": their turn-0
    // leg-0 rows then collapse into ONE cell holding three different prompts
    // and the integrity check reports a RUNNER BUG that is really a key
    // collision. The G0 dry run caught exactly that. The script id is also a
    // better rater label, since it still says "adversarial" where it matters.
    cohort: e.scriptId, turnIndex: e.turnIndex, legIndex: e.legIndex,
    arm: e.arm, callType: e.callType as CallType,
    interleaveGroup: e.interleaveGroup, lane: 'near', surface: 'AGENT', variant: e.variant,
    promptHash: hashMessages([{ role: 'system', content: e.systemPrompt }, ...e.messages]),
    promptDeterministic: e.promptDeterministic,
    fenceNonce: null,
    modelRequested: e.modelRequested, modelSent: e.modelSent,
    fallbackFrom: null, hedged: false,
    input: { systemPrompt: e.systemPrompt, messages: e.messages, toolSchemaNames: e.toolSchemaNames },
    personaStateIn: { factCount: 0, topicCount: 0, factsInPrompt: 0, turnsInPrompt: e.messages.filter((m) => m.role === 'user').length },
    rawOutput: e.rawOutput,
    toolCalls: e.toolCalls.map((t) => ({
      name: t.name, argumentsRaw: t.argumentsRaw, parsed: t.parsed, schemaValid: t.schemaValid,
    })),
    parsedSchema: e.topics,
    items: e.items,
    requestedCount: null, returnedCount: e.topics ? e.topics.length : null,
    personaStateDelta: null,
    finishReason: e.finishReason, truncated: e.truncated,
    reasoningLeak: false,
    usage: e.usage,
    cost: e.usage && info
      ? {
          inputTokens: e.usage.promptTokens,
          cachedInputTokens: e.usage.cachedTokens,
          outputTokens: e.usage.completionTokens,
          usd: costOf(info, e.usage),
        }
      : null,
    latencyMs: e.latencyMs, ttVisibleMs: e.ttVisibleMs, error: e.error,
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // FIRST statement: dotenv never overwrites a variable already in
  // process.env, which is the whole reason this ordering works. .env.harness
  // ships pointed at PROD.
  applyTargetOverride(argv);
  const overridden = applyEndpointOverrides(argv);
  const args = parseArgs(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);

  // The floor arm must exist before anything else is checked: every bar here
  // is baseline minus the floor, and without the floor there is nothing to
  // subtract from. ensureNullControlArm() at module scope puts it there; this
  // catches a future tidy-away of that call.
  if (!agentArmIds().includes(NULL_CONTROL_ARM)) {
    throw new Error(
      `harness-local: '${NULL_CONTROL_ARM}' is not registered, so ensureNullControlArm() did not ` +
        'run. A run that cannot measure its own noise floor produces unfalsifiable deltas.',
    );
  }

  // Resolve EVERY arm before a single call: an unknown id in second position
  // would otherwise throw partway through a PAID run with the first arm
  // already billed. A typo'd arm that quietly scored the baseline would be
  // written up as a real result.
  for (const v of args.variants) {
    try {
      resolveAgentArm(v);
    } catch (err) {
      throw new Error(
        `harness-local: --variant '${v}' is not a registered agent arm. Known: ${agentArmIds().join(', ')}. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const scripts = loadScripts(args.scriptsDir);
  const run = createRunWriter({ label: args.label });
  const rows = createJsonlWriter({ dir: run.dir });
  const runId = run.dir.split('/').pop() ?? args.label;

  let catalog: Awaited<ReturnType<typeof fetchModelCatalog>> = {};
  let catalogError: string | null = null;
  try {
    catalog = await fetchModelCatalog({
      baseUrl: env.nearAiBaseUrl, apiKey: env.nearAiApiKey,
      runDir: args.dryRun ? undefined : run.dir,
    });
  } catch (err) {
    catalogError = err instanceof Error ? err.message : String(err);
  }
  const warnings = catalogError ? [`CATALOGUE UNAVAILABLE: ${catalogError}`] : rosterWarnings(catalog, args.models);
  const planned: PlannedCall[] = [];

  // eslint-disable-next-line no-console
  console.log(
    `run      : ${runId}\nrun dir  : ${run.dir}\ntarget   : ${env.target}` +
      `${overridden.length ? `\noverride : ${overridden.join(', ')}` : ''}` +
      `\nscripts  : ${scripts.map((s) => s.id).join(', ')}` +
      `\nmodels   : ${args.models.join(', ')}\nrepeat   : ${args.repeat}` +
      `\nvariants : ${args.variants.join(', ')} (interleaved per turn)` +
      `\nmode     : ${args.dryRun ? 'DRY RUN, no calls' : 'live, STREAMED'}\n`,
  );
  for (const w of warnings) console.warn(`!!  ${w}`);

  const collected: EvalRow[] = [];
  const mismatches: string[] = [];
  /** Set when a 402 ended the run. The partial rows are still reported: the
   *  instruction is to stop on a spend limit and KEEP what was collected. */
  let spendLimit: SpendLimitError | null = null;

  // Rows go to DISK as they arrive, not at the end. Accumulating and writing
  // after the loop means a 402 on call 400 of 624 loses all 399 rows that were
  // already paid for, which is the opposite of stopping and keeping them.
  // A SECOND FILE, AT FULL FIDELITY. RunRow has nowhere to put the agent's own
  // fields — endedOn, awaitingUser, factKind, topics, dropped — so the JSONL
  // that the other three runners share silently loses them and a post-hoc
  // re-read cannot recompute consecutive questions, leg verdicts or topic
  // scoring. The live console blocks read the in-memory rows and are complete;
  // this is what makes the RUN DIRECTORY complete too, which is the copy that
  // outlives the process.
  const evalRowsPath = join(run.dir, 'eval-rows.jsonl');
  const evalRows = createWriteStream(evalRowsPath, { flags: 'a' });

  const emit = (row: EvalRow): void => {
    collected.push(row);
    rows.write(toRunRow(row, runId, catalog));
    evalRows.write(`${JSON.stringify(row)}\n`);
  };

  try {
  for (let rep = 0; rep < args.repeat; rep++) {
    // Variants interleave with models so both arms sit in one run and one time
    // window: NEAR drifts enough between runs that a control arm which could
    // not affect anything still moved a kept count by 7.
    for (const variant of args.variants) {
      for (const model of args.models) {
        const dry = dryRunModel(rep);
        const callModel = async (req: EvalModelRequest): Promise<EvalModelResult> => {
          planned.push({
            model,
            systemChars: req.systemPrompt.length,
            promptChars: req.messages.reduce((n, m) => n + m.content.length, 0),
            maxOutputTokens: req.maxTokens ?? 1024,
          });
          if (args.dryRun) return dry(req);
          const body: Record<string, unknown> = {
            model,
            messages: [{ role: 'system', content: req.systemPrompt }, ...req.messages],
            ...(req.tools ? { tools: req.tools, tool_choice: 'auto' } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
            chat_template_kwargs: { enable_thinking: req.enableThinking ?? false },
          };
          const r = await postBodyStream(env.nearAiBaseUrl, env.nearAiApiKey, body, 120_000, req.onDelta);
          return { ...r, ttVisibleMs: r.ttVisibleMs };
        };

        for (const script of scripts) {
          await runAgentScript(script, {
            callModel,
            sink: emit,
            arm: `${model}@${variant}`,
            variant,
            model,
            repeat: rep,
            skillIds: PERSONA_SKILL_IDS,
            onChoiceOptionMismatch: (d) =>
              mismatches.push(`  ${script.id} turn ${d.turnIndex}: expected "${d.expected}", offered ${JSON.stringify(d.offered)}`),
          });
        }
      }
    }
  }

  } catch (err) {
    // A spend limit ends the run here rather than at the top level, so the
    // writer is closed and everything already paid for survives.
    if (!(err instanceof SpendLimitError)) throw err;
    spendLimit = err;
  }
  await rows.close();
  await new Promise<void>((res, rej) => evalRows.end((e?: Error | null) => (e ? rej(e) : res())));

  if (spendLimit) {
    // eslint-disable-next-line no-console
    console.error(
      `\n!!  SPEND LIMIT REACHED after ${collected.length} row(s). The run stopped on the FIRST\n` +
        `    refusal and KEPT what it had; the report below covers the partial corpus only and\n` +
        `    its arms are NOT count-matched, so no arm comparison in it is valid.\n` +
        `    spent : $${spendLimit.spent ?? 'unknown'}\n    limit : $${spendLimit.limit ?? 'unknown'}\n`,
    );
  }

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log(`\n${formatCostEstimate(estimateRunCost(planned, catalog))}\n`);
  }

  const report = computeAgreement(readJsonl(rows.path), catalog);
  const text = formatAgreementReport(report);
  // eslint-disable-next-line no-console
  console.log(`\n${text}`);
  printAgentBlocks(collected, args.oneShotVariant, mismatches);

  run.finish({
    args, target: env.target, rows: rows.path, agreement: report,
    rosterWarnings: warnings, spendLimited: spendLimit !== null,
    evalRows: evalRowsPath,
  });
  writeFileSync(join(run.dir, 'agreement.txt'), `${text}\n`, 'utf8');
  if (spendLimit) return 3;
  return report.integrityFailures.some((f) => f.startsWith('RUNNER BUG')) ? 1 : 0;
}

/** Damage before quality, quality before cost. */
function printAgentBlocks(rows: EvalRow[], oneShotVariant: string | null, mismatches: string[]): void {
  const turns = groupTurns(rows);
  const out: string[] = [];

  // READ THIS BEFORE THE USABLE LINE ABOVE. `usable` counts an empty content
  // field as unusable, which is right for a single-call runner and WRONG for a
  // routing leg: that leg's whole job is to emit tool calls and no prose, so
  // roughly half of an agent run is empty BY DESIGN and the arm-level usable
  // rate floors near 50%. Do not read a low usable rate here as a failing arm
  // without splitting it by call type first.
  const routeLegs = rows.filter((r) => r.callType === 'agent-route');
  const emptyRouteLegs = routeLegs.filter((r) => r.rawOutput.trim() === '').length;
  out.push(
    `\nUSABLE, CORRECTED FOR ROUTING LEGS: ${emptyRouteLegs} of ${routeLegs.length} agent-route rows ` +
      'carry no prose, which is correct for them. The arm-level USABLE line above counts those as ' +
      'unusable and therefore under-reports every agent arm.',
  );

  // THE HEADLINE METRIC, and it was implemented and left unwired for a whole
  // completed run: the corpus produced tool, latency and cost tables and no
  // router accuracy at all.
  const rr = routerReport(routeOutcomes(turns));
  out.push('\nROUTER DECISIONS (per cohort, never pooled: the adversarial cohort is noisy for reasons');
  out.push('unconnected to any arm, and pooling hides which cohort moved)');
  for (const [cohort, c] of Object.entries(rr.byCohort)) {
    const rate = c.n === 0 ? '-' : `${((c.correct / c.n) * 100).toFixed(1)}%`;
    // The three production cases are n=9 per arm; a percentage there is one
    // decision wide, so they print as COUNTS.
    const shown = c.n < 12 ? `${c.correct}/${c.n}` : `${c.correct}/${c.n}  ${rate}`;
    out.push(`  ${cohort.padEnd(26)} ${shown}`);
  }
  out.push(`  routes that did not parse: ${rr.unparsed} (never defaulted to a kind)`);
  for (const [exp, row] of Object.entries(rr.confusion)) {
    const wrong = Object.entries(row).filter(([k]) => k !== exp);
    if (wrong.length > 0) out.push(`  expected ${exp} -> ${wrong.map(([k, v]) => `${k} x${v}`).join(', ')}`);
  }

  const sr = skillReport(skillOutcomes(turns), PERSONA_SKILL_IDS);
  out.push('\nSKILL LOADING (its own alphabet: 1-in-13 chance against the route block\u2019s 1-in-5,');
  out.push('so the two percentages are not comparable to each other)');
  out.push(`  correct ${sr.outcomes.correct}, wrong id ${sr.outcomes['wrong-id']}, ` +
    `none loaded ${sr.outcomes['none-loaded']}, id that does not exist ${sr.outcomes['nonexistent-id']}`);
  out.push(`  route correct but skill wrong: ${sr.routeCorrectSkillWrong}`);

  const tools = toolValidityReport(rows);
  out.push('\nTOOL CALLS (unparseable and schema-invalid are different findings, never one rate)');
  for (const [name, t] of Object.entries(tools.byTool)) {
    out.push(`  ${name.padEnd(22)} calls ${String(t.calls).padStart(4)}  unparseable ${String(t.unparseable).padStart(3)}  schema-invalid ${String(t.schemaInvalid).padStart(3)}`);
  }
  out.push(`  unknown tool names invented: ${tools.unknownToolCalls}`);

  const gear = thinkingGearReport(rows);
  out.push('\nTHINKING GEAR (NEAR answers 200 for an unknown kwarg, so only this says the switch took)');
  out.push(`  requested off ${gear.requestedOff}, requested on ${gear.requestedOn}, REQUESTED OFF BUT REASONED ${gear.requestedOffButReasoned}`);

  const cq = consecutiveQuestionReport(turns);
  out.push(`\nCONSECUTIVE QUESTIONS (must be 0)  ${cq.passed ? 'PASS' : `FAIL, ${cq.pairs.length} pair(s)`}`);
  for (const p of cq.pairs.slice(0, 8)) out.push(`  ${p.arm} ${p.scriptId} turns ${p.firstTurn} and ${p.secondTurn}`);

  const fp = firstProseReport(turns);
  out.push('\nTIME TO FIRST PROSE (turn-level; per-leg ttVisible cannot see an extra routing leg)');
  for (const [arm, vals] of Object.entries(fp.byArm)) {
    out.push(`  ${arm.padEnd(34)} n ${String(vals.length).padStart(4)}  p50 ${String(percentile(vals, 0.5) ?? '-').padStart(6)}  p95 ${String(percentile(vals, 0.95) ?? '-').padStart(6)}`);
  }
  out.push(`  turns with no prose, EXCLUDED rather than zeroed: ${fp.turnsWithoutProse}`);
  if (oneShotVariant) {
    const control = Object.entries(fp.byArm).find(([a]) => a.endsWith(`@${oneShotVariant}`))?.[1] ?? [];
    for (const [arm, vals] of Object.entries(fp.byArm)) {
      if (arm.endsWith(`@${oneShotVariant}`)) continue;
      const g = firstProseGate(vals, control);
      out.push(`  GATE ${arm}: ${g.passed ? 'PASS' : 'FAIL'} (p50 ${g.armP50} vs ${g.controlP50}, p95 ${g.armP95} vs ${g.controlP95})`);
      out.push(`    ${g.biasNote}`);
    }
  } else {
    out.push('  no --one-shot-variant given, so the gate is NOT evaluated. It is a ratio against the');
    out.push('  production control and means nothing without it.');
  }

  const it = inputTokenReport(turns);
  out.push('\nINPUT TOKENS (the agent’s central cost claim; cached shown apart, never folded in)');
  for (const [arm, vals] of Object.entries(it.perTurn)) {
    const cached = it.cachedPerTurn[arm] ?? [];
    out.push(`  ${arm.padEnd(34)} per-turn p50 ${String(percentile(vals, 0.5) ?? '-').padStart(6)}  cached p50 ${String(percentile(cached, 0.5) ?? '-').padStart(6)}`);
  }

  const pr = proseReport(rows);
  out.push(`\nREPLY PROSE  rows with prose ${pr.rowsWithProse}, banned dash ${pr.bannedDash} (rated only over rows that HAVE prose)`);

  if (mismatches.length > 0) {
    out.push('\nCHOICE OPTION MISMATCHES (the fixture’s choice was sent anyway, to keep arms comparable)');
    out.push(...mismatches.slice(0, 10));
  }

  // eslint-disable-next-line no-console
  console.log(out.join('\n'));
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // A spend limit ends the run on the FIRST refusal. Recording it per call
    // produces a file of empty rows that reads as a model failing.
    if (err instanceof SpendLimitError) {
      // eslint-disable-next-line no-console
      console.error(
        `\nSPEND LIMIT REACHED, run aborted on the first refusal.\n` +
          `  spent : $${err.spent ?? 'unknown'}\n  limit : $${err.limit ?? 'unknown'}\n` +
          `  rows written so far are in the run directory printed above.\n  provider said: ${err.message}\n`,
      );
      process.exit(3);
    }
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
