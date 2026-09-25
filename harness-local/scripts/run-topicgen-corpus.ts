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

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
import { costOf, fetchModelCatalog, rosterWarnings, TOPICGEN_ARM_MODELS } from '../lib/model-catalog';
import { hasReasoningLeak, postCompletion, SpendLimitError } from '../lib/near-call';
import { COHORTS, loadCohort, type Cohort, type CorpusFact, type CorpusPersona } from '../lib/corpus';
// STEP A. The skill-guided topic prompt against the shipped one-shot prompt,
// carried as an ARM VALUE so both sit in ONE interleaved run. Two runs would
// be invalid on this repo's own evidence: a byte-identical control arm moved
// its kept count by 7 between runs half an hour apart.
import {
  agentArmIds,
  resolveAgentArm,
  topicFlowFor,
  topicPromptFor,
} from '../../lib/mera-harness/core/arms';
import type { AgentModelResult } from '../../lib/mera-harness/core/types';
// The skill core, from the harness's public entry, exactly as the app's
// topic-gen handler imports it.
import {
  MAX_TOPICS_PER_FACT,
  generateTopicsForFact,
  normalizeTopicText,
  topicSkillForAttribute,
} from '@/lib/mera-harness';
import { ensureNullControlArm } from '../../lib/mera-harness/eval/null-control';
import { PERSONA_SKILLS } from '../../lib/mera-harness/skills/index.generated';
import {
  buildCloudBatchCallsForFact,
  parseTopicsFromOutput,
  splitCount,
} from '../../lib/news-harness/persona-management/topic-generation';
import {
  COMBO_PASS_MAX_TOPICS,
  COMBO_PASS_TOPIC_SYSTEM_PROMPT,
  buildComboPassUserMessage,
  buildTopicGenSystemPrompt,
} from '../../lib/news-harness/prompts/persona-prompts';
import { planTopupTopicRows } from '../../lib/news-harness/persona-management/topic-topup';
import { f6Words } from './score-topic-run';
import { promptVariantIds, resolvePromptVariant } from '../../lib/news-harness/prompts/prompt-variants';
import { registerV1ControlArms } from '../../lib/news-harness/prompts/prompt-archive-v1';

// Once per process, before any variant resolves. See the note in
// run-persona-corpus.ts; the topic-gen arms take no options.
registerV1ControlArms();
ensureNullControlArm();

// ---- THE ISOLATED+COMBO FLOW (ux2 F6) ---------------------------------------
//
// What ships since ux2 F1/F3, measured against the 'current' arm's batch path.
// Per persona: one isolated call per fact through the skill core, which sees
// THAT FACT ONLY (no other facts, no location line, exclusions = this fact's
// own topics plus the declined list); then one combination call per fact over
// its supporting facts, newest first, deduped against everything already on
// the device. Both halves are exported so a test can capture the outgoing
// request: the runner holds the whole persona while it builds the isolated
// call, so a leak is one wrong argument away and must be caught mechanically.

export type FlowStage = 'isolated' | 'combo';

export interface FlowFact {
  id: string;
  statement: string;
  questionnaireAttribute: string;
  createdAtMs: number;
}

export interface FlowModelRequest {
  systemPrompt: string;
  userMessage: string;
  temperature: number;
  maxTokens: number;
  enableThinking: false;
}

export type FlowCaller = (
  req: FlowModelRequest,
  meta: { stage: FlowStage; factIndex: number },
) => Promise<AgentModelResult>;

export interface FlowCallRecord {
  stage: FlowStage;
  factIndex: number;
  factId: string;
  skillId: string | null;
  request: FlowModelRequest;
  result: AgentModelResult;
  /** What the flow KEEPS: after the isolated call's veto, filter and place
   *  term, or after the combo stage's global dedupe. */
  topics: string[];
  /** A ceiling in both stages, never an exact count. */
  requested: number;
}

/** The combo handler's own numbers (lib/inference/handlers/topic-combo-handler.ts).
 *  Restated, not imported: that module reaches the database at load. */
export const COMBO_MAX_SUPPORTING_FACTS = 25;
const COMBO_TEMPERATURE = 0.3;
const COMBO_MAX_TOKENS = 400;

export async function runIsolatedStep(p: {
  facts: FlowFact[];
  factIndex: number;
  existingTopicsByFact: Map<string, string[]>;
  declinedTopics: string[];
  call: FlowCaller;
}): Promise<FlowCallRecord> {
  const fact = p.facts[p.factIndex];
  const skillId = topicSkillForAttribute(fact.questionnaireAttribute);
  let request: FlowModelRequest | null = null;
  const outcome = await generateTopicsForFact({
    // ONLY this fact. No otherFacts, no location, by the core's own contract.
    fact: { statement: fact.statement, questionnaireAttribute: fact.questionnaireAttribute },
    skillId,
    existingTopics: p.existingTopicsByFact.get(fact.id) ?? [],
    declinedTopics: p.declinedTopics,
    deps: {
      callModel: (req) => {
        request = {
          systemPrompt: req.systemPrompt,
          userMessage: req.messages.map((m) => m.content).join('\n'),
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          enableThinking: false,
        };
        return p.call(request, { stage: 'isolated', factIndex: p.factIndex });
      },
    },
  });
  return {
    stage: 'isolated',
    factIndex: p.factIndex,
    factId: fact.id,
    skillId,
    request: request as unknown as FlowModelRequest,
    result: outcome.result,
    topics: outcome.result.error ? [] : outcome.topics,
    requested: MAX_TOPICS_PER_FACT,
  };
}

/**
 * One combination call for one fact. `seen` holds the normalised text of every
 * topic on the device plus the declined list; each accepted text joins it, so
 * two facts of one pass cannot mint near twins. Null when there is nothing to
 * combine with, as the handler settles that case without a call.
 */
export async function runComboStep(p: {
  facts: FlowFact[];
  factIndex: number;
  seen: Set<string>;
  call: FlowCaller;
}): Promise<FlowCallRecord | null> {
  const fact = p.facts[p.factIndex];
  const supporting = p.facts
    .filter((_, i) => i !== p.factIndex)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, COMBO_MAX_SUPPORTING_FACTS)
    .map((f) => f.statement);
  if (supporting.length === 0) return null;

  const request: FlowModelRequest = {
    systemPrompt: COMBO_PASS_TOPIC_SYSTEM_PROMPT,
    userMessage: buildComboPassUserMessage(fact.statement, supporting, COMBO_PASS_MAX_TOPICS),
    temperature: COMBO_TEMPERATURE,
    maxTokens: COMBO_MAX_TOKENS,
    enableThinking: false,
  };
  const result = await p.call(request, { stage: 'combo', factIndex: p.factIndex });
  const topics = result.error
    ? []
    : planTopupTopicRows(p.seen, parseTopicsFromOutput(result.content, fact.statement), normalizeTopicText)
        .map((row) => row.text)
        .slice(0, COMBO_PASS_MAX_TOPICS);
  for (const t of topics) p.seen.add(normalizeTopicText(t));
  return {
    stage: 'combo',
    factIndex: p.factIndex,
    factId: fact.id,
    skillId: null,
    request,
    result,
    topics,
    requested: COMBO_PASS_MAX_TOPICS,
  };
}

interface Args {
  label: string;
  cohort: string;
  arms: string[];
  totals: number[];
  accept: number;
  repeat: number;
  variants: string[];
  dryRun: boolean;
  duplicateEvery: number;
  maxTokens: Record<string, number>;
  /** Force the pure fact-only arm. The split is otherwise DERIVED from whether
   *  other facts exist (splitCount), so there is no way to ask for 4+0 on a
   *  multi-fact persona: with others present, total=4 always yields 3+1. This
   *  passes otherFacts EMPTY, which is what makes the combo call not exist
   *  rather than merely be requested at zero. */
  noCombo: boolean;
  /** STEP A: drive the kind-bearing fact corpus instead of a cohort. Opt-in,
   *  so the cohort path this runner already had is untouched. */
  factsFile: string | null;
  /** A persona fixture file loaded directly, bypassing the COHORTS list: a
   *  persona with no chat script (the F6 owner persona) has no cohort. */
  personaFile: string | null;
  /** Where the run directory is created. Default .local-test-data/runs. */
  runsRoot: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    label: 'topicgen',
    cohort: 'heavy',
    arms: [...TOPICGEN_ARM_MODELS],
    totals: [10],
    accept: 6,
    repeat: 3,
    variants: ['baseline'],
    dryRun: false,
    duplicateEvery: 0,
    maxTokens: {},
    noCombo: false,
    factsFile: null,
    personaFile: null,
    runsRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i] ?? args.label;
    else if (a === '--cohort') args.cohort = argv[++i] ?? args.cohort;
    else if (a === '--arms') args.arms = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--totals') args.totals = (argv[++i] ?? '').split(',').map(Number).filter((n) => n > 0);
    else if (a === '--accept') args.accept = Number(argv[++i]);
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--variant') {
      args.variants = (argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    }
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-combo') args.noCombo = true;
    else if (a === '--facts') args.factsFile = argv[++i] ?? null;
    else if (a === '--persona') args.personaFile = argv[++i] ?? null;
    else if (a === '--runs-root') args.runsRoot = argv[++i] ?? null;
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
  if (!args.personaFile && !(COHORTS as readonly string[]).includes(args.cohort)) {
    throw new Error(`harness-local: unknown cohort '${args.cohort}'. Known: ${COHORTS.join(', ')}.`);
  }
  if (args.totals.length === 0) throw new Error('harness-local: --totals resolved to nothing.');
  if (args.variants.length === 0) throw new Error('harness-local: --variant resolved to nothing.');
  if (args.repeat < 3) {
    // eslint-disable-next-line no-console
    console.warn(`\n!!  --repeat ${args.repeat} does not measure a noise floor.\n`);
  }
  return args;
}

/** The user's location fact, which the builder takes separately. Matched on the
 *  attribute rather than the text, the same key the app's own resolver uses. */
interface PlaceChainLite {
  locality?: string;
  admin1?: string | null;
  countryName?: string;
}

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

function isAgentArm(id: string): boolean {
  return agentArmIds().includes(id);
}

/**
 * Which topic flow a variant runs. Step A (--facts) keeps its own path: its
 * arms carry no topicFlow, so topicFlowFor would send the one-shot control
 * down the skill core and silently measure the wrong prompt. A news-harness
 * prompt variant that is not an agent arm is the batch path it always was.
 */
function flowFor(variantId: string, stepA: boolean): 'step-a' | 'current' | 'isolated+combo' {
  if (stepA) return 'step-a';
  if (!isAgentArm(variantId)) return 'current';
  return topicFlowFor(resolveAgentArm(variantId));
}

/** Words for the dry run's stand-in topics: distinct, so the stand-ins do not
 *  near-duplicate each other and the S7 line reads the planted cases only. */
const DRY_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];

/**
 * The dry run's stand-in output for the isolated+combo flow, with TWO planted
 * defects on repeat 0 only, so the scorer's detectors are seen firing as well
 * as staying quiet: fact 0's isolated set carries the first content word of
 * fact 1 (a cross-fact leak), and fact 0's combo set carries a topic naming
 * nothing of fact 0 (a combo that lost its subject).
 */
export function dryRunFlowTopics(
  facts: FlowFact[],
  factIndex: number,
  stage: FlowStage,
  repeat: number,
): string {
  const wordOf = (i: number): string =>
    (facts[i]?.statement ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3)[1] ??
    `fact${i}`;
  if (stage === 'isolated') {
    const topics = DRY_WORDS.map((w) => `${stage} ${w} ${factIndex}`);
    if (repeat === 0 && factIndex === 0 && facts.length > 1) topics[0] = `planted ${wordOf(1)} leak`;
    return JSON.stringify(topics);
  }
  // A word the scorer counts as content, so only the planted miss misses.
  const own = [...f6Words(facts[factIndex]?.statement ?? '')][0] ?? 'fact';
  const topics = [`${own} ${stage} ${DRY_WORDS[0]} ${factIndex}`, `${own} ${stage} ${DRY_WORDS[1]} ${factIndex}`];
  if (repeat === 0 && factIndex === 0) topics[1] = 'planted subjectless topic';
  return JSON.stringify(topics);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
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
      // Step A selects AGENT arms (they carry topicPrompt). The cohort path
      // takes an agent arm first (its topicFlow picks the flow, ux2 F6) and
      // falls back to the news-harness prompt variants it always used.
      if (args.factsFile || isAgentArm(v)) resolveAgentArm(v);
      else resolvePromptVariant(v);
    } catch (err) {
      throw new Error(
        `harness-local: --variant '${v}' is not registered. Known: ${promptVariantIds().join(', ')}. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const cohort: Cohort = args.personaFile
    ? (() => {
        const persona = JSON.parse(readFileSync(resolve(args.personaFile), 'utf8')) as CorpusPersona;
        return { name: persona.cohort, persona, turns: [] };
      })()
    : loadCohort(args.cohort);
  // Rows carry the cohort name; a persona file names its own.
  args.cohort = cohort.name;
  // STEP A drives the kind-bearing corpus: the cohort personas carry no
  // `kind`, and without one there is no guideline to select, so the
  // skill-guided arm would have nothing to be skill-guided BY.
  const stepAFacts: (CorpusFact & { kind?: string; placeChain?: PlaceChainLite })[] | null = args.factsFile
    ? (JSON.parse(readFileSync(resolve(args.factsFile), 'utf8')) as {
        facts: {
          id: string; statement: string; questionnaireAttribute: string; kind: string;
          placeChain?: PlaceChainLite;
        }[];
      }).facts.map((f) => ({
        id: f.id,
        statement: f.statement,
        questionnaireAttribute: f.questionnaireAttribute,
        questionnaireLevel: 1,
        questionnaireLevelCategory: 'Core',
        weight: 1,
        createdAtMs: 0,
        metadata: { topics: [] },
        kind: f.kind,
        // CARRIED, and it was not before. locationForFact reads this; without
        // it every fact silently fell back to the persona residence and the
        // per-fact-location fix was dead on arrival while looking applied.
        placeChain: f.placeChain,
      }))
    : null;
  const facts = (stepAFacts ?? cohort.persona.facts).slice(0, args.accept);
  if (facts.length === 0) throw new Error('harness-local: --accept selected no facts.');
  const personaLocation = locationOf(stepAFacts ?? cohort.persona.facts);

  /**
   * THE LOCATION A FACT IS JUDGED AGAINST, PER FACT.
   *
   * A single persona-wide `userLocation` is wrong for this corpus and it
   * produced a false finding. The Step A facts are fifteen INDEPENDENT cases,
   * not one person: tf01 lives in Barcelona, tf05 is "living in Dublin", tf06
   * is "living in Rotterdam". `locationOf` takes the FIRST location fact, so
   * every call was told the user lives in Barcelona, including the two whose
   * own statement names a different host.
   *
   * The skill guideline trusts the location it is handed; the one-shot prompt
   * reads the host out of the fact. So the skill arm emitted "Spain
   * immigration law reform" and "Poland Spain tax treaty" for facts about
   * Dublin and Rotterdam, missed the `host` rung 6 times out of 6 against the
   * control's 0, and that read as a skill defect. It was the corpus handing
   * the two prompts contradictory inputs.
   *
   * A fact that carries its own resolved chain IS its own location.
   */
  const locationForFact = (f: CorpusFact & { placeChain?: PlaceChainLite }): string | null => {
    const pc = f.placeChain;
    if (pc?.locality) {
      return [pc.locality, pc.admin1, pc.countryName].filter(Boolean).join(', ');
    }
    return personaLocation;
  };
  const existingTopics = stepAFacts ? [] : cohort.persona.topics.map((t) => t.text);

  const run = createRunWriter({ label: args.label, runsRoot: args.runsRoot ? resolve(args.runsRoot) : undefined });
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
    `run      : ${runId}\nrun dir  : ${run.dir}\ntarget   : ${env.target}` +
      `${overridden.length ? `\noverride : ${overridden.join(', ')}` : ''}` +
      `\n${args.factsFile ? `facts    : ${args.factsFile}` : `cohort   : ${args.cohort}`}` +
      `, accepting ${facts.length} fact(s) sequentially` +
      `${args.factsFile ? '\nmode     : STEP A, arms select the topic prompt (skill vs one-shot)' : ''}` +
      `${args.noCombo ? '\nsplit    : --no-combo, factOnly only, otherFacts passed empty' : ''}` +
      `\nexisting : ${existingTopics.length} topics on the persona, all passed as excludeTopics` +
      `\narms     : ${args.arms.join(', ')}\ntotals   : ${args.totals.join(', ')}` +
      `\nrepeat   : ${args.repeat}\nvariants : ${args.variants.join(', ')} (interleaved per fact)` +
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

  // ---- the isolated+combo flow's inputs (ux2 F6) ----------------------------
  const flowFacts: FlowFact[] = facts.map((f) => ({
    id: f.id,
    statement: f.statement,
    questionnaireAttribute: f.questionnaireAttribute,
    createdAtMs: f.createdAtMs,
  }));
  /** THIS fact's topics, which are the isolated call's only exclusions. */
  const existingTopicsByFact = new Map<string, string[]>();
  for (const t of stepAFacts ? [] : cohort.persona.topics) {
    if (!t.factId || t.status !== 'active') continue;
    existingTopicsByFact.set(t.factId, [...(existingTopicsByFact.get(t.factId) ?? []), t.text]);
  }
  const flowVariants = args.variants.filter((v) => flowFor(v, Boolean(args.factsFile)) === 'isolated+combo');

  const callerFor = (model: string, rep: number): FlowCaller => async (req, meta) => {
    planned.push({
      model,
      systemChars: req.systemPrompt.length,
      promptChars: req.userMessage.length,
      maxOutputTokens: args.maxTokens[model] ?? req.maxTokens,
    });
    if (args.dryRun) {
      return {
        content: dryRunFlowTopics(flowFacts, meta.factIndex, meta.stage, rep),
        toolCalls: [], finishReason: 'stop', truncated: false,
        usage: { promptTokens: 700, completionTokens: 60, cachedTokens: 0, reasoningTokens: 0 },
        modelSent: model, latencyMs: 12 + meta.factIndex, error: null,
      };
    }
    const r = await postCompletion({
      baseUrl: env.nearAiBaseUrl,
      apiKey: env.nearAiApiKey,
      model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userMessage },
      ],
      temperature: req.temperature,
      maxTokens: args.maxTokens[model] ?? req.maxTokens,
      enableThinking: false,
    });
    return {
      content: r.content,
      toolCalls: r.toolCalls.map((t) => ({ name: t.name, argumentsRaw: t.argumentsRaw })),
      finishReason: r.finishReason,
      truncated: r.truncated,
      usage: r.usage,
      modelSent: r.modelSent,
      latencyMs: r.latencyMs,
      error: r.error,
    };
  };

  const writeFlowRow = (rec: FlowCallRecord, model: string, variantId: string, total: number, rep: number): void => {
    const bucketKey = `${model}@${variantId}|${total}|${rep}`;
    const bucket = crossFact.get(bucketKey) ?? new Map<string, Set<string>>();
    for (const t of rec.topics) {
      const key = t.toLowerCase().trim();
      bucket.set(key, (bucket.get(key) ?? new Set<string>()).add(rec.factId));
    }
    crossFact.set(bucketKey, bucket);

    const info = catalog[model];
    const result = rec.result;
    const row: RunRow & { stage: FlowStage; skillId: string | null } = {
      rowId: newRowId(), dupOf: null, legIndex: null, runId, repeat: rep,
      cohort: args.cohort, turnIndex: rec.factIndex,
      arm: `${model}@${variantId}@${total}(isolated+combo)`,
      // The isolated call is this flow's first pass, the like-for-like of the
      // batch path's fact-only half; `stage` is what the scorer reads.
      callType: rec.stage === 'isolated' ? 'topicgen-factOnly' : 'topicgen-combo',
      stage: rec.stage,
      skillId: rec.skillId,
      interleaveGroup: `${total}:${rec.factIndex}:${rec.stage}`, lane: 'near', surface: 'TOPICGEN',
      variant: variantId,
      promptHash: hashMessages([
        { role: 'system', content: rec.request.systemPrompt },
        { role: 'user', content: rec.request.userMessage },
      ]),
      // Both prompts are fixture-determined: the isolated call's exclusions are
      // this fact's fixture topics, and the combo prompt is statements only.
      promptDeterministic: true,
      fenceNonce: null,
      modelRequested: model, modelSent: result.modelSent,
      fallbackFrom: null, hedged: false,
      input: {
        systemPrompt: rec.request.systemPrompt,
        messages: [{ role: 'user', content: rec.request.userMessage }],
        toolSchemaNames: [],
      },
      personaStateIn: {
        factCount: facts.length,
        topicCount: rec.stage === 'isolated' ? (existingTopicsByFact.get(rec.factId) ?? []).length : existingTopics.length,
        factsInPrompt: rec.stage === 'isolated' ? 1 : Math.min(facts.length, COMBO_MAX_SUPPORTING_FACTS + 1),
        turnsInPrompt: 1,
      },
      rawOutput: result.content,
      toolCalls: [],
      parsedSchema: rec.topics,
      items: [{ id: rec.factId }],
      requestedCount: rec.requested,
      returnedCount: result.error ? null : rec.topics.length,
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
    };
    writeRow(row);
  };

  // THE PLAN, written before any call, so a run a spend limit cut short can be
  // told apart from a complete one: the scorer compares rows against this.
  if (!args.factsFile) {
    const perCell = args.repeat * args.totals.length * args.arms.length;
    run.writeJson('f6-plan', {
      cohort: args.cohort,
      facts: flowFacts.map((f) => ({ ...f, skillId: topicSkillForAttribute(f.questionnaireAttribute) })),
      variants: args.variants.map((v) => {
        const flow = flowFor(v, false);
        const multi = facts.length > 1 && !args.noCombo;
        return {
          variant: v,
          flow,
          expectedRows:
            flow === 'isolated+combo'
              ? { isolated: facts.length * perCell, combo: facts.length > 1 ? facts.length * perCell : 0 }
              : {
                  factOnly: facts.length * perCell,
                  combo: multi
                    ? facts.length * args.repeat * args.arms.length *
                      args.totals.filter((t) => splitCount(t, true).combo > 0).length
                    : 0,
                },
        };
      }),
    });
  }

  for (const total of args.totals) {
    for (let rep = 0; rep < args.repeat; rep++) {
      // Each arm walks the SAME sequential accept, so their exclude lists grow
      // the same way and the comparison stays fair.
      // One exclude list per ARM, and an arm is now (model, variant): two
      // variants must not share an accumulated exclude list or each would be
      // told not to repeat the other's output.
      const armIds = args.arms.flatMap((m) => args.variants.map((v) => `${m}@${v}`));
      const acquired = new Map<string, string[]>(armIds.map((a) => [a, [...existingTopics]]));
      /** Every isolated topic this repeat produced, per isolated-flow arm. */
      const isolatedByArm = new Map<string, string[]>();

      for (let fi = 0; fi < facts.length; fi++) {
        const fact = facts[fi];
        // --no-combo passes NO other facts, so buildCloudBatchCallsForFact
        // emits the factOnly call and nothing else. The alternative, asking for
        // a combo count of zero, is not the same experiment: the prompt would
        // still carry the other facts.
        const otherFacts = args.noCombo
          ? []
          : facts.filter((_, i) => i !== fi).map((f) => f.statement);
        const { factOnly: factOnlyCount, combo: comboCount } = splitCount(total, otherFacts.length > 0);

        // Prompt variants interleave with models, per fact, so both arms sit in
        // one run and one time window. Between-run drift moved a control arm's
        // kept count by 7 against a within-run floor of 4, which confounds any
        // comparison made across separate runs.
        for (const variantId of args.variants) {
        for (const model of args.arms) {
          if (flowFor(variantId, Boolean(args.factsFile)) === 'isolated+combo') {
            const rec = await runIsolatedStep({
              facts: flowFacts,
              factIndex: fi,
              existingTopicsByFact,
              declinedTopics: [],
              call: callerFor(model, rep),
            });
            isolatedByArm.set(`${model}@${variantId}`, [
              ...(isolatedByArm.get(`${model}@${variantId}`) ?? []),
              ...rec.topics,
            ]);
            writeFlowRow(rec, model, variantId, total, rep);
            continue;
          }
          const armId = `${model}@${variantId}`;
          const excludeTopics = acquired.get(armId) ?? [];
          // The production builder, so gear and prompts cannot drift from it.
          // STEP A: the arm decides WHICH prompt the topic call runs on. An
          // arm is a VALUE, never string surgery over the shipped text, so a
          // result recorded today stays reproducible from the repo alone.
          const armSpec = args.factsFile ? resolveAgentArm(variantId) : null;
          const useSkill = armSpec ? topicPromptFor(armSpec) === 'skill' : false;
          const factKind = (fact as CorpusFact & { kind?: string }).kind ?? 'generic';
          const skillBody = PERSONA_SKILLS[`topics/${factKind}` as keyof typeof PERSONA_SKILLS];
          if (useSkill && !skillBody) {
            throw new Error(
              `harness-local: fact ${fact.id} has kind '${factKind}', which has no topics/ skill. ` +
                'A missing guideline would silently fall back to the one-shot prompt and the arm ' +
                'would measure the control.',
            );
          }
          const calls = buildCloudBatchCallsForFact(
            {
              factStatement: fact.statement,
              userLocation: args.factsFile ? locationForFact(fact) : personaLocation,
              otherFacts,
              totalCount: total,
              excludeTopics,
            },
            `fact${fi}`,
            useSkill
              ? { factOnly: skillBody, combo: skillBody }
              : {
                  // An agent arm (topics-current) runs the SHIPPED prompts; its
                  // id is not a prompt variant and would throw here.
                  factOnly: buildTopicGenSystemPrompt('factOnly', args.factsFile || isAgentArm(variantId) ? 'baseline' : variantId),
                  combo: buildTopicGenSystemPrompt('combo', args.factsFile || isAgentArm(variantId) ? 'baseline' : variantId),
                },
          );

          for (const call of calls) {
            const kind = call.id.endsWith(':combo') ? 'combo' : 'factOnly';
            const callType: CallType = kind === 'combo' ? 'topicgen-combo' : 'topicgen-factOnly';
            const requested = kind === 'combo' ? comboCount : factOnlyCount;

            planned.push({
              model,
              systemChars: call.system.length,
              promptChars: call.prompt.length,
              maxOutputTokens: args.maxTokens[model] ?? call.maxTokens ?? 0,
            });
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
            const bucketKey = `${armId}|${total}|${rep}`;
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
            acquired.set(armId, [...(acquired.get(armId) ?? []), ...topics]);

            const info = catalog[model];
            writeRow({
              rowId: newRowId(), dupOf: null, legIndex: null, runId, repeat: rep,
              // COHORT STAYS THE COHORT. The count arm lives in `arm` only,
              // never here: rater-export.ts keeps `cohort` visible on purpose
              // (the adversarial hard fails are unjudgeable without it) and
              // blinds `arm`, so folding the total into the cohort name would
              // hand the rater the arm it is not supposed to see.
              cohort: args.cohort, turnIndex: fi,
              // The arm records the SPLIT, not just the total, because 4+0 and
              // 3+1 are different arms that share a total and the key is what a
              // blinded rating is decoded against.
              arm: `${model}@${variantId}@${total}(${factOnlyCount}+${comboCount})`, callType,
              interleaveGroup: `${total}:${fi}:${kind}`, lane: 'near', surface: 'TOPICGEN',
              variant: variantId,
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

      // THE COMBINATION PASS, once every isolated call of this repeat is in,
      // as the app drains its topic_gen jobs before any topic_combo job. One
      // call per fact, arms interleaved per fact. `seen` is everything on the
      // device for that arm: the persona's topics plus this repeat's isolated
      // topics (the fixtures carry no declined list).
      const seenByArm = new Map<string, Set<string>>();
      for (let fi = 0; fi < facts.length; fi++) {
        for (const variantId of flowVariants) {
          for (const model of args.arms) {
            const armKey = `${model}@${variantId}`;
            const seen =
              seenByArm.get(armKey) ??
              new Set([...existingTopics, ...(isolatedByArm.get(armKey) ?? [])].map(normalizeTopicText));
            seenByArm.set(armKey, seen);
            const rec = await runComboStep({ facts: flowFacts, factIndex: fi, seen, call: callerFor(model, rep) });
            if (rec) writeFlowRow(rec, model, variantId, total, rep);
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

  // ---- the two mechanical checks -------------------------------------------
  const overCount: string[] = [];
  const emptyYield: string[] = [];
  for (const row of readJsonl(rows.path)) {
    if (row.dupOf !== null || row.error !== null) continue;
    if (row.returnedCount !== null && row.requestedCount !== null) {
      // The isolated+combo flow asks for a CEILING in both stages (`stage`
      // rows), so only an over-count is a violation there.
      const stage = (row as RunRow & { stage?: FlowStage }).stage;
      if (stage && row.returnedCount > row.requestedCount) {
        overCount.push(`  ${row.arm} ${stage} fact ${row.turnIndex} rep ${row.repeat}: ceiling ${row.requestedCount}, got ${row.returnedCount} OVER`);
      }
      if (!stage && row.callType === 'topicgen-factOnly' && row.returnedCount !== row.requestedCount) {
        overCount.push(`  ${row.arm} ${row.callType} fact ${row.turnIndex} rep ${row.repeat}: asked ${row.requestedCount}, got ${row.returnedCount}`);
      }
      if (!stage && row.callType === 'topicgen-combo' && row.returnedCount > row.requestedCount) {
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
      // An isolated-flow arm has no persona-wide exclusion by design (ux2 F1),
      // so a collision there is EXPECTED, not the hard fail it is on the
      // batch path. Labelled so nobody reads it as a regression.
      const isolatedFlow = flowVariants.some((v) => bucketKey.split('|')[0].endsWith(`@${v}`));
      dupLines.push(
        `  ${bucketKey}: ${collisions.length} topic(s) generated under more than one fact in the same accept` +
          (isolatedFlow ? '  (isolated flow: expected, no persona-wide exclusion; the combo stage dedupes)' : ''),
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

if (/run-topicgen-corpus\.ts$/.test(process.argv[1] ?? '')) main().then(
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
