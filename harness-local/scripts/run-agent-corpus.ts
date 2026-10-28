// harness-local — the agent-corpus CLI. THIN BY DESIGN.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/run-agent-corpus.ts \
//       --target staging --graphql-endpoint ... --auth-endpoint ... \
//       --inference-endpoint ... --scripts lib/mera-harness/eval/fixtures/scripts \
//       --variant baseline,null-control --repeat 3 [--dry-run]
//       [--tier decision | --only backref:2,3 ...] [--lanes 4]
//
// WHAT LIVES WHERE. The eval loop, the fixtures, the fakes and every metric
// are in lib/mera-harness/eval and are pure. This file supplies the four
// things they deliberately do not have: the NEAR caller, the staging rail, the
// JSONL sink and the reports. lib/mera-harness never imports back.
//
// Node-only: never imported by the app bundle.

import { createWriteStream, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { TWINS, leg0Collisions } from '../lib/arm-distinctness';
import { join } from 'node:path';

import { loadHarnessEnv } from '../config/env';
import {
  applyEndpointOverrides,
  applyTargetOverride,
  requireStagingTarget,
} from '../lib/staging-guard';
import { createRunWriter } from '../lib/run-writer';
import { addOnly, erroredCells, loadTier, runPool, selectTurns, type TurnSelection } from '../lib/tiers';
import { createJsonlWriter, hashMessages, newRowId, type CallType, type RunRow } from '../lib/jsonl-writer';
import { computeAgreement, formatAgreementReport, readJsonl } from '../lib/agreement';
import { estimateRunCost, formatCostEstimate, type PlannedCall } from '../lib/cost-estimate';
import { costOf, fetchModelCatalog, rosterWarnings } from '../lib/model-catalog';
import { DEFAULT_STALL_TIMEOUT_MS, postBodyStream, postBodyStreamTextTools, SpendLimitError } from '../lib/near-call';
import { BIG_MODEL } from '../../lib/llm/constants';
// The AGENT's arms live in the harness's own module, not in
// news-harness/prompts/prompt-variants: adding them there reddened a test
// outside P1's write set, and they belong to the folder that is meant to lift
// out as its own package.
import { agentArmIds, resolveAgentArm } from '../../lib/mera-harness/core/arms';
import { NULL_CONTROL_ARM, ensureNullControlArm } from '../../lib/mera-harness/eval/null-control';
import {
  closingWiringFailures,
  ensureForcedOfferClosingArms,
  isClosingLeg,
} from '../../lib/mera-harness/eval/forced-offer-closing';

// ONCE, at module scope. registerAgentArm throws on a second registration, so
// this must not move inside a loop.
ensureNullControlArm();
ensureForcedOfferClosingArms();
// The onemera arms are the scout's file, landing separately. A require inside a
// try, not an import: with the file absent the runner still works and the arms
// are simply unknown (an unknown --variant then fails at startup, as any typo).
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const onemera = require('../../lib/mera-harness/eval/onemera-arms') as { ensureOnemeraArms?: () => void };
  onemera.ensureOnemeraArms?.();
} catch (err) {
  if ((err as { code?: string }).code !== 'MODULE_NOT_FOUND') throw err;
}

import { PERSONA_SKILL_IDS, PERSONA_SKILL_INDEX } from '../../lib/mera-harness/skills/index.generated';
import { moreOptionsReport, trackReport } from '../../lib/mera-harness/eval/track-metrics';
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
  proposalReport,
  cardReport,
  offerGuardReport,
  replyCheckReport,
  silentTurnReport,
  thinkingGearReport,
  toolValidityReport,
} from '../../lib/mera-harness/eval/agent-metrics';
import type { AgentScript, EvalModelRequest, EvalModelResult, EvalRow } from '../../lib/mera-harness/eval/types';
import { REPLY_SCRIPT_MIN_SHARE } from '../../lib/mera-harness/eval/copy-rules';
import { MERA_EXPLAINER_SECTIONS } from '../../lib/chat-tools/mera-explainer-content';

/** explainMera as the device answers it (handleExplainMera, minus its lazy
 *  require): the REAL reference text. The eval's own fake returns a
 *  placeholder, and a plan answer scored against a placeholder can only pass
 *  by inventing the figure. */
async function realExplainMera(args: { topics: string[] }): Promise<Record<string, unknown>> {
  const sections = MERA_EXPLAINER_SECTIONS as Record<string, string>;
  const availableTopics = Object.keys(sections);
  const topics = Array.isArray(args.topics) ? args.topics.slice(0, 3) : [];
  if (topics.length === 0) return { error: 'topics must be a non-empty array of topic ids', availableTopics };
  const unknown = topics.filter((t) => typeof t !== 'string' || !(t in sections));
  if (unknown.length > 0) return { error: `Unknown topic(s): ${unknown.map(String).join(', ')}`, availableTopics };
  return { sections: [...new Set(topics)].map((topic) => ({ topic, text: sections[topic] })) };
}

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
  /** Re-runs repeats under their ORIGINAL index, so an errored repeat can be
   *  replaced beside the others and the arms stay interleaved. */
  repeatStart: number;
  variants: string[];
  dryRun: boolean;
  /** Abort a model call that sends no byte for this long; retried once, then error "stall". */
  stallTimeoutMs: number;
  oneShotVariant: string | null;
  /** `native` sends a `tools` field (cleartext on the app's wire); `text` is
   *  the app's E2EE text protocol. Several interleave like variants. */
  toolProtocols: ('native' | 'text' | 'text-xml' | 'text-xml-first' | 'text-xml-first-soft' | 'text-marker')[];
  /** `--pairs variant+protocol,...`: exactly these arms, instead of every
   *  variant crossed with every protocol. */
  pairs: { variant: string; protocol: Args['toolProtocols'][number] }[] | null;
  /** `--tier <name>` (tiers.json) or `--only script[:i,j]` (repeatable); null sends every turn. */
  tier: string | null;
  only: TurnSelection | null;
  /** Jobs (one script, one arm, one repeat) in flight at once. */
  lanes: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    label: 'agent',
    scriptsDir: 'lib/mera-harness/eval/fixtures/scripts',
    models: [BIG_MODEL],
    repeat: 3,
    repeatStart: 0,
    variants: ['baseline'],
    dryRun: false,
    stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
    oneShotVariant: null,
    toolProtocols: ['native'],
    pairs: null,
    tier: null,
    only: null,
    lanes: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--label') a.label = argv[++i] ?? a.label;
    else if (f === '--scripts') a.scriptsDir = argv[++i] ?? a.scriptsDir;
    else if (f === '--model' || f === '--arms') a.models = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (f === '--repeat') a.repeat = Number(argv[++i]);
    else if (f === '--repeat-start') a.repeatStart = Number(argv[++i]);
    else if (f === '--variant') a.variants = (argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (f === '--one-shot-variant') a.oneShotVariant = argv[++i] ?? null;
    else if (f === '--dry-run') a.dryRun = true;
    else if (f === '--stall-timeout-ms') a.stallTimeoutMs = Number(argv[++i]);
    else if (f === '--tier') {
      a.tier = argv[++i] ?? '';
      // A bare `--tier` would silently send the full corpus, live and paid.
      if (!a.tier || a.tier.startsWith('--')) throw new Error('harness-local: --tier needs a name from tiers.json.');
    }
    else if (f === '--only') addOnly((a.only ??= {}), argv[++i] ?? '');
    else if (f === '--lanes') a.lanes = Number(argv[++i]);
    else if (f === '--tool-protocol') {
      const list = (argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      for (const p of list) {
        if (!['native', 'text', 'text-xml', 'text-xml-first', 'text-xml-first-soft', 'text-marker'].includes(p)) throw new Error(`harness-local: --tool-protocol takes native,text,text-xml,text-xml-first,text-xml-first-soft,text-marker (got ${p}).`);
      }
      a.toolProtocols = list as Args['toolProtocols'];
    } else if (f === '--pairs') {
      a.pairs = (argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((p) => {
        const plus = p.indexOf('+');
        const protocol = plus < 0 ? '' : p.slice(plus + 1);
        if (plus < 1 || !['native', 'text', 'text-xml', 'text-xml-first', 'text-xml-first-soft', 'text-marker'].includes(protocol)) {
          throw new Error(`harness-local: --pairs takes variant+protocol,... (got ${p}).`);
        }
        return { variant: p.slice(0, plus), protocol: protocol as Args['toolProtocols'][number] };
      });
    }
  }
  if (a.pairs) {
    // The header and the startup variant check read these two lists.
    a.variants = [...new Set(a.pairs.map((x) => x.variant))];
    a.toolProtocols = [...new Set(a.pairs.map((x) => x.protocol))];
  }
  if (!Number.isFinite(a.repeat) || a.repeat < 1) throw new Error('harness-local: --repeat must be 1 or more.');
  if (a.repeat < 3) {
    // eslint-disable-next-line no-console
    console.warn(`\n!!  --repeat ${a.repeat} does not measure a noise floor. One comparison per cell is a coin flip.\n`);
  }
  if (a.variants.length === 0) throw new Error('harness-local: --variant resolved to nothing.');
  if (a.tier && a.only) throw new Error('harness-local: pass --tier or --only, not both.');
  if (!Number.isInteger(a.lanes) || a.lanes < 1) throw new Error('harness-local: --lanes must be 1 or more.');
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

function dryRunModel(repeat: number, scriptId: string): (req: EvalModelRequest) => Promise<EvalModelResult> {
  let call = 0;
  return async (req: EvalModelRequest): Promise<EvalModelResult> => {
    call += 1;
    const damaged = repeat === 0;
    const isRoute = req.role === 'route';
    const offers = (name: string): boolean =>
      Array.isArray(req.tools) && req.tools.some((t) => (t as { function?: { name?: string } })?.function?.name === name);
    // Follow scripts: repeat 0 routes to the follow skill so a skill leg is offered
    // proposeTrack, which is then planted (one card of two options) on every such leg.
    const followRoute = damaged && isRoute && scriptId.startsWith('follow') && offers('load_skill');
    const toolCalls = followRoute
      ? [{ name: 'load_skill', argumentsRaw: JSON.stringify({ id: 'conversation/follow-story' }) }]
      : damaged && offers('proposeTrack')
      ? [{
          name: 'proposeTrack',
          argumentsRaw: JSON.stringify({
            options: [
              { label: 'Planted Option One', search: 'Planted One Search' },
              { label: 'Planted Option Two', search: 'planted lowercase search 2019' },
            ],
          }),
        }]
      : isRoute
      ? [
          {
            name: damaged && call === 1 ? 'teleport' : 'lookup_place',
            // Malformed JSON on the damaged path, so the unparseable counter fires.
            argumentsRaw: damaged && call === 1 ? '{"query": ' : JSON.stringify({ query: 'Amsterdam' }),
          },
        ]
      : [];
    return {
      content: isRoute || (!damaged && offers('proposeTrack')) ? '' : damaged ? 'A reply — with an em dash.' : 'A plain reply.',
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

  // PREFLIGHT: the arms must build different leg-0 prompts, twins excepted.
  // Checked before the first call, on a dry run and a live run alike.
  const leg0 = leg0Collisions(args.variants);
  // eslint-disable-next-line no-console
  console.log(`\nLEG-0 ROUTER PROMPT per arm (sha256, CONFIG + ONBOARDING, English)\n${args.variants.map((v) => `  ${v.padEnd(28)} ${leg0.hashes[v]}${TWINS.has(v) ? '  (twin set)' : ''}`).join('\n')}`);
  if (leg0.failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\nRUNNER BUG: two arms build the SAME leg-0 router prompt, so they are not arms.\n${leg0.failures.map((f) => `  ${f}`).join('\n')}\n  Nothing was sent.\n`,
    );
    return 1;
  }

  const loaded = loadScripts(args.scriptsDir);
  const selection = args.tier ? loadTier(args.tier) : args.only;
  const scripts = selection ? selectTurns(loaded, selection) : loaded;
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
      `\nturns    : ${scripts.reduce((n, s) => n + s.turns.length, 0)}${args.tier ? ` (tier ${args.tier})` : args.only ? ' (--only)' : ''}` +
      `\nmodels   : ${args.models.join(', ')}\nrepeat   : ${args.repeat}` +
      `\nvariants : ${args.variants.join(', ')} (per script, every arm before the next script; arm order rotates per repeat)` +
      `\nlanes    : ${args.lanes}` +
      `\nprotocol : ${args.toolProtocols.join(', ')}` +
      `\nmode     : ${args.dryRun ? 'DRY RUN, no calls' : 'live, STREAMED'}\n`,
  );
  for (const w of warnings) console.warn(`!!  ${w}`);

  const collected: EvalRow[] = [];
  /** Per arm and (script, repeat) cell: legs sent with tool_choice 'required',
   *  those that came back with a call, and (text only) those that needed the one
   *  re-ask. Per cell so the report can drop the excluded cells. */
  const forcedLegs = new Map<string, { arm: string; cell: string; forced: number; withCall: number; reasked: number }>();
  const mismatches: string[] = [];
  /** Per arm: legs sent with NO tools (the forced-offer-closing leg), and those
   *  on which the model wrote a call anyway (the loop drops it). */
  const toolFreeLegs = new Map<string, { legs: number; wroteCall: number }>();
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

  // One job per (repeat, script, arm, model), in that order: every arm of a
  // script runs before the next script, side by side with --lanes, so twins
  // share one time window (NEAR drifts enough between runs that a control arm
  // which could not affect anything still moved a kept count by 7).
  const combos = args.pairs ?? args.variants.flatMap((variant) => args.toolProtocols.map((protocol) => ({ variant, protocol })));
  const jobs: { rep: number; script: AgentScript; variant: string; protocol: Args['toolProtocols'][number]; model: string }[] = [];
  for (let rep = args.repeatStart; rep < args.repeatStart + args.repeat; rep++) {
    // Rotated per repeat, so no arm (or pair of twins) always runs in the same
    // slot and NEAR drift cannot move twins together.
    const shift = rep % combos.length;
    const rotated = [...combos.slice(shift), ...combos.slice(0, shift)];
    for (const script of scripts) {
      for (const { variant, protocol } of rotated) for (const model of args.models) jobs.push({ rep, script, variant, protocol, model });
    }
  }

  try {
    await runPool(jobs, args.lanes, async ({ rep, script, variant, protocol, model }) => {
      const dry = dryRunModel(rep, script.id);
      const arm = `${model}@${variant}${protocol === 'native' ? '' : `+${protocol}`}`;
      // One entry per model call, shifted per emitted leg row (the loop emits
      // a turn's rows in call order, after all its calls). PER JOB: with lanes,
      // a shared queue would pair stall counts with another job's rows.
      const stallQueue: number[] = [];
      const emit = (row: EvalRow): void => {
        collected.push(row);
        rows.write(toRunRow(row, runId, catalog));
        evalRows.write(`${JSON.stringify({ ...row, stallRetries: stallQueue.shift() ?? 0 })}\n`);
      };
      const callModel = async (req: EvalModelRequest): Promise<EvalModelResult> => {
        planned.push({
          model,
          systemChars: req.systemPrompt.length,
          promptChars: req.messages.reduce((n, m) => n + m.content.length, 0),
          maxOutputTokens: req.maxTokens ?? 1024,
        });
        if (args.dryRun) { stallQueue.push(0); return dry(req); }
        // AS THE APP SENDS IT: callModelViaCloud turns a tool result into a
        // user turn, and the leg's own tool_choice is honoured ('required' on
        // the forced leg). Both arms get both, so they differ in the wire only.
        const toolChoice = (req as { toolChoice?: string }).toolChoice ?? 'auto';
        const body: Record<string, unknown> = {
          model,
          messages: [
            { role: 'system', content: req.systemPrompt },
            ...req.messages.map((m) => (m.role === 'tool' ? { role: 'user', content: m.content } : m)),
          ],
          // An empty list is no tools (the closing leg): never `tools: []` on the wire.
          ...(req.tools?.length ? { tools: req.tools, tool_choice: toolChoice } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          chat_template_kwargs: { enable_thinking: req.enableThinking ?? false },
        };
        const forced = toolChoice === 'required';
        // A CLOSING leg only: the about-mera answer leg is tool-free too.
        const toolFree = isClosingLeg(req);
        const cell = `${script.id}|${rep}`;
        const stat = forcedLegs.get(`${arm}|${cell}`) ?? { arm, cell, forced: 0, withCall: 0, reasked: 0 };
        forcedLegs.set(`${arm}|${cell}`, stat);
        if (protocol !== 'native' && req.tools) {
          const r = await postBodyStreamTextTools(
            env.nearAiBaseUrl, env.nearAiApiKey, body, 120_000, req.onDelta,
            protocol === 'text-xml' ? 'xml' : protocol === 'text-xml-first' ? 'xml-first' : protocol === 'text-xml-first-soft' ? 'xml-first-soft' : protocol === 'text-marker' ? 'marker' : 'hermes',
            { stallTimeoutMs: args.stallTimeoutMs },
          );
          stallQueue.push(r.stallRetries ?? 0);
          if (forced) {
            stat.forced += 1;
            if (r.toolCalls.length > 0) stat.withCall += 1;
            if (r.reasked) stat.reasked += 1;
          }
          if (toolFree) {
            const t = toolFreeLegs.get(arm) ?? { legs: 0, wroteCall: 0 };
            t.legs += 1;
            if (r.toolCalls.length > 0) t.wroteCall += 1;
            toolFreeLegs.set(arm, t);
          }
          return { ...r, ttVisibleMs: r.ttVisibleMs };
        }
        const r = await postBodyStream(env.nearAiBaseUrl, env.nearAiApiKey, body, 120_000, req.onDelta, { stallTimeoutMs: args.stallTimeoutMs });
        stallQueue.push(r.stallRetries ?? 0);
        if (forced) {
          stat.forced += 1;
          if (r.toolCalls.length > 0) stat.withCall += 1;
        }
        return { ...r, ttVisibleMs: r.ttVisibleMs };
      };

      await runAgentScript(script, {
        callModel,
        sink: emit,
        arm,
        variant,
        model,
        repeat: rep,
        skillIds: PERSONA_SKILL_IDS,
        explainMera: realExplainMera,
        onChoiceOptionMismatch: (d) =>
          mismatches.push(`  ${script.id} turn ${d.turnIndex}: expected "${d.expected}", offered ${JSON.stringify(d.offered)}`),
      });
    });
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

  // THE CLOSING ARMS ARE PROVEN WIRED HERE, because the distinctness check
  // exempts them: tool-free legs must appear in every closing arm and nowhere else.
  const wiring = closingWiringFailures(collected.map((r) => r.arm), toolFreeLegs, args.dryRun);
  if (wiring.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`\nRUNNER BUG: closing-leg wiring\n${wiring.join('\n')}\n`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nTOOL-FREE LEGS (forced-offer-closing; a call written there is dropped)\n${[...toolFreeLegs].map(([a, t]) => `  ${a.padEnd(60)} legs ${t.legs}  wrote a call ${t.wroteCall}`).join('\n') || '  none'}`);

  const armFailures = armDistinctnessFailures(collected);
  if (armFailures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`\n${armFailures.join('\n')}\n`);
  }

  const report = computeAgreement(readJsonl(rows.path), catalog);
  const text = formatAgreementReport(report);
  // eslint-disable-next-line no-console
  console.log(`\n${text}`);
  // PER ARM when there is more than one: the router, skill and proposal blocks
  // pool every row they are given, and a pooled number compares nothing.
  // COUNT-MATCHED: a (script, repeat) with an error row in ANY arm leaves every
  // arm's blocks, so the arms are scored on the same cells (no re-run needed).
  const excluded = erroredCells(collected);
  const counted = collected.filter((r) => !excluded.has(`${r.scriptId}|${r.repeat}`));
  // eslint-disable-next-line no-console
  console.log(`\nEXCLUDED (script, repeat) cells, an error row in some arm, dropped for every arm  ${excluded.size}${[...excluded].sort().map((c) => `\n  ${c.replace('|', ' r')}`).join('')}`);
  const arms = [...new Set(counted.map((r) => r.arm))].sort();
  if (arms.length <= 1) printAgentBlocks(counted, args.oneShotVariant, mismatches, scripts);
  else {
    for (const arm of arms) {
      // eslint-disable-next-line no-console
      console.log(`\n======== ARM ${arm} ========`);
      printAgentBlocks(counted.filter((r) => r.arm === arm), args.oneShotVariant, mismatches, scripts);
    }
  }
  // eslint-disable-next-line no-console
  console.log('\nFORCED LEGS (tool_choice required; text re-asks once when no call came back; excluded cells dropped)');
  const forcedByArm = new Map<string, { forced: number; withCall: number; reasked: number }>();
  for (const f of forcedLegs.values()) {
    if (excluded.has(f.cell)) continue;
    const s = forcedByArm.get(f.arm) ?? { forced: 0, withCall: 0, reasked: 0 };
    s.forced += f.forced; s.withCall += f.withCall; s.reasked += f.reasked;
    forcedByArm.set(f.arm, s);
  }
  for (const [arm, f] of [...forcedByArm.entries()].sort()) {
    // eslint-disable-next-line no-console
    console.log(`  ${arm.padEnd(40)} forced ${f.forced}  with a call ${f.withCall}  re-asked ${f.reasked}`);
  }

  run.finish({
    args, target: env.target, rows: rows.path, agreement: report,
    rosterWarnings: warnings, spendLimited: spendLimit !== null,
    evalRows: evalRowsPath,
  });
  writeFileSync(join(run.dir, 'agreement.txt'), `${text}\n`, 'utf8');
  if (spendLimit) return 3;
  if (armFailures.length > 0) return 1;
  return report.integrityFailures.some((f) => f.startsWith('RUNNER BUG')) ? 1 : 0;
}

/**
 * THE ARM MUST CHANGE THE LEG IT CLAIMS TO CHANGE.
 *
 * g2b, G2c and G2d each ran four "arms" that sent a byte-identical leg-0 system
 * prompt, so 2,101 rows of routing data were the shipped configuration compared
 * against itself. `arms.ts` declared `router-v1.routerPrompt` and
 * `oneshot-prod.personaPrompt`, `arms.test.ts` asserted the VALUES differed, and
 * nothing asserted the runner applied them. It did not: `promptVariant` reached
 * `runAgentTurn` and was read nowhere.
 *
 * A unit test on the registry cannot catch that, because the defect is in the
 * wiring rather than in the value. This check reads what actually went on the
 * wire, which is the only thing that can.
 *
 * `null-control` is the deliberate exception: it is the baseline's twin and
 * MUST be identical, because their spread is the run's noise floor.
 */
export function armDistinctnessFailures(rows: EvalRow[]): string[] {
  // TWINS (lib/arm-distinctness.ts): controls and their twins, and the closing
  // arms, share a leg-0 prompt by design.
  const byPrompt = new Map<string, Set<string>>();
  for (const r of rows) {
    // ROUTE legs only. A resumed turn's first leg carries a skill body, the same
    // on every arm by design (it is not a route, and the loop labels it a skill
    // leg); counting it voided the S1 re-run.
    if (r.legIndex !== 0 || r.callType !== 'agent-route') continue;
    const key = `${r.scriptId}:${r.turnIndex}:${hashMessages([{ role: 'system', content: r.systemPrompt }])}`;
    let seen = byPrompt.get(key);
    if (!seen) byPrompt.set(key, (seen = new Set()));
    seen.add(r.variant);
  }
  const collisions = new Set<string>();
  for (const variants of byPrompt.values()) {
    if (variants.size < 2) continue;
    if ([...variants].every((v) => TWINS.has(v))) continue;
    collisions.add([...variants].sort().join(' == '));
  }
  if (collisions.size === 0) return [];
  return [
    'RUNNER BUG: two arms sent the SAME leg-0 system prompt, so they are not arms.',
    ...[...collisions].sort().map((c) => `  ${c}`),
    '  Every routing number in this run compares a configuration against itself.',
    '  Fix the wiring before reading anything below.',
  ];
}

/** Damage before quality, quality before cost. */
function printAgentBlocks(rows: EvalRow[], oneShotVariant: string | null, mismatches: string[], scripts: AgentScript[]): void {
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

  const props = proposalReport(turns, (id, idx) =>
    scripts.find((s) => s.id === id)?.turns.find((t) => t.index === idx)?.expect ?? null);
  out.push(`\nPROPOSALS (offered statements, sanitised; matches all present, excludes none)  ${props.met}/${props.expected}`);
  for (const m of props.misses.slice(0, 8)) {
    out.push(`  MISS ${m.scriptId} turn ${m.turnIndex} r${m.repeat}: wanted [${m.wanted.join(', ')}] offered ${JSON.stringify(m.offered)}`);
  }

  const guards = offerGuardReport(turns, (id, idx) =>
    scripts.find((s) => s.id === id)?.turns.find((t) => t.index === idx)?.expect ?? null);
  out.push(`\nOFFER GUARDS (noOffer and offerExcludes; the leak guard must be ${guards.checked}/${guards.checked})  ${guards.passed}/${guards.checked}`);
  for (const m of guards.misses.slice(0, 8)) {
    out.push(`  MISS ${m.scriptId} turn ${m.turnIndex} r${m.repeat}: offered ${JSON.stringify(m.offered)}`);
  }

  const expectOf = (id: string, idx: number) =>
    scripts.find((s) => s.id === id)?.turns.find((t) => t.index === idx)?.expect ?? null;
  const track = trackReport(turns, expectOf);
  out.push('\nTRACK (follow cards, proposeTrack; a More options turn is scored in its own block)');
  out.push(`  proposeTrack attempted ${track.attempted}  staged ${track.staged}  refused ${track.refused}`);
  out.push(`  options per staged card  ${Object.entries(track.histogram).map(([n, c]) => `${n}: ${c}`).join(', ') || 'none'}`);
  out.push(`  proposeTrack on non-follow turns that expect no card (bar 0)  ${track.offCohortAttempts}`);
  out.push(`  expect.track met ${track.met}/${track.expected}`);
  for (const m of track.misses.slice(0, 8)) out.push(`    MISS ${m.scriptId} turn ${m.turnIndex} r${m.repeat}: ${m.detail}`);

  const examples = PERSONA_SKILL_INDEX.find((e) => e.id === 'conversation/follow-story')?.examples ?? [];
  const more = moreOptionsReport(
    turns,
    (id, idx) => scripts.find((s) => s.id === id)?.turns.find((t) => t.index === idx)?.moreOptions ?? null,
    { examples, nowYear: new Date().getFullYear() },
  );
  out.push('\nMORE OPTIONS (pass: >= 1 new option, each with label Jaccard < 0.6 against every shown label and a different search text)');
  out.push(`  passed ${more.passed}/${more.turns.length}  new options ${more.options}  too close to a shown one ${more.repeated}`);
  out.push(`  grounding flags  copied-example ${more.flags['copied-example']}  ended-season ${more.flags['ended-season']}  no-entity ${more.flags['no-entity']}`);
  out.push(`  turns that wrote prose (discarded by the loop) ${more.proseWritten}`);
  for (const m of more.turns.filter((x) => !x.passed || x.flags.length > 0).slice(0, 8)) {
    out.push(`    ${m.passed ? 'FLAG' : 'MISS'} ${m.scriptId} turn ${m.turnIndex} r${m.repeat}: ${JSON.stringify(m.options.map((o) => o.label))}${m.flags.length ? ` ${m.flags.map((f) => `${f.flag}(${f.option})`).join(', ')}` : ''}`);
  }

  const cards = cardReport(turns, (id, idx) =>
    scripts.find((s) => s.id === id)?.turns.find((t) => t.index === idx)?.expect ?? null);
  out.push('\nCARDS (per turn, aggregated over its legs; an apply ATTEMPT counts in any leg, executed or refused)');
  out.push(`  cards staged ${cards.staged}  kinds ${Object.entries(cards.kinds).map(([k, n]) => `${k} x${n}`).join(', ') || 'none'}`);
  out.push(`  applyProposal attempted ${cards.applyAttempts}  executed ${cards.applyExecuted}  refused ${cards.applyRefused}`);
  out.push(`  change claimed in the final reply ${cards.claimsChange}  (of which nothing applied ${cards.claimsWithoutApply})`);
  out.push(`  expect.card met ${cards.met}/${cards.expected}`);
  for (const m of cards.misses.slice(0, 8)) {
    out.push(`    MISS ${m.scriptId} turn ${m.turnIndex} r${m.repeat}: ${m.detail}`);
  }

  const rc = replyCheckReport(turns, (id, idx) =>
    scripts.find((s) => s.id === id)?.turns.find((t) => t.index === idx)?.expect ?? null);
  out.push('\nREPLY CHECKS (the turn\u2019s FINAL reply; passed / turns WITH a reply; empty and errored apart)');
  const labels = {
    script: `script (>= ${REPLY_SCRIPT_MIN_SHARE} of letters)`,
    excludes: 'excludes (none present)',
    matches: 'matches (any present)',
  } as const;
  for (const k of ['script', 'excludes', 'matches'] as const) {
    const c = rc[k];
    out.push(`  ${labels[k].padEnd(30)} ${c.passed}/${c.checked}  no reply ${c.noReply}  errored ${c.errored}`);
    for (const m of c.misses.slice(0, 6)) {
      out.push(`    MISS ${m.scriptId} turn ${m.turnIndex} r${m.repeat}: ${m.detail} ${JSON.stringify(m.reply.slice(0, 120))}`);
    }
  }

  const st = silentTurnReport(turns);
  out.push(`\nSILENT TURNS (no reply, nothing on screen, no ending sentence; must be 0)  ${st.silent.length}/${st.turns}`);
  out.push(`  closing leg fired ${st.closingFired}  canned line shown ${st.cannedFired}  closing sentence claimed a change ${st.closingClaims} (must be 0)`);
  for (const m of st.silent.slice(0, 8)) out.push(`  SILENT ${m.arm} ${m.scriptId} turn ${m.turnIndex} r${m.repeat}`);

  // The rule of plans/ready_to_implement/E2EE_TOOL_STEPS_DEV_PORT.closing.py, over each turn's last row.
  const last = turns.map((t) => t.legs[t.legs.length - 1]);
  const finalReply = (r: EvalRow): string => (r.reply ?? '').trim();
  const closed = last.filter((r) => finalReply(r) && !r.replyClaimUnfixed && !r.replyLeakUnfixed);
  out.push(`\nCLOSING (final reply non-empty, no unfixed save claim or leak)  ${closed.length}/${last.length}  ` +
    `ends '?' ${closed.filter((r) => finalReply(r).endsWith('?')).length}  claim kept ${last.filter((r) => r.replyClaimUnfixed).length}`);

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
