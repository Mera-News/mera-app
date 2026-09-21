// mera-harness/core — the bounded agent loop. PURE, RN-free.
//
// One loop, two callers: the RN driver (useCloudPersonaChat) wires real deps,
// the eval runner wires fakes. A harness green is therefore evidence about the
// app rather than about a parallel implementation.

import { resolveAgentArm, routeEnforcementFor } from './arms';
import { buildRouterPrompt, type PersonaSurface } from './router-prompt';
import { claimsSaveHappened, cleanProse, leaksInternals, trailingQuestion } from './prose';
import { buildStateLine, escapeUntrusted } from './state-line';
import { loadSkill as defaultLoadSkill } from './skill-loader';
import { CONTINUATION_TOOLS, toolsForLeg, validateChoiceOptions } from './tool-contracts';
import type {
  AgentDeps,
  AgentLeg,
  AgentProposal,
  AgentTurnResult,
  AgentTurnState,
  Place,
} from './types';
import { createAgentTurnState } from './types';

/** Legs per user turn. It CLAMPS and sets legBudgetHit; it never throws, because
 *  a throw ends an eval run and loses every later script. */
export const MAX_AGENT_LEGS = 4;

/**
 * Re-asks allowed when a route leg comes back with no route.
 *
 * mini-swe-agent's `max_consecutive_format_errors`, and its separation from
 * `step_limit` is copied too: a re-ask raises the leg ceiling for this turn
 * rather than spending one of the four legs the real work needs. A format
 * error is the model failing to answer the question, so charging the turn for
 * it would punish the turn for the model's mistake.
 */
export const MAX_FORMAT_RETRIES = 2;

/**
 * Sent back when a route leg produced no usable `load_skill` call.
 *
 * THE POINT: the turn does not end here. mini-swe-agent raises `FormatError`,
 * appends the error to the SAME conversation and asks again, and its whole
 * loop rests on the model never being able to finish by talking. Ours could:
 * prose plus `finish_reason: stop` fell through to `break`, and 90 of 308 G2d
 * route legs ended that way. A dropped turn looked exactly like a finished one,
 * on screen and in the rows.
 */
export function routeFormatError(availableSkills: readonly string[]): string {
  return (
    'Your last reply routed nothing, so the user saw their message land and nothing happen. '
    + 'Every turn ends in exactly one load_skill call, and answering in prose is not one of '
    + 'the options. Pick the closest id from the skill index; if nothing obviously fits, load '
    + 'facts/interest, which is the catch-all and a real destination. '
    + `Legal ids: ${availableSkills.join(', ')}. `
    + 'Reply with your one short acknowledgement sentence and the load_skill call.'
  );
}

/**
 * Re-asks allowed when the FINAL reply fails the reply gate.
 *
 * Its own budget, separate from `MAX_FORMAT_RETRIES`. Sharing the route budget
 * would leave a leaking reply with no correction on a turn that also had to
 * re-route, and the two failures are unrelated. One is enough: the route re-ask
 * succeeded on its first attempt every time it fired.
 */
export const MAX_REPLY_RETRIES = 1;

/**
 * Sent back when the reply that is about to reach the user is not shippable.
 *
 * Same shape as `routeFormatError`, and for the same measured reason: on this
 * model a rule in the system prompt is advice it can decline. `facts/generic.md`
 * has forbidden the save wording since the skill was written, and 10% of G4
 * turns used it anyway.
 */
export function replyFormatError(kind: 'save-claim' | 'leak'): string {
  if (kind === 'save-claim') {
    return (
      'Your reply says you saved, noted or recorded something. Nothing is saved until the user '
      + 'taps the card, so that is not true yet and it is the one thing you must never claim. '
      + 'Rewrite the reply: say what you understood, and let the card do the rest. Keep your '
      + 'question if you had one. Do not mention saving, noting, recording or storing at all.'
    );
  }
  return (
    'Your reply exposed the scaffolding. The state block, the known-facts block, the tool names '
    + 'and the skill ids are yours to work from and the user must never see them, and never write '
    + 'about the user in the third person. Rewrite the reply as one or two plain sentences spoken '
    + 'directly to them, about what they just told you.'
  );
}

/**
 * Shown when a leaking reply survives its re-ask.
 *
 * A leak is REPLACED rather than trimmed: showing a user `<state>` or a tool
 * name is worse than showing a generic line, and surgery on arbitrary prose is
 * how a sentence gets mangled. A false save claim is NOT replaced, because a
 * slightly wrong word beside a visible card beats a mangled sentence; it is
 * counted instead.
 */
export const REPLY_LEAK_FALLBACK = 'Got it. Anything else you would like to add?';

/** Mirrors lib/llm/tokens.ts::estimateTokens; inlined so this folder imports
 *  nothing from the app. */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[一-鿿㐀-䶿豈-﫿]/g);
  const c = cjk ? cjk.length : 0;
  return Math.ceil(c / 1.2) + Math.ceil((text.length - c) / 4);
}

export interface AgentPersonaFact {
  id: string;
  statement: string;
  attribute?: string | null;
}

export interface AgentPersona {
  facts: AgentPersonaFact[];
  surface: PersonaSurface;
  languageName?: string;
}

export interface AgentState {
  persona: AgentPersona;
  turn: AgentTurnState;
}

export function createAgentState(persona: AgentPersona): AgentState {
  return { persona, turn: createAgentTurnState() };
}

/** Caps facts in context. Keeps the FIRST n, which is correct only because the
 *  caller sorts newest-first -- taking the last n once sent a heavy persona the
 *  22 OLDEST facts while telling it not to re-extract what it already knew. */
export const MAX_FACTS_IN_CONTEXT = 22;

export function formatKnownFacts(facts: AgentPersonaFact[]): string {
  if (facts.length === 0) return 'Nothing yet.';
  return facts
    .slice(0, MAX_FACTS_IN_CONTEXT)
    .map((f) => `- [${f.id}] '${escapeUntrusted(f.attribute ?? 'other', 60)}': ${escapeUntrusted(f.statement, 300)}`)
    .join('\n');
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A place the model copied back is reconciled against the candidates the port
 *  ACTUALLY returned this turn, rather than re-derived from a country map the
 *  harness deliberately does not own. Stronger than trusting a copy-verbatim
 *  rule, and it needs no import. */
export function reconcilePlaceChain(
  supplied: Record<string, unknown> | null,
  candidates: Place[],
  userMessage: string,
): Place | null {
  if (candidates.length === 0) return null;
  const wantedLocality =
    supplied && typeof supplied.locality === 'string' ? supplied.locality.toLowerCase() : null;
  const match =
    (wantedLocality && candidates.find((c) => c.locality.toLowerCase() === wantedLocality)) ||
    (candidates.length === 1 ? candidates[0] : null);
  if (!match) return null;

  // `neighbourhood` is the one place field with no GraphQL source, so it is the
  // one the model can invent. Accept it only when the user actually said it;
  // otherwise DROP it and keep the rest of the chain, which is still good.
  const suppliedHood =
    supplied && typeof supplied.neighbourhood === 'string' ? supplied.neighbourhood.trim() : '';
  const haystack = userMessage.toLowerCase().replace(/\s+/g, ' ');
  const hood =
    suppliedHood && haystack.includes(suppliedHood.toLowerCase().replace(/\s+/g, ' '))
      ? suppliedHood
      : match.neighbourhood;

  return hood ? { ...match, neighbourhood: hood } : { ...match, neighbourhood: undefined };
}

/** Pair each chip with the structured value it stands for. Matched by content,
 *  not position: positional pairing silently mis-binds the moment the model
 *  reorders its own options. Unmatched options carry a null payload rather than
 *  a wrong one. */
export function bindChoicePayloads(
  options: string[],
  candidates: Place[],
): { text: string; payload: unknown }[] {
  return options.map((text) => {
    const lower = text.toLowerCase();
    const hit = candidates.find(
      (c) =>
        (c.neighbourhood && lower.includes(c.neighbourhood.toLowerCase())) ||
        lower.includes(c.locality.toLowerCase()),
    );
    return { text, payload: hit ?? null };
  });
}

/** Only a facts/* turn owes a proposal. A conversation/* turn legitimately
 *  answers in prose and proposes nothing. */
function isFactSkill(skillId: string | null): boolean {
  return skillId !== null && skillId.startsWith('facts/');
}

function routeKindFromSkill(skillId: string): string | null {
  const slash = skillId.indexOf('/');
  if (slash === -1) return null;
  const leaf = skillId.slice(slash + 1);
  return leaf && leaf !== 'generic' ? leaf : null;
}

export interface RunAgentTurnParams {
  state: AgentState;
  userMessage: string;
  deps: AgentDeps;
  maxLegs?: number;
  promptVariant?: string;
  model?: string;
  onDelta?: (d: { content?: string; reasoning?: string }) => void;
  /** Called as each leg completes, so a UI can render tool-call progress while
   *  the turn is still running. The result only arrives at the end, and a
   *  three-leg turn takes ~10s: without this the steps box would sit empty for
   *  the whole turn and then fill at once. */
  onLeg?: (leg: AgentLeg) => void;
}

export async function runAgentTurn(params: RunAgentTurnParams): Promise<AgentTurnResult> {
  const { state, userMessage, deps } = params;
  let maxLegsThisTurn = params.maxLegs ?? MAX_AGENT_LEGS;
  const model = params.model ?? 'BIG';
  const loadSkillFn = deps.loadSkill ?? defaultLoadSkill;
  /** OFF only on the `pre-enforcement` control arm, which reproduces the loop
   *  as measured: a route leg that produced no route ends the turn, and the
   *  route leg carries all four discovery tools. */
  const enforceRoute = routeEnforcementFor(resolveAgentArm(params.promptVariant)) === 'on';

  // ---- resolve a pending choice BEFORE anything else -----------------------
  // The tap arrives as an ordinary message. Matching it here is what lets the
  // next leg save the chosen place without a second lookup.
  const turn = state.turn;
  if (turn.pendingChoice) {
    // EXACT match only, and the chips are the only thing that can consume a
    // pending choice. Anything else is a new turn, and the stale choice is
    // dropped rather than carried: a bare "Yes" typed into a fresh thread must
    // never be read as the answer to a question from another conversation.
    const tapped = turn.pendingChoice.options.find(
      (o) => o.text.trim().toLowerCase() === userMessage.trim().toLowerCase(),
    );
    if (tapped) {
      turn.resolvedChoice = {
        question: turn.pendingChoice.question,
        text: tapped.text,
        payload: tapped.payload,
      };
      turn.pendingChoice = null;
    }
  }
  const answerPending = turn.lastTurnAskedQuestion && turn.resolvedChoice === null;
  // Read BEFORE the turn overwrites it at the end, and held for every leg: the
  // question belongs to the turn being answered, not to the one being written.
  const lastQuestion = turn.lastQuestion;

  turn.turnActive = true;

  const legs: AgentLeg[] = [];
  const proposals: AgentProposal[] = [];
  let systemPrompt = buildRouterPrompt({
    surface: state.persona.surface,
    languageName: state.persona.languageName,
    answerPending,
    // THE ARM, APPLIED. Omitting this made every agent arm send a byte-identical
    // leg-0 prompt, so g2b, G2c and G2d each compared the shipped configuration
    // against itself across four "arms". `promptVariant` was declared on the
    // params, passed by the eval runner, and read nowhere.
    arm: params.promptVariant,
  });
  let routeKind: string | null = null;
  let skillLoaded: string | null = null;
  let reply = '';
  let legBudgetHit = false;
  /** One closing-sentence leg is allowed after a proposal, never a stream. */
  let silentLegAfterProposal = false;
  /** Prose written AFTER a skill loaded. The route leg's acknowledgement does
   *  not count: it says the turn began, not that the user was answered. */
  let answeredTheUser = false;
  /** Reply-gate budget and residue, reported so the rate stays measurable. */
  let replyRetries = 0;
  let replyClaimUnfixed = false;
  let replyLeakUnfixed = false;
  /** WHY the turn stopped. Counted, so a failure shows up in the rows rather
   *  than as an ordinary settled turn that happened to do nothing. */
  let terminalReason: AgentTurnResult['terminalReason'] = 'settled';
  /** Tool names the model invented. `add_fact` and `update_fact` were observed;
   *  they are not in the payload and executing nothing silently made them look
   *  like a normal turn. */
  const unknownTools: string[] = [];
  let placeCandidates: Place[] = [];
  let similarFactCount: number | null = null;
  const toolResultsThisTurn: { name: string; result: unknown }[] = [];
  /**
   * Continuation calls already made this turn, keyed name+arguments.
   *
   * A forcing tool repeated with IDENTICAL arguments has nothing new to tell
   * the model, so it must not buy another leg. Measured on device: asked "I
   * enjoy playing chess", the model called `load_skill('facts/generic')` on
   * every leg, each one forced a continuation, and the turn burned all four
   * legs and ended at the cap having produced one sentence and no fact. The
   * prose-settles rule was never reached because a forcing tool outranks it.
   */
  const continuationsSeen = new Set<string>();
  /** Attempts to load a skill after one was already loaded this turn. Counted
   *  so a prompt that keeps re-routing is visible rather than merely slow. */
  let rerouteAttempts = 0;
  /** saveExtractedFacts / ask_choice / deleteUserFacts. A facts/* turn that
   *  settles without ONE of these produced nothing the user can act on: no
   *  card, no topics, no signal. Two device turns did exactly that. */
  let proposedSomething = false;
  let forcedProposal = false;
  let reProposals = 0;
  /** Statements find_similar_facts returned, normalised. A proposal equal to
   *  one is a RE-proposal of a fact already on file, not a new fact. */
  const existingStatements = new Set<string>();
  let existingFacts: { factId: string; statement: string }[] = [];

  /** True for the ONE forced leg. */
  let forcingProposalNow = false;

  /** Route legs re-asked after producing no route. Raises this turn's leg
   *  ceiling so a re-ask does not cost the turn a leg of real work. */
  let formatRetries = 0;
  /** The violation named back to the model, consumed by the next leg. */
  let formatErrorNote: string | null = null;

  for (let index = 0; ; index++) {
    if (index >= maxLegsThisTurn + formatRetries) {
      legBudgetHit = true;
      // RUNNING OUT OF LEGS IS NOT THE SAME AS FAILING. Measured on G3: 16 of
      // the 18 baseline turns labelled `leg-cap` had already called
      // saveExtractedFacts, and the commonest "capped" shape was
      // load_skill > find_similar_facts > lookup_place > saveExtractedFacts,
      // which is a correct residence turn. What that turn is missing is a
      // closing sentence, not its work. Reporting it as a cap failure inflated
      // the rate to 23% and buried the ~2 in 18 that are real.
      //
      // A USABLE REPLY COUNTS TOO, not just a proposal. On device, "I'm
      // travelling to Hawaii" produced exactly the right answer ("a trip rather
      // than your permanent home, I won't update your residence fact") and was
      // painted as a failure, because a turn that correctly proposes NOTHING
      // still failed the proposal test. Keying only on `proposedSomething`
      // makes every correct refusal look broken.
      terminalReason = proposedSomething || answeredTheUser ? 'settled' : 'leg-cap';
      break;
    }

    const stateLine = buildStateLine({
      routeKind,
      resolvedPlaces: placeCandidates.length > 0 ? placeCandidates : null,
      similarFactCount,
      answerPending,
      resolvedChoiceText: turn.resolvedChoice?.text ?? null,
      existingFacts,
      forcedProposal: forcingProposalNow,
      lastQuestion,
    });

    // SLIM CONTEXT: system prompt, the user's message, the known facts, this
    // turn's tool results, the state line. No prior chat history.
    const messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[] = [
      { role: 'user', content: `<state>${stateLine}</state>` },
      { role: 'user', content: `<known_facts>\n${formatKnownFacts(state.persona.facts)}\n</known_facts>` },
      { role: 'user', content: escapeUntrusted(userMessage, 2000) },
    ];
    // LAST, so it is the final thing read before the model answers. Not
    // escaped: the harness wrote it, and it is the one message in the turn that
    // is not user or tool content.
    if (formatErrorNote !== null) {
      messages.push({ role: 'user', content: formatErrorNote });
      formatErrorNote = null;
    }
    for (const tr of toolResultsThisTurn) {
      messages.push({
        role: 'tool',
        content: `${tr.name}: ${escapeUntrusted(JSON.stringify(tr.result), 4000)}`,
      });
    }

    const inputTokens =
      estimateTokens(systemPrompt) + messages.reduce((n, m) => n + estimateTokens(m.content), 0);

    // THROWS PROPAGATE. The runner throws from its own callModel for run-ending
    // conditions (a 402 spend limit is the live one), and recording those as leg
    // data instead of letting them abort writes a file of empty rows that reads
    // as a model failure.
    const result = await deps.callModel({
      role: index === 0 ? 'route' : 'tool',
      model,
      systemPrompt,
      messages,
      // STRUCTURAL: once a skill is loaded, `load_skill` leaves the payload for
      // the rest of the turn. Measured across 312 corpus turns, every one of
      // the 16 capped turns was a repeated load_skill -- three in a row, or a
      // re-load at leg 3 after the other tools had already run. Withholding the
      // tool is stronger than answering it, because a tool the model cannot
      // see is one it cannot spend a leg on.
      tools: toolsForLeg({
        skillLoaded,
        forcingProposal: forcingProposalNow,
        wideRouteLeg: !enforceRoute,
      }) as unknown[],
      toolChoice: forcingProposalNow ? 'required' : 'auto',
      // FALSE on every call: measured, thinking on returned empty content on 8
      // of 10 probes at 8-10s against 0.8-1.0s and a valid answer every time.
      enableThinking: false,
      onDelta: params.onDelta,
    });

    const leg: AgentLeg = {
      index,
      role: index === 0 ? 'route' : 'tool',
      systemPrompt,
      messages,
      toolCalls: result.toolCalls,
      toolResults: [],
      rawOutput: result.content,
      result,
      inputTokens,
    };
    legs.push(leg);

    // Cleaned here too, not only at the end: the acknowledgement is the FIRST
    // thing on screen and is exactly where the measured dashes appeared.
    if (result.content.trim()) {
      reply = cleanProse(result.content);
      // AN ANSWER, as distinct from the route leg's acknowledgement. "Porto,
      // one moment." is about the turn starting; it must never make a turn that
      // then did nothing look complete. Only prose written once a skill is
      // loaded is an answer to the user.
      if (skillLoaded !== null) answeredTheUser = true;
    }

    // A leg that RESOLVED with a transport error is terminal: continuing would
    // let an offline device run four hedged legs for nothing.
    if (result.error) {
      terminalReason = 'transport-error';
      params.onLeg?.(leg);
      break;
    }

    let sawContinuationTool = false;
    let terminatedByChoice = false;

    for (const call of result.toolCalls) {
      const args = parseArgs(call.argumentsRaw);
      // A MALFORMED call is never executed and is never forcing: a truncated
      // load_skill that counted as forcing would burn the whole cap retrying.
      if (args === null) {
        leg.toolResults.push({ name: call.name, result: { error: 'malformed arguments' } });
        continue;
      }

      const callKey = `${call.name}:${call.argumentsRaw}`;
      const isRepeat = continuationsSeen.has(callKey);

      if (call.name === 'load_skill') {
        const id = typeof args.id === 'string' ? args.id : '';
        // ALREADY ACTIVE: answer, but do not buy a leg. Re-loading the skill
        // the loop is already running is a no-op, and treating it as progress
        // is what let the loop spin to the cap.
        if (skillLoaded !== null) {
          // Belt to the payload's braces: a model can still emit a call for a
          // tool that is no longer declared.
          rerouteAttempts++;
          const out = { id, alreadyLoaded: true, activeSkill: skillLoaded };
          leg.toolResults.push({ name: call.name, result: out });
          toolResultsThisTurn.push({ name: call.name, result: out });
          continue;
        }
        const body = loadSkillFn(id);
        if (body === null) {
          const out = { error: 'unknown skill id', availableSkills: [...deps.skillIds()] };
          leg.toolResults.push({ name: call.name, result: out });
          toolResultsThisTurn.push({ name: call.name, result: out });
        } else {
          skillLoaded = id;
          routeKind = routeKindFromSkill(id);
          // The loaded body becomes the NEXT leg's system prompt. It is not a
          // tool result the model reads back: each leg is assembled from
          // scratch, so "which skill is loaded" is simply which prompt we build.
          systemPrompt = body;
          const out = { id, loaded: true };
          leg.toolResults.push({ name: call.name, result: out });
          toolResultsThisTurn.push({ name: call.name, result: out });
        }
        if (!isRepeat) {
          sawContinuationTool = true;
          continuationsSeen.add(callKey);
        }
        continue;
      }

      if (call.name === 'find_similar_facts') {
        const kind = typeof args.kind === 'string' ? args.kind : undefined;
        const out = await deps.tools.findSimilarFacts({ kind });
        similarFactCount = out.candidates.length;
        existingFacts = out.candidates.map((c) => ({
          factId: c.factId,
          statement: c.statement,
        }));
        for (const c of out.candidates) {
          existingStatements.add(c.statement.trim().toLowerCase());
        }
        leg.toolResults.push({ name: call.name, result: out });
        toolResultsThisTurn.push({ name: call.name, result: out });
        if (!isRepeat) {
          sawContinuationTool = true;
          continuationsSeen.add(callKey);
        }
        continue;
      }

      if (call.name === 'lookup_place') {
        const query = typeof args.query === 'string' ? args.query : '';
        const countryHint = typeof args.countryHint === 'string' ? args.countryHint : undefined;
        const out = await deps.tools.lookupPlace({ query, countryHint });
        placeCandidates = out.status === 'resolved' ? out.places : [];
        leg.toolResults.push({ name: call.name, result: out });
        toolResultsThisTurn.push({ name: call.name, result: out });
        if (!isRepeat) {
          sawContinuationTool = true;
          continuationsSeen.add(callKey);
        }
        continue;
      }

      if (call.name === 'ask_choice') {
        const question = typeof args.question === 'string' ? args.question : '';
        if (!validateChoiceOptions(args.options) || !question) {
          // A COUNTED terminal state, never a settled prose question: letting
          // this fall through to the settled branch ends the turn as a question
          // with no chips, which is the two-questions failure the loop forbids.
          const out = { error: 'options must be 2 or 3' as const };
          leg.toolResults.push({ name: call.name, result: out });
          terminatedByChoice = true;
          terminalReason = 'malformed-choice';
          break;
        }
        proposedSomething = true;
        turn.pendingChoice = {
          question,
          options: bindChoicePayloads(args.options, placeCandidates),
        };
        leg.toolResults.push({ name: call.name, result: { awaiting: 'user' } });
        terminatedByChoice = true;
        break;
      }

      if (call.name === 'saveExtractedFacts') {
        const list = Array.isArray(args.extracted_user_information)
          ? (args.extracted_user_information as Record<string, unknown>[])
          : [];
        for (const entry of list) {
          const statement = typeof entry.statement === 'string' ? entry.statement.trim() : '';
          if (!statement) continue;
          // A RE-PROPOSAL. find_similar_facts showed the model this exact
          // statement as something already on file; offering it back is a
          // duplicate card, and on device it read as a "confirmation" of a
          // fact the user had already replaced.
          if (existingStatements.has(statement.toLowerCase())) {
            reProposals++;
            continue;
          }
          const place = reconcilePlaceChain(
            (entry.placeChain as Record<string, unknown> | undefined) ?? null,
            placeCandidates,
            userMessage,
          );
          // `replaces` requires a CONFIRMED choice, never merely that a question
          // was asked: those are different facts, and treating one as the other
          // destroys a fact on a turn nobody consented to.
          const wantsReplace = typeof entry.replaces === 'string' ? entry.replaces : null;
          const replaces = wantsReplace && turn.resolvedChoice ? wantsReplace : null;
          proposals.push({ statement, kind: routeKind, place, replaces });
        }
        if (proposals.length > 0) proposedSomething = true;
        const out = await deps.tools.saveExtractedFacts({
          extracted_user_information: list,
          proposals,
        });
        leg.toolResults.push({ name: call.name, result: out });
        toolResultsThisTurn.push({ name: call.name, result: out });
        continue;
      }

      if (call.name === 'deleteUserFacts') {
        // GATED. Model-triggered, irreversible, and it cascades to topics.
        if (!turn.resolvedChoice) {
          const out = { error: 'confirm with ask_choice first' };
          leg.toolResults.push({ name: call.name, result: out });
          toolResultsThisTurn.push({ name: call.name, result: out });
          continue;
        }
        const ids = Array.isArray(args.fact_ids) ? (args.fact_ids as string[]) : [];
        proposedSomething = true;
        const out = await deps.tools.deleteUserFacts({ fact_ids: ids });
        leg.toolResults.push({ name: call.name, result: out });
        toolResultsThisTurn.push({ name: call.name, result: out });
        continue;
      }

      // An INVENTED tool name. `add_fact` and `update_fact` were both observed
      // on the corpus. Recorded and counted, never a silent no-op: an
      // unrecognised call that produced an error nobody reads is
      // indistinguishable from a turn that simply did nothing, which is how a
      // model drifting off the declared payload stays invisible.
      unknownTools.push(call.name);
      leg.toolResults.push({ name: call.name, result: { error: `unknown tool: ${call.name}` } });
    }

    params.onLeg?.(leg);

    if (terminatedByChoice) {
      if (terminalReason === 'settled') terminalReason = 'awaiting-user';
      break;
    }
    // A leg carrying an acknowledgement AND a forcing call must CONTINUE: the
    // `forced` check runs before the settled branch, or the preamble design
    // turns every fact turn into a one-leg turn with no skill loaded.
    // NO ROUTE YET. Re-ask rather than end the turn: this is mini-swe-agent's
    // FormatError, and it covers every shape of the failure at once, including
    // an unparseable or unknown id, because from the loop's side they are the
    // same thing -- the leg was asked for a route and did not produce one.
    if (enforceRoute && skillLoaded === null && !forcingProposalNow) {
      if (formatRetries < MAX_FORMAT_RETRIES) {
        formatRetries++;
        formatErrorNote = routeFormatError(deps.skillIds());
        continue;
      }
      terminalReason = 'no-route';
      break;
    }

    if (sawContinuationTool) continue;
    if (!result.content.trim()) {
      // A leg that acted and said nothing owes the user a closing sentence, and
      // is given exactly ONE leg to write it. Unbounded, this is how a finished
      // turn walks to the cap: the proposal lands, the leg is silent, the loop
      // buys another leg, and the turn is charged for a sentence the model was
      // never going to add.
      if (proposedSomething) {
        if (silentLegAfterProposal) break;
        silentLegAfterProposal = true;
      }
      continue;
    }

    // A facts/* skill ran and the turn is about to settle having proposed
    // NOTHING. On device that is exactly what happened twice: chess loaded
    // facts/interest and then produced two legs of prose and no card, and the
    // residence turn asked four prose questions and "confirmed" a stale fact.
    // Prose is not a proposal, so one forced leg runs before settling.
    if (isFactSkill(skillLoaded) && !proposedSomething && !forcingProposalNow) {
      forcingProposalNow = true;
      forcedProposal = true;
      continue;
    }
    if (forcingProposalNow && !proposedSomething) {
      terminalReason = 'no-proposal';
      break;
    }

    // ---- THE REPLY GATE -------------------------------------------------
    // Runs HERE and only here, so it sees the FINAL reply. An intermediate
    // leg's prose is overwritten by the next leg that produces content: 12 of
    // the G4 occurrences were on legs no user ever saw, and correcting those
    // would spend legs rewriting discarded text.
    //
    // On CLEANED text, because that is what reaches the bubble.
    const finalReply = cleanProse(reply);
    const gateKind = leaksInternals(finalReply)
      ? ('leak' as const)
      : claimsSaveHappened(finalReply)
        ? ('save-claim' as const)
        : null;
    if (gateKind !== null) {
      if (replyRetries < MAX_REPLY_RETRIES) {
        replyRetries++;
        formatErrorNote = replyFormatError(gateKind);
        // Like the route re-ask, this raises the ceiling rather than spending a
        // leg of real work: the turn should not lose a proposal to a wording
        // mistake. `legBudgetHit` therefore stays untouched.
        maxLegsThisTurn++;
        continue;
      }
      // It survived its correction. A leak is REPLACED, because showing the
      // user the scaffolding is worse than showing a generic line. A save
      // claim is KEPT and counted: a slightly wrong word beside a visible card
      // beats a mangled sentence, and the residue stays measurable.
      if (gateKind === 'leak') {
        reply = REPLY_LEAK_FALLBACK;
        replyLeakUnfixed = true;
      } else {
        replyClaimUnfixed = true;
      }
    }
    break;
  }

  if (unknownTools.length > 0 && terminalReason === 'settled') {
    terminalReason = 'unknown-tool';
  }

  turn.turnActive = false;
  turn.lastTurnAskedQuestion = turn.pendingChoice !== null || /\?\s*$/.test(reply);
  // The chip question wins over the prose one: when both exist the chips are
  // what is on screen, so they are what the next message answers.
  turn.lastQuestion = turn.pendingChoice
    ? turn.pendingChoice.question
    : trailingQuestion(cleanProse(reply));
  turn.lastRoute = routeKind;
  turn.lastSkill = skillLoaded;

  return {
    legs,
    // Deterministic dash removal. Invariant 7 is unenforceable on model output
    // by prompt alone: 25% of measured prose rows carried one despite the ban.
    reply: cleanProse(reply),
    terminalReason,
    unknownTools,
    routeKind,
    skillLoaded,
    proposals,
    legBudgetHit,
    // WHAT THE UI SHOWS. `legBudgetHit` is the raw budget signal the eval reads;
    // `legCapped` is the FAILURE, and a turn that proposed something or answered
    // the user is not one. Both halves matter: a correct refusal proposes
    // nothing and is still a complete turn.
    legCapped: legBudgetHit && terminalReason === 'leg-cap',
    rerouteAttempts,
    forcedProposal,
    formatRetries,
    replyRetries,
    replyClaimUnfixed,
    replyLeakUnfixed,
    reProposals,
    state: turn,
  };
}
