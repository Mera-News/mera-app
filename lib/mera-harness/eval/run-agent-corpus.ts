// mera-harness/eval — the corpus entry point. Pure: ports in, rows out.
//
//   runAgentCorpus(scripts, { callModel, sink, ... })
//
// No network, no fs, no clock it does not own. The NEAR caller, the staging
// rail and the JSONL writer live in harness-local and are injected, which is
// what lets this same loop run under a CLI, under jest, or against a fake
// model for free.

import { personaPromptFor, resolveAgentArm } from '../core/arms';
import { createAgentState, runAgentTurn, type AgentPersona, type AgentState } from '../core/core';
import type { AgentDeps, AgentModelRequest, AgentModelResult, AgentTurnState } from './contract';
import { createFakeTools, type FakeToolsHandle } from './fake-tools';
import type {
  AgentScript,
  EvalCallType,
  EvalRow,
  EvalToolCall,
  ModelCaller,
  RowSink,
  ScriptTurn,
  TurnEnd,
} from './types';

export interface RunAgentCorpusOptions {
  callModel: ModelCaller;
  sink: RowSink;
  arm: string;
  variant: string;
  model: string;
  repeat: number;
  /** Injected so the eval owns no clock. A test passes a counter and gets
   *  deterministic timings; the CLI passes Date.now. */
  now?: () => number;
  maxLegs?: number;
  /**
   * The ARM, as the loop sees it. Defaults to `variant`, and that default is
   * the point: two fields, one the row label and one the behaviour, is how the
   * CLI came to pass only the label. `--variant pre-enforcement` then produced
   * 234 rows labelled `pre-enforcement` that ran the baseline prompt, and the
   * run looked complete. Pass this only to deliberately decouple them.
   */
  promptVariant?: string;
  skillIds?: readonly string[];
  /** The choice a fixture makes is AUTHORITATIVE. When an arm offers options
   *  that do not contain it, this fires and the fixture's text is sent anyway:
   *  letting each arm follow its own offered options would fork the script per
   *  arm, and from that turn on the arms would no longer be answering the same
   *  question, which destroys the only thing making them comparable. */
  onChoiceOptionMismatch?: (d: {
    scriptId: string;
    turnIndex: number;
    expected: string;
    offered: string[];
  }) => void;
}

/** What the loop asked for on each call, captured in request order so it can
 *  be paired with the legs the result hands back. `enableThinking` is not on
 *  AgentLeg, and it is the field that makes an unhonoured switch visible. */
interface CapturedRequest {
  role: AgentModelRequest['role'];
  enableThinking: boolean | null;
  startedAtMs: number;
  /** What this leg was OFFERED. Varies per leg: the loop withholds load_skill
   *  once a skill is loaded, so a fixed list would misreport every later leg. */
  toolNames: string[];
}

const ROLE_TO_CALL_TYPE: Record<string, EvalCallType> = {
  route: 'agent-route',
  tool: 'agent-tool',
  // No `reply` entry: the core does not emit that role, and reply prose rides
  // the last tool leg. An unmapped role falls through to 'agent-tool' below,
  // so a future core that DID emit one would be visible as a mapping gap
  // rather than silently creating a category nothing else knows about.
  topicgen: 'agent-topicgen',
};

function parseToolCall(name: string, argumentsRaw: string, knownTools: ReadonlySet<string>, result: unknown): EvalToolCall {
  let parsed: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(argumentsRaw);
    if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  // Required-property checks, per tool. Split from "did it parse" because a
  // malformed-JSON call and a schema-violating call are different findings and
  // one blurred rate hides both.
  let schemaValid = parsed !== null;
  if (parsed) {
    if (name === 'lookup_place' || name === 'lookupPlace') schemaValid = typeof parsed.query === 'string';
    else if (name === 'load_skill') schemaValid = typeof parsed.id === 'string';
    else if (name === 'ask_choice') {
      schemaValid =
        typeof parsed.question === 'string' &&
        Array.isArray(parsed.options) &&
        parsed.options.length >= 2 &&
        parsed.options.length <= 3;
    } else if (name === 'saveExtractedFacts') {
      schemaValid = Array.isArray(parsed.extracted_user_information);
    } else if (name === 'deleteUserFacts') {
      schemaValid = Array.isArray(parsed.fact_ids);
    }
  }
  return { name, argumentsRaw, parsed, schemaValid, unknownTool: !knownTools.has(name), result };
}

/**
 * Names that are NOT an invented tool. Deliberately wider than what any one
 * leg is offered: it exists only to classify a call as known or invented.
 *
 * DO NOT report this as the tool list the model saw. It is not. The row's
 * `toolSchemaNames` now carries what the leg was ACTUALLY sent, because this
 * constant said `saveExtractedFacts` was available on every row while the
 * loop was never offering it, which is exactly the fact the rows were needed
 * to establish.
 */
const KNOWN_TOOLS = new Set([
  'load_skill', 'find_similar_facts', 'findSimilarFacts', 'lookup_place', 'lookupPlace',
  'ask_choice', 'saveExtractedFacts', 'deleteUserFacts',
]);

/** The tool names a request actually carried, read off the request itself. */
function sentToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (t as { function?: { name?: string } })?.function?.name)
    .filter((n): n is string => typeof n === 'string');
}

/**
 * Why this does NOT read `state.turn.pendingChoice`.
 *
 * pendingChoice PERSISTS across turns: the core clears it only when the next
 * user message matches an offered option, so an unanswered question leaves it
 * set forever and every later turn reports `awaiting_user`. Measured on the
 * live run: 54 turns actually called ask_choice, and the consecutive-question
 * metric reported 100 offending pairs out of 312 turns, which is more pairs
 * than 54 asking turns can produce. That was the metric reading stale state,
 * not the agent interrogating anyone.
 *
 * So the verdict comes from what THIS turn did: did one of its own legs call
 * ask_choice.
 */
function endedOnFor(
  askedThisTurn: boolean,
  legBudgetHit: boolean,
  lastError: string | null,
  terminalReason: string,
): TurnEnd {
  if (lastError) return 'transport_error';
  if (askedThisTurn) return 'awaiting_user';
  // `legBudgetHit` ALONE over-reported this by an order of magnitude: on G3, 16
  // of 18 turns it called capped had already proposed a fact, so the rate read
  // 23% when the real failures were about 2 in 18. The loop now distinguishes
  // the two, and the verdict follows the loop rather than the raw budget flag.
  if (legBudgetHit && terminalReason === 'leg-cap') return 'leg_cap';
  // BEFORE the settled default, never after: a turn that routed nothing is the
  // failure this run exists to measure, and folding it into `settled` is what
  // made it invisible for three runs.
  if (terminalReason === 'no-route') return 'no_route';
  return 'settled';
}

function personaFor(script: AgentScript): AgentPersona {
  return {
    facts: script.persona.facts.map((f) => ({
      id: f.id,
      statement: f.statement,
      attribute: f.questionnaireAttribute,
    })),
    surface: 'CONFIG',
  };
}

/**
 * Drives one script to completion and emits one row per model leg.
 *
 * ERRORS DIVIDE IN TWO AND BOTH HALVES MATTER. A transport failure is returned
 * by the caller, ends the TURN, and is recorded. Anything THROWN is a
 * run-ending condition the caller raised (the provider's 402 is one) and is
 * let straight out: recording those as leg data writes a file of empty rows
 * across every remaining script that reads as the model failing.
 */
export async function runAgentScript(
  script: AgentScript,
  opts: RunAgentCorpusOptions,
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const skillIds = opts.skillIds ?? [];
  const fakes: FakeToolsHandle = createFakeTools(script);
  const state: AgentState = createAgentState(personaFor(script));

  for (const turn of script.turns) {
    const userMessage = resolveUserMessage(turn, state.turn, script, opts);
    fakes.beginTurn(turn, state.turn);

    const turnStartedAtMs = now();
    const captured: CapturedRequest[] = [];

    const callModel = async (req: AgentModelRequest): Promise<AgentModelResult> => {
      captured.push({
        role: req.role,
        enableThinking: req.enableThinking ?? null,
        startedAtMs: now(),
        toolNames: sentToolNames(req.tools),
      });
      // Forwarded, never swallowed: an ignored onDelta means the core runs a
      // different path here than in the app, which is the one thing a
      // measurement harness must not do.
      return opts.callModel({ ...req, onDelta: req.onDelta });
    };

    const deps: AgentDeps = {
      callModel,
      tools: fakes.port,
      loadSkill: (id: string) => (skillIds.includes(id) ? `skill:${id}` : null),
      skillIds: () => skillIds,
      now,
    };

    // THE ONE-SHOT PERSONA CONTROL IS NOT IMPLEMENTED HERE, so an arm asking
    // for it must stop the run rather than quietly receive the router. That is
    // exactly what happened: `oneshot-prod` ran the router loop for three full
    // corpus runs and was written up as the production control.
    // `personaPromptFor` had no caller at all outside its own unit test.
    if (personaPromptFor(resolveAgentArm(opts.promptVariant ?? opts.variant)) === 'oneshot') {
      throw new Error(
        `mera-harness/eval: arm '${opts.promptVariant}' asks for the one-shot persona prompt, `
          + 'which this runner cannot build (it lives in news-harness and this folder imports '
          + 'nothing from there). Running it as the router would measure the control twice.',
      );
    }

    const result = await runAgentTurn({
      state,
      userMessage,
      deps,
      maxLegs: opts.maxLegs,
      promptVariant: opts.promptVariant ?? opts.variant,
      model: opts.model,
    });

    const lastError = result.legs.length > 0 ? result.legs[result.legs.length - 1].result.error : null;
    const askedThisTurn = result.legs.some((l) => l.toolCalls.some((t) => t.name === 'ask_choice'));
    const endedOn = endedOnFor(askedThisTurn, result.legBudgetHit, lastError, result.terminalReason);

    result.legs.forEach((leg, i) => {
      const cap = captured[i];
      const isLast = i === result.legs.length - 1;
      const toolResults = new Map(leg.toolResults.map((t) => [t.name, t.result]));
      opts.sink({
        scriptId: script.id,
        cohort: script.cohort,
        turnIndex: turn.index,
        legIndex: leg.index,
        repeat: opts.repeat,
        arm: opts.arm,
        variant: opts.variant,
        callType: ROLE_TO_CALL_TYPE[leg.role] ?? 'agent-tool',
        // THE TURN, never the leg. Leg counts are ragged across repeats and
        // the one-shot control arm has no leg above 0, so a leg-level group
        // would mark every high leg non-interleaved and empty the latency
        // columns.
        interleaveGroup: `${script.id}:${turn.index}`,
        promptDeterministic: turn.index === 0 && leg.index === 0,
        systemPrompt: leg.systemPrompt,
        messages: leg.messages,
        toolSchemaNames: cap?.toolNames ?? [],
        rawOutput: leg.rawOutput,
        toolCalls: leg.toolCalls.map((t) =>
          parseToolCall(t.name, t.argumentsRaw, KNOWN_TOOLS, toolResults.get(t.name) ?? null),
        ),
        turnStartedAtMs,
        legStartedAtMs: cap?.startedAtMs ?? turnStartedAtMs,
        latencyMs: leg.result.latencyMs,
        ttVisibleMs: leg.result.ttVisibleMs ?? null,
        thinkingRequested: cap?.enableThinking ?? null,
        inputTokens: leg.inputTokens,
        usage: leg.result.usage,
        finishReason: leg.result.finishReason,
        truncated: leg.result.truncated,
        error: leg.result.error,
        modelRequested: opts.model,
        modelSent: leg.result.modelSent,
        endedOn: isLast ? endedOn : null,
        formatRetries: isLast ? result.formatRetries : null,
        awaitingUser: isLast && endedOn === 'awaiting_user',
        routeKind: result.routeKind,
        skillLoaded: result.skillLoaded,
        expectedRouteKind: turn.expect.routeKind,
        expectedSkill: turn.expect.skill,
        items: null,
        factKind: null,
        topics: null,
        dropped: null,
      });
    });
  }
}

/**
 * The message this turn sends.
 *
 * A choice reply sends the FIXTURE's text, always. If the arm offered options
 * that do not contain it, that is recorded and the fixture still wins — see
 * onChoiceOptionMismatch.
 */
function resolveUserMessage(
  turn: ScriptTurn,
  turnState: AgentTurnState,
  script: AgentScript,
  opts: RunAgentCorpusOptions,
): string {
  if (turn.chooses === undefined) return turn.user ?? '';
  const offered = turnState.pendingChoice?.options.map((o) => o.text) ?? [];
  if (!offered.some((o) => o.trim().toLowerCase() === turn.chooses!.trim().toLowerCase())) {
    opts.onChoiceOptionMismatch?.({
      scriptId: script.id,
      turnIndex: turn.index,
      expected: turn.chooses,
      offered,
    });
  }
  return turn.chooses;
}

export async function runAgentCorpus(
  scripts: readonly AgentScript[],
  opts: RunAgentCorpusOptions,
): Promise<void> {
  for (const script of scripts) await runAgentScript(script, opts);
}
