// mera-harness/core — the bounded agent loop. PURE, RN-free.
//
// One loop, two callers: the RN driver (useCloudPersonaChat) wires real deps,
// the eval runner wires fakes. A harness green is therefore evidence about the
// app rather than about a parallel implementation.

import { multiSubjectFor, resolveAgentArm, routeEnforcementFor } from './arms';
import { buildRouterPrompt, type PersonaSurface } from './router-prompt';
import {
  claimsSaveHappened,
  cleanProse,
  comparableStatement,
  declaresNothingToAdd,
  isPlainNo,
  isPlainYes,
  leaksInternals,
  narratesProcess,
  trailingQuestion,
} from './prose';
import { isLocationKey, isRelationalStatement, mayReplace, mayReplaceKey, sameAttributeKey } from './fact-subject';
import {
  CANONICAL_LOCATION_KEY,
  COMBINED_ORIGIN_KEY,
  EXPAT_KEY,
  ORIGIN_KEY,
  countryOf,
  expatStatement,
  toOriginStatement,
  isCombinedOriginFact,
  isExpatStatement,
  isOriginStatement,
  originCountry,
  sameCountry,
  threeFactsOf,
} from './combined-fact';
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
 * Several subjects in one turn (the `multi-subject` arm, audit B1): at most
 * this many skills, and each segment after the first gets this many legs.
 * Three legs is lookups, the offer, and a closing sentence; the last of them
 * is the forced offer when nothing was offered yet.
 */
export const MAX_SEGMENTS = 3;
export const SEGMENT_LEGS = 3;

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
export function replyFormatError(kind: 'save-claim' | 'leak' | 'process'): string {
  if (kind === 'process') {
    return (
      'Your reply describes what you are about to do instead of answering. The user sees it as '
      + 'your whole answer. Do not say you will check, look up or load anything, and do not '
      + 'promise an offer: answer their message now in one or two plain sentences, or ask one '
      + 'short question.'
    );
  }
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

/**
 * Re-asks allowed when the final reply narrates the loop's process. Its own
 * budget, like the other two, for the same reason: the failures are unrelated.
 */
export const MAX_PROCESS_RETRIES = 1;

/** Shown when a narrating reply survives its re-ask on a turn that has no card
 *  to speak for it. A card on screen needs no words, so there the reply is
 *  simply dropped. */
export const REPLY_PROCESS_FALLBACK = "Sorry, I didn't get to that. Could you say it again?";

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
  /**
   * Readings on fact cards from earlier turns that the user has not answered
   * yet, set by the driver before each turn (it is the one that can see which
   * cards are resolved). A typed message while a card waits is a NEW turn, so
   * without this the loop could offer the same reading again beside the card
   * still on screen. Exact repeats are dropped; the model is told the rest.
   */
  pendingCardStatements?: string[];
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

/** A chip payload that is a Place (the only structured payload a chip
 *  carries today), or null. */
function placeFromPayload(payload: unknown): Place | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Partial<Place>;
  return typeof p.locality === 'string' && typeof p.countryCode === 'string' ? (p as Place) : null;
}

/**
 * First-person statements rewritten as facts. Measured on staging: "I am an
 * expat from India", "I live in Nieuw-West, Amsterdam", "Moved to Berlin, ...
 * last month". A fact names the user in the third person and a home is
 * "Lives in ...", or none of the loop's rules recognise it.
 */
function asThirdPersonFact(entry: Record<string, unknown>): Record<string, unknown> {
  let t = typeof entry.statement === 'string' ? entry.statement.trim() : '';
  if (!t) return entry;
  t = t.replace(/^(?:i\s+am|i['’]m|im)\s+(?:an?\s+)?/i, '');
  // "User is an expat ...", "The user lives in ...", "Is an expat from
  // India" (all measured on staging). Stripped only when what is left is a
  // home, an origin or an expat status, so no other fact's wording changes.
  const bare = t.replace(/^(?:(?:the\s+)?user\s+)?(?:is\s+(?:an?\s+)?)?/i, '');
  if (bare !== t && (
    isOriginStatement(bare) || isExpatStatement(bare) || /^expat\b/i.test(bare)
    || /^(?:(?:have\s+|recently\s+)?moved|live|lives|living|reside|resides)\s+(?:in|to)\s/i.test(bare)
  )) t = bare;
  const home = /^(?:i\s+)?(?:(?:have\s+|recently\s+)?moved|live|lives|living|reside|resides)\s+(?:in|to)\s+(.+)$/i.exec(t);
  if (home) {
    const where = home[1]
      .replace(/\s+(?:last\s+(?:week|month|year)|this\s+(?:month|year)|recently|a\s+few\s+(?:weeks|months|years)\s+ago)\.?$/i, '')
      .replace(/\.$/, '');
    t = `Lives in ${where}`;
  } else {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t === entry.statement ? entry : { ...entry, statement: t };
}

/** "Lives in <what the user said>, <region>, <country>, <bloc>": the user's
 *  own first rung is kept when it is finer than the locality (a
 *  neighbourhood), then the looked-up chain. */
function chainStatement(where: string, place: Place): string {
  const first = where.split(',')[0].trim();
  const rungs = [
    first.toLowerCase() !== place.locality.toLowerCase() ? first : null,
    place.locality,
    place.admin1,
    place.countryName,
    place.bloc,
  ].filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  return collapseRepeatedRungs(`Lives in ${rungs.join(', ')}`);
}

/** Append "Expat in <country>" for an origin entry when the user's current
 *  country is known and differs, unless one is already offered or on file. */
function addExpatStatus(
  list: Record<string, unknown>[],
  facts: AgentPersonaFact[],
  known: readonly Place[],
): void {
  const origin = list.find((e) => e.questionnaire_attribute === ORIGIN_KEY);
  if (!origin) return;
  if (list.some((e) => e.questionnaire_attribute === EXPAT_KEY)) return;
  if (facts.some((f) => f.attribute === EXPAT_KEY || isExpatStatement(f.statement))) return;
  const homeEntry = list.find((e) => isHomeEntry(e));
  const homeFact = facts.find(
    (f) => isLocationKey(f.attribute) && !isRelationalStatement(f.statement),
  );
  const country = homeEntry
    ? countryOf(String(homeEntry.statement), known)
    : homeFact
      ? countryOf(homeFact.statement, known)
      : null;
  if (!country || sameCountry(country, originCountry(String(origin.statement)))) return;
  list.push({ statement: expatStatement(country), questionnaire_attribute: EXPAT_KEY });
}

/**
 * A combined origin-and-home entry from the model, expanded into its separate
 * facts; any other entry unchanged. A `replaces` on the combined entry goes
 * with the residence part, the only part that can replace a home.
 */
function expandCombinedEntry(
  entry: Record<string, unknown>,
  known: readonly Place[],
): Record<string, unknown>[] {
  const statement = typeof entry.statement === 'string' ? entry.statement : '';
  const attribute = typeof entry.questionnaire_attribute === 'string' ? entry.questionnaire_attribute : '';
  const looksCombined =
    attribute.trim().toLowerCase() === COMBINED_ORIGIN_KEY
    || /\b(?:expat|migrant|immigrant|originally|from)\b[^,]*\b(?:living|based|settled|residing)\s+in\b/i.test(statement);
  const parts = looksCombined ? threeFactsOf(statement, known) : null;
  if (!parts) return [entry];
  const out: Record<string, unknown>[] = [
    { statement: parts.origin, questionnaire_attribute: ORIGIN_KEY },
  ];
  if (parts.expat) out.push({ statement: parts.expat, questionnaire_attribute: EXPAT_KEY });
  out.push({
    statement: parts.residence,
    questionnaire_attribute: CANONICAL_LOCATION_KEY,
    ...(typeof entry.replaces === 'string' ? { replaces: entry.replaces } : {}),
  });
  return out;
}

/**
 * The EXACT key for the three identity kinds. The model writes "origin",
 * "expat" or "location" (measured on staging); the topic generator's home
 * anchor matches the canonical home string byte for byte, and the loop's own
 * rules match these constants. Other kinds are left exactly as written.
 */
function withExactKey(entry: Record<string, unknown>): Record<string, unknown> {
  const statement = typeof entry.statement === 'string' ? entry.statement : '';
  const attribute = typeof entry.questionnaire_attribute === 'string' ? entry.questionnaire_attribute : '';
  const key = attribute.split(':')[0].trim().toLowerCase();
  // The model invents snake-case keys ("origin_country", "residence_city"):
  // only their first word is read.
  const head = key.split(/[_\s-]+/)[0];
  const loose = key === '' || ['origin', 'background', 'expat', 'nationality', 'heritage'].includes(head);
  const looseHome = key === '' || ['residence', 'location', 'home', 'city', 'current', 'lives', 'living'].includes(head);
  if (isExpatStatement(statement) && loose) return { ...entry, questionnaire_attribute: EXPAT_KEY };
  if (isOriginStatement(statement) && loose) {
    // "Expat from India" is the ORIGIN, written "From India"; being an expat
    // is its own fact (see addExpatStatus).
    return { ...entry, statement: toOriginStatement(statement), questionnaire_attribute: ORIGIN_KEY };
  }
  if ((isLocationKey(attribute) || (looseHome && /^lives in\b/i.test(statement.trim())))
      && !isRelationalStatement(statement)) {
    return { ...entry, questionnaire_attribute: CANONICAL_LOCATION_KEY };
  }
  return entry;
}

/** An entry that states where the USER lives: the home key, or a residence-
 *  shaped statement with no key at all. */
function isHomeEntry(entry: Record<string, unknown>): boolean {
  const attribute = typeof entry.questionnaire_attribute === 'string' ? entry.questionnaire_attribute : null;
  if (attribute) return isLocationKey(attribute);
  return /^lives in\b/i.test(String(entry.statement ?? '').trim());
}

/** "Lives in Porto, Porto, Portugal" gives "Lives in Porto, Portugal": a rung
 *  equal to the one before it (ignoring "Lives in" and case) is dropped. */
export function collapseRepeatedRungs(statement: string): string {
  const parts = statement.split(',').map((p) => p.trim()).filter(Boolean);
  const bare = (p: string) => p.replace(/^(?:lives|living|based|resides?)\s+in\s+/i, '').toLowerCase();
  const out: string[] = [];
  for (const p of parts) {
    if (out.length > 0 && bare(out[out.length - 1]) === bare(p)) continue;
    out.push(p);
  }
  return out.join(', ');
}

/** The user's own current home among the facts on file, or null. */
function currentHomeFact(
  facts: AgentPersonaFact[],
  statement: string,
): AgentPersonaFact | null {
  const isResidenceStatement = (s: string) => /^(?:lives|living|based|resides?)\s+in\b/i.test(s.trim());
  return (
    facts.find(
      (f) =>
        !isCombinedOriginFact(f.attribute)
        && (isLocationKey(f.attribute) || isResidenceStatement(f.statement))
        && mayReplace(statement, f.statement)
        && comparableStatement(f.statement) !== comparableStatement(statement),
    ) ?? null
  );
}

/** Distinct place rungs in a statement ("Porto, Porto, Portugal" is two). */
function placeRungs(statement: string): number {
  return new Set(
    statement.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean),
  ).size;
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
  const multiSubject = multiSubjectFor(resolveAgentArm(params.promptVariant)) === 'on';

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
  // A PLAIN YES to the last question continues that question's subject, the
  // same way a chip tap does, but it is NEVER a confirmation: resolvedChoice
  // stays null, so it cannot authorise a delete or a tap-gated replace. Measured
  // on device: "Yes please add it." after an offer routed fresh, landed on
  // conversation/question, and asked the same thing again as chips.
  // A PLAIN NO continues the same way (owner ruling ux1, F7): a short answer
  // to the pending question resumes it, anything else is a new turn.
  const plainAnswer: 'yes' | 'no' | null = isPlainYes(userMessage)
    ? 'yes'
    : isPlainNo(userMessage)
      ? 'no'
      : null;
  const typedYesResume =
    turn.resolvedChoice === null
    && turn.lastQuestion !== null
    && turn.lastSkill !== null
    && turn.lastSkill.startsWith('facts/')
    && plainAnswer !== null;
  const answerPending =
    turn.lastTurnAskedQuestion && turn.resolvedChoice === null && !typedYesResume;
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
  /** Every skill this turn ran, in order. One entry unless the multi-subject
   *  arm queued more. */
  const skillsLoaded: string[] = [];
  /** Skills the route leg asked for beyond the first, waiting their turn. */
  const queuedSkills: string[] = [];
  /** Per-segment outcome, collected only when more than one segment ran. */
  const segmentReplies: { text: string; asked: boolean }[] = [];
  const segmentTerminals: AgentTurnResult['terminalReason'][] = [];
  /** The segment whose ask_choice is waiting. A tap resumes THAT skill. */
  let askingSkill: string | null = null;
  let proposedAny = false;
  /** True when this turn RESUMED the skill that asked the question, instead of
   *  spending a leg routing a chip tap as if it were a fresh intent. */
  let resumedSkill = false;

  // ---- a chip tap CONTINUES the turn that asked -----------------------------
  // A disambiguation answer is not a new intent, and routing it as one loses
  // the subject the question was about.
  //
  // MEASURED ON DEVICE, and the worst data-loss path found so far: "my
  // girlfriend's parents live in Porto Santo" routed correctly to
  // `facts/family` and asked which Porto Santo. The tap came back as an
  // ordinary message, the router saw a bare place name against a persona with
  // a residence fact, and sent it to `facts/residence`. That skill has no idea
  // whose home it is, so it proposed "Lives in Vila Baleira" and offered it as
  // a REPLACEMENT for the user's own Amsterdam home.
  //
  // The subject guard on `replaces` cannot save this one: by then both
  // statements read as the user's own, because the model had already dropped
  // the girlfriend from the sentence. The subject has to survive the question,
  // which means resuming the skill rather than re-deciding.
  if ((turn.resolvedChoice !== null || typedYesResume) && turn.lastSkill !== null) {
    const body = deps.loadSkill(turn.lastSkill);
    if (body !== null) {
      skillLoaded = turn.lastSkill;
      routeKind = routeKindFromSkill(turn.lastSkill);
      systemPrompt = body;
      resumedSkill = true;
      skillsLoaded.push(turn.lastSkill);
    }
  }
  // A place the chip resolved, carried for as long as the asking skill keeps
  // resuming. Any other turn starts clean.
  const tappedPlace = placeFromPayload(turn.resolvedChoice?.payload);
  if (tappedPlace) turn.confirmedPlace = tappedPlace;
  else if (!resumedSkill) turn.confirmedPlace = null;

  /** The route leg's acknowledgement. Kept apart from `reply` so it can never
   *  become the answer by default. */
  let acknowledgement = '';
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
  let processRetries = 0;
  let replyProcessUnfixed = false;
  /** WHY the turn stopped. Counted, so a failure shows up in the rows rather
   *  than as an ordinary settled turn that happened to do nothing. */
  let terminalReason: AgentTurnResult['terminalReason'] = 'settled';
  /** Tool names the model invented. `add_fact` and `update_fact` were observed;
   *  they are not in the payload and executing nothing silently made them look
   *  like a normal turn. */
  const unknownTools: string[] = [];
  /** The status of the last lookup_place this turn, or null if none ran. */
  let lastLookupStatus: string | null = null;
  let placeCandidates: Place[] = resumedSkill && turn.confirmedPlace ? [turn.confirmedPlace] : [];
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
  /** Replaces refused because the two facts are about different people. */
  let refusedReplaces = 0;
  /** Statements find_similar_facts returned, normalised. A proposal equal to
   *  one is a RE-proposal of a fact already on file, not a new fact. */
  // EVERY fact on file, not just what find_similar_facts returned: a forced
  // leg re-offered "Follows EU regulation" beside a reply saying it was
  // already on file (ux1 C3), and that turn had never called the lookup.
  const existingStatements = new Set<string>(
    state.persona.facts.map((f) => comparableStatement(f.statement)).filter(Boolean),
  );
  /** Statements already offered THIS TURN, so one fact cannot become two
   *  cards. Separate from `existingStatements`, which holds facts on file. */
  // Seeded on a resume: the cards the previous turn offered are still on
  // screen, so the resumed skill must not offer them a second time.
  const pendingCardList = (state.pendingCardStatements ?? []).filter((s) => s.trim().length > 0);
  const proposedStatements = new Set<string>([
    ...(resumedSkill ? turn.offeredStatements : []),
    ...pendingCardList.map((s) => s.trim().toLowerCase()),
  ]);
  /** What THIS turn offered, carried to the next turn for the same reason. */
  const offeredThisTurn: string[] = [];
  /** A home fact was already offered this turn (see the save handler). */
  let homeOfferedThisTurn = false;
  let existingFacts: { factId: string; statement: string }[] = [];
  /** A retired combined origin-and-home fact still on file, if any. */
  const combinedFactOnFile = state.persona.facts.find((f) => isCombinedOriginFact(f.attribute)) ?? null;

  /** True for the ONE forced leg. */
  let forcingProposalNow = false;

  /** Route legs re-asked after producing no route. Raises this turn's leg
   *  ceiling so a re-ask does not cost the turn a leg of real work. */
  let formatRetries = 0;
  /** The violation named back to the model, consumed by the next leg. */
  let formatErrorNote: string | null = null;

  let nextLegIndex = 0;
  segments: while (true) {
  for (let index = nextLegIndex; ; index++) {
    nextLegIndex = index + 1;
    // THE LAST LEG OF A FACTS TURN IS AN OFFER. Measured on device: "I also
    // follow the Champions League" spent route + three find_similar_facts
    // (each a different `kind`, so each bought a leg), hit the cap, and ended
    // `settled` on "Let me check what you already follow, then I can offer
    // this." with nothing offered. The forced leg used to run only when a leg
    // settled on prose, which a turn walking to the cap never does.
    if (
      index === maxLegsThisTurn + formatRetries - 1
      && isFactSkill(skillLoaded)
      && !proposedSomething
      && !forcingProposalNow
    ) {
      forcingProposalNow = true;
      forcedProposal = true;
    }
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
      terminalReason =
        proposedSomething || answeredTheUser
          ? 'settled'
          : forcedProposal
            ? 'no-proposal'
            : 'leg-cap';
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
      answeredYesTo: typedYesResume && plainAnswer === 'yes' ? lastQuestion : null,
      answeredNoTo: typedYesResume && plainAnswer === 'no' ? lastQuestion : null,
      pendingCards: pendingCardList,
      segmentScope:
        skillsLoaded.length + queuedSkills.length > 1 && routeKind
          ? {
              mine: routeKind,
              others: [...skillsLoaded, ...queuedSkills]
                .filter((id) => id !== skillLoaded)
                .map((id) => routeKindFromSkill(id) ?? id),
              questionPending: askingSkill !== null,
            }
          : null,
    });

    // SLIM CONTEXT: system prompt, the user's message, the known facts, this
    // turn's tool results, the state line. No prior chat history.
    const messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[] = [
      { role: 'user', content: `<state>${stateLine}</state>` },
      { role: 'user', content: `<known_facts>\n${formatKnownFacts(state.persona.facts)}\n</known_facts>` },
      // THE MESSAGE THE QUESTION WAS ABOUT, on a resumed turn only.
      //
      // A chip tap arrives as its own label and nothing else, so the resumed
      // skill sees "Bhopal, Madhya Pradesh, India, Asia" with no idea whose
      // Bhopal it is. Measured: `facts/family` resumed correctly and then
      // proposed "Lives in Bhopal" for the USER, because the word "parents"
      // only ever existed in the previous turn's message. Resuming the skill
      // without the subject moves the bug rather than fixing it.
      ...(resumedSkill && turn.lastUserMessage
        ? [
            {
              role: 'user' as const,
              content: `They were answering this: ${escapeUntrusted(turn.lastUserMessage, 2000)}`,
            },
          ]
        : []),
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
        // One question per turn: a later segment never gets ask_choice once an
        // earlier one is waiting on the user.
        allowChoice: askingSkill === null,
      }) as unknown[],
      toolChoice: forcingProposalNow ? 'required' : 'auto',
      // FALSE on every call: measured, thinking on returned empty content on 8
      // of 10 probes at 8-10s against 0.8-1.0s and a valid answer every time.
      enableThinking: false,
      // ONLY THE ROUTE LEG STREAMS. It is the acknowledgement and is never
      // replaced; every later leg's text used to stream into the same bubble
      // and was then swapped for the final reply, so the text the user was
      // reading changed under them and the bubble jumped. The answer arrives
      // whole at the end of the turn, as its own bubble.
      onDelta: index === 0 && !resumedSkill ? params.onDelta : undefined,
      streamToUser: index === 0 && !resumedSkill,
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
      const cleaned = cleanProse(result.content);
      if (index === 0 && !resumedSkill) {
        // The ACKNOWLEDGEMENT. Kept apart from the answer: it said the turn
        // began, and when every later leg was silent it used to ship as the
        // whole reply.
        acknowledgement = cleaned;
      } else {
        reply = cleaned;
        // AN ANSWER, as distinct from the acknowledgement. Narration of the
        // loop's own process is not one: "Let me check what you already
        // follow" made a turn that offered nothing look complete.
        if (skillLoaded !== null && !narratesProcess(cleaned)) answeredTheUser = true;
      }
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
          // SEVERAL SUBJECTS (multi-subject arm only): a further load_skill on
          // the ROUTE leg queues its skill as the next segment. Anywhere else,
          // or on any other arm, it is a reroute, answered and not followed.
          if (
            multiSubject
            && index === 0
            && id !== skillLoaded
            && !queuedSkills.includes(id)
            && skillsLoaded.length + queuedSkills.length < MAX_SEGMENTS
            && loadSkillFn(id) !== null
            && !(id.startsWith('conversation/') && skillLoaded.startsWith('facts/'))
          ) {
            queuedSkills.push(id);
            const out = { id, queued: true };
            leg.toolResults.push({ name: call.name, result: out });
            continue;
          }
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
          skillsLoaded.push(id);
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
          existingStatements.add(comparableStatement(c.statement));
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
        lastLookupStatus = out.status;
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
        // A PLACE THAT RESOLVED TO ONE MATCH IS NOT A QUESTION (owner ruling
        // Q1: the card is the consent for a replacement). Measured on staging,
        // "Berlin" resolved to one place and the model still asked "Berlin
        // replaces your Amsterdam fact?", ending the turn with no card. On a
        // home or origin turn that question is refused and the leg continues,
        // as is any question after the home card is already offered ("Should
        // I replace your Amsterdam address?", measured the same way).
        if (
          (skillLoaded === 'facts/residence' || skillLoaded === 'facts/origin')
          && ((lastLookupStatus === 'resolved' && placeCandidates.length === 1) || homeOfferedThisTurn)
        ) {
          const out = {
            error:
              'Only an ambiguous place is asked here. Offer the facts now with saveExtractedFacts; '
              + 'the card asks the user about any replacement.',
          };
          leg.toolResults.push({ name: call.name, result: out });
          toolResultsThisTurn.push({ name: call.name, result: out });
          sawContinuationTool = true;
          continue;
        }
        if (!validateChoiceOptions(args.options) || !question) {
          // A COUNTED terminal state, never a settled prose question: letting
          // this fall through to the settled branch ends the turn as a question
          // with no chips, which is the two-questions failure the loop forbids.
          const out = { error: 'options must be 2 or 3' as const };
          leg.toolResults.push({ name: call.name, result: out });
          terminatedByChoice = true;
          terminalReason = 'malformed-choice';
          // NOT `break`: see below.
          continue;
        }
        if (terminatedByChoice) {
          // One question per turn. A second ask_choice in the same leg is
          // answered with an error rather than overwriting the first.
          leg.toolResults.push({ name: call.name, result: { error: 'one question per turn' } });
          continue;
        }
        proposedSomething = true;
        turn.pendingChoice = {
          question,
          options: bindChoicePayloads(args.options, placeCandidates),
        };
        leg.toolResults.push({ name: call.name, result: { awaiting: 'user' } });
        terminatedByChoice = true;
        // ENDS THE TURN, BUT NOT THE LEG. This used to `break` out of the
        // tool-call loop, so any saveExtractedFacts the model placed after the
        // question in the same leg was never executed: "I'm 34, a product
        // manager in Berlin, from Bangalore" asked which Berlin and dropped
        // the job and the age. The rest of the leg still runs; the turn ends
        // after it.
        continue;
      }

      if (call.name === 'saveExtractedFacts') {
        // THREE FACTS, NEVER ONE (owner decision, ux1): a combined
        // origin-and-home entry is expanded into origin, expat status and
        // residence before anything else looks at it, and every entry of
        // those three kinds gets its EXACT key, since the model shortens keys.
        const list = (
          Array.isArray(args.extracted_user_information)
            ? (args.extracted_user_information as Record<string, unknown>[])
            : []
        )
          .map(asThirdPersonFact)
          .flatMap((e) => expandCombinedEntry(e, placeCandidates))
          .map(withExactKey);
        // A HOME THE MODEL DID NOT LOOK UP is looked up by the loop, once:
        // an unresolved "Nieuw-West, Amsterdam" has no country, so it can
        // anchor nothing and carries no expat status. Only when the country is
        // needed (an origin offered this turn, or an expat status on file that
        // a border move updates), and only a single match is used; anything
        // else is left as the model wrote it.
        const needsCountry =
          list.some((e) => e.questionnaire_attribute === ORIGIN_KEY)
          || state.persona.facts.some((f) => f.attribute === EXPAT_KEY || isExpatStatement(f.statement));
        for (const e of needsCountry ? list : []) {
          if (!isHomeEntry(e) || countryOf(String(e.statement), placeCandidates) !== null) continue;
          const where = String(e.statement).replace(/^lives\s+in\s+/i, '').trim();
          if (where.length < 2) continue;
          const found = await deps.tools.lookupPlace({ query: where });
          if (found.status === 'resolved' && found.places.length === 1) {
            placeCandidates = found.places;
            e.statement = chainStatement(where, found.places[0]);
          }
        }
        // AN EXPAT ORIGIN BRINGS ITS STATUS: "From India" plus "Expat in
        // <country>" when the current home's country is known and differs.
        addExpatStatus(list, state.persona.facts, placeCandidates);
        // A BARE "Expat." says nothing an expat status does not: dropped when
        // one is offered or on file, kept when it is the only expat card.
        const hasExpatStatus =
          list.some((e) => e.questionnaire_attribute === EXPAT_KEY)
          || state.persona.facts.some((f) => f.attribute === EXPAT_KEY || isExpatStatement(f.statement));
        for (let i = list.length - 1; hasExpatStatus && i >= 0; i--) {
          if (/^expat\.?$/i.test(String(list[i].statement ?? '').trim())) list.splice(i, 1);
        }
        // THE LIST THE APP ACTUALLY READS. `handleSaveExtractedFacts` builds
        // the cards from `extracted_user_information`, not from `proposals`,
        // so a decision made only on the parallel array is a decision the user
        // never sees. Both the duplicate drop and the refused replace below
        // have to land HERE or they are cosmetic. Same failure shape as
        // `runAgentTurn` having no callers and `legCapped` being hardcoded.
        const sanitised: Record<string, unknown>[] = [];
        // ONE CURRENT HOME PER TURN. The model offered "Lives in Porto,
        // Portugal, EU" and "Lives in Porto, Porto, Portugal, EU" as two
        // Replace cards on device (ux1 C1). Within a call the richest chain
        // is kept; a home offered on a later leg is dropped.
        const homes = list.filter((e) => isHomeEntry(e));
        const bestHome = homes.length > 1
          ? homes.reduce((a, b) => (placeRungs(String(b.statement)) > placeRungs(String(a.statement)) ? b : a))
          : null;
        for (const entry of list) {
          if (isHomeEntry(entry)) {
            if (homeOfferedThisTurn || (bestHome !== null && entry !== bestHome)) {
              reProposals++;
              continue;
            }
          }
          const rawStatement = typeof entry.statement === 'string' ? entry.statement.trim() : '';
          // "Lives in Porto, Porto, Portugal, EU" (city and region share a
          // name) reads as a stutter on the card (ux1 C1).
          const statement = isHomeEntry(entry) ? collapseRepeatedRungs(rawStatement) : rawStatement;
          if (!statement) continue;
          // A RE-PROPOSAL. find_similar_facts showed the model this exact
          // statement as something already on file; offering it back is a
          // duplicate card, and on device it read as a "confirmation" of a
          // fact the user had already replaced.
          if (existingStatements.has(comparableStatement(statement))) {
            reProposals++;
            continue;
          }
          const place = reconcilePlaceChain(
            (entry.placeChain as Record<string, unknown> | undefined) ?? null,
            placeCandidates,
            userMessage,
          );
          // THE SAME CARD TWICE. `existingStatements` only holds facts already
          // ON FILE, so a model that proposes one statement on two legs — or
          // twice in one call — got two identical cards, both blocking the
          // composer. Measured from TestFlight: two "Which one did you mean?"
          // cards offering the same two readings of the same Bhopal fact.
          if (proposedStatements.has(statement.toLowerCase())) {
            reProposals++;
            continue;
          }
          proposedStatements.add(statement.toLowerCase());
          // `replaces` requires a CONFIRMED choice, never merely that a question
          // was asked: those are different facts, and treating one as the other
          // destroys a fact on a turn nobody consented to.
          const wantsReplace = typeof entry.replaces === 'string' ? entry.replaces : null;
          const replaceTarget = wantsReplace
            ? state.persona.facts.find((f) => f.id === wantsReplace)
            : undefined;
          const entryAttribute =
            typeof entry.questionnaire_attribute === 'string' ? entry.questionnaire_attribute : null;
          // THE CARD IS THE CONSENT for a same-key replace (owner ruling, ux1
          // Q1). A replacement card names the fact and the topics it removes
          // and needs its own tap, so asking first through ask_choice made a
          // move take two confirmations for one decision. The chip is still
          // required for anything ELSE: a replace across keys is a judgement
          // the user has to make before the card, not on it.
          const sameKey = !!replaceTarget && sameAttributeKey(entryAttribute, replaceTarget.attribute);
          let replaces = wantsReplace && (turn.resolvedChoice || sameKey) ? wantsReplace : null;
          // THE OLD COMBINED FACT GOES WITH ITS OWN ORIGIN HALF. An origin element
          // offered while a combined origin-and-home fact is on file replaces it
          // (ux1 Q2): the split and the skill's own offer are then ONE card, not
          // two cards saying "Expat from India".
          if (replaces === null && entryAttribute === ORIGIN_KEY && combinedFactOnFile) {
            replaces = combinedFactOnFile.id;
          }
          // A HOME FACT IS ONLY REPLACED BY A HOME FACT. Demoted, never dropped.
          if (replaces !== null && replaceTarget && !mayReplaceKey(entryAttribute, replaceTarget.attribute)) {
            refusedReplaces++;
            replaces = null;
          }
          // SUBJECT AGREEMENT. A replace is a destroy, and the confirmed-choice
          // guard above does not speak to WHOSE fact is being destroyed: the
          // user confirming which Porto Santo they meant is not consent to
          // delete their own home. Demoted to a plain new proposal rather than
          // dropped, so the fact still reaches them.
          if (replaces !== null) {
            const target = state.persona.facts.find((f) => f.id === replaces);
            if (target && !mayReplace(statement, target.statement)) {
              refusedReplaces++;
              replaces = null;
            }
          }
          // A MOVE REPLACES THE CURRENT HOME, found by the loop rather than
          // left to the model. On device "I moved to Porto" beside "Lives in
          // Berlin..." came back as a plain Add ("I did not find any existing
          // residence fact"), which would leave two current homes. A new home
          // with no target takes the one home on file: under any home key,
          // short or canonical, or a residence statement with no key at all,
          // and never a relative's.
          if (replaces === null && isHomeEntry(entry)) {
            const home = currentHomeFact(state.persona.facts, statement);
            if (home) replaces = home.id;
          }
          if (isHomeEntry(entry)) homeOfferedThisTurn = true;
          proposals.push({ statement, kind: routeKind, place, replaces });
          offeredThisTurn.push(statement.toLowerCase());
          // Carry the entry through with the loop's verdict on `replaces`
          // applied, and nothing else touched: `alternatives` and
          // `questionnaire_attribute` are the card's own and are not this
          // loop's to rewrite.
          // THE ROUTE THE TURN ALREADY CHOSE, handed to topic generation.
          // Without it `startTopicGeneration` finds no `skillId`, every fact
          // falls to the shipped one-size prompt, and all six `topics/*`
          // skills are dead code in the app -- authored, unit-tested, and
          // never once run on a user's phone.
          // Checked against the real id list, never assumed from the route.
          // `conversation/correction` also saves facts, and its route kind is
          // "correction", for which there is no topics leaf: stamping
          // `topics/correction` would hand the job a skill that cannot load
          // and turn every correction into a failed topic run.
          const candidateSkill = routeKind ? `topics/${routeKind}` : null;
          const topicSkill =
            candidateSkill && (deps.skillIds() as readonly string[]).includes(candidateSkill)
              ? candidateSkill
              : undefined;
          sanitised.push({
            ...entry,
            statement,
            replaces: replaces === null ? undefined : replaces,
            ...(topicSkill ? { topic_skill_id: topicSkill } : {}),
          });
        }
        // A MOVE ACROSS A BORDER also moves the expat status: the residence
        // card is joined by one updating "Expat in <country>", replacing the
        // expat fact on file. Never offered for the country the user is from.
        for (const e of [...sanitised]) {
          const target = typeof e.replaces === 'string'
            ? state.persona.facts.find((f) => f.id === e.replaces)
            : undefined;
          if (!isHomeEntry(e) || !target) continue;
          const newCountry = countryOf(String(e.statement), placeCandidates);
          const oldCountry = countryOf(target.statement);
          if (!newCountry || !oldCountry || sameCountry(newCountry, oldCountry)) continue;
          const expatFact = state.persona.facts.find(
            (f) => f.attribute === EXPAT_KEY || isExpatStatement(f.statement),
          );
          const originFact = state.persona.facts.find(
            (f) => f.attribute === ORIGIN_KEY || isOriginStatement(f.statement),
          );
          if (!expatFact) continue;
          if (originFact && sameCountry(newCountry, originCountry(originFact.statement))) continue;
          if (sanitised.some((x) => x.replaces === expatFact.id)) continue;
          const statement = expatStatement(newCountry);
          sanitised.push({
            statement,
            questionnaire_attribute: EXPAT_KEY,
            replaces: expatFact.id,
            ...((deps.skillIds() as readonly string[]).includes('topics/origin')
              ? { topic_skill_id: 'topics/origin' }
              : {}),
          });
          proposals.push({ statement, kind: 'origin', place: null, replaces: expatFact.id });
          proposedStatements.add(statement.toLowerCase());
          offeredThisTurn.push(statement.toLowerCase());
        }
        if (sanitised.length > 0) proposedSomething = true;
        const out = await deps.tools.saveExtractedFacts({
          extracted_user_information: sanitised,
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
    // A reply that says there is nothing to add is an answer, not a missing
    // offer: forcing an offer after it put a card under "that's already on
    // file" (ux1 C3).
    if (
      isFactSkill(skillLoaded)
      && !proposedSomething
      && !forcingProposalNow
      && !declaresNothingToAdd(cleanProse(reply))
    ) {
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
    // PROCESS NARRATION, checked after the leak test and before the save
    // claim. On a facts turn that has offered nothing, the fix is the offer
    // itself, not better wording: the forced leg runs instead of a re-ask.
    if (!leaksInternals(finalReply) && narratesProcess(finalReply)) {
      if (isFactSkill(skillLoaded) && !proposedSomething && !forcingProposalNow) {
        forcingProposalNow = true;
        forcedProposal = true;
        continue;
      }
      if (processRetries < MAX_PROCESS_RETRIES) {
        processRetries++;
        formatErrorNote = replyFormatError('process');
        maxLegsThisTurn++;
        continue;
      }
    }
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
        // A card on screen speaks for itself: the fallback's "anything else?"
        // beside a choice still waiting asked for more at the wrong moment
        // (ux1 C4).
        reply = proposedSomething ? '' : REPLY_LEAK_FALLBACK;
        replyLeakUnfixed = true;
      } else {
        replyClaimUnfixed = true;
      }
    }
    break;
  }

    // ---- NEXT SEGMENT (multi-subject arm) ------------------------------
    // The segment that just ended keeps its proposals, its question and its
    // reply; the next one starts from its own guideline with a clean slate
    // of lookups, so it never reads the previous subject's tool results.
    proposedAny = proposedAny || proposedSomething;
    if (
      queuedSkills.length > 0
      && terminalReason !== 'transport-error'
      && terminalReason !== 'no-route'
    ) {
      segmentReplies.push({ text: reply, asked: terminalReason === 'awaiting-user' });
      segmentTerminals.push(terminalReason);
      if (terminalReason === 'awaiting-user') askingSkill = skillLoaded;
      const next = queuedSkills.shift() as string;
      const body = loadSkillFn(next);
      if (body !== null) {
        skillLoaded = next;
        skillsLoaded.push(next);
        routeKind = routeKindFromSkill(next);
        systemPrompt = body;
        placeCandidates = [];
        similarFactCount = null;
        existingFacts = [];
        toolResultsThisTurn.length = 0;
        continuationsSeen.clear();
        forcingProposalNow = false;
        silentLegAfterProposal = false;
        answeredTheUser = false;
        proposedSomething = false;
        reply = '';
        formatErrorNote = null;
        terminalReason = 'settled';
        maxLegsThisTurn = nextLegIndex + SEGMENT_LEGS - formatRetries;
        continue segments;
      }
    }
    break;
  }

  // ---- ONE ANSWER FOR SEVERAL SEGMENTS ---------------------------------
  // Each segment's reply in order, the one whose question is waiting LAST,
  // so the bubble ends on the question its chips answer.
  if (segmentReplies.length > 0) {
    segmentReplies.push({ text: reply, asked: terminalReason === 'awaiting-user' });
    segmentTerminals.push(terminalReason);
    if (terminalReason === 'awaiting-user') askingSkill = skillLoaded;
    reply = [
      ...segmentReplies.filter((r) => !r.asked),
      ...segmentReplies.filter((r) => r.asked),
    ]
      .map((r) => r.text.trim())
      .filter((t) => t.length > 0)
      .join(' ');
    terminalReason = segmentTerminals.includes('awaiting-user')
      ? 'awaiting-user'
      : segmentTerminals.find((t) => t !== 'settled') ?? 'settled';
    proposedSomething = proposedAny;
    // The skill a chip tap must resume is the one that asked.
    if (askingSkill !== null) {
      skillLoaded = askingSkill;
      routeKind = routeKindFromSkill(askingSkill);
    }
  }

  /**
   * Origin and residence are no longer combined into one fact (owner ruling,
   * ux1 Q2). A persona that still holds a combined fact is offered its split
   * ONCE, on the first origin or residence turn, as an ordinary card: the
   * origin half replaces the combined fact, and the home half is added when
   * no home fact exists yet. Written by the loop, not asked of the model: the
   * combined shape is the loop's own old output, so splitting it is mechanical.
   */
  async function offerCombinedFactSplit(): Promise<string | null> {
    if (terminalReason === 'transport-error') return null;
    // Never while a question is waiting: the split card used to land under
    // "Which Porto did you mean?" before the move itself was settled (ux1 C1).
    // The resumed turn that answers the question offers it instead.
    if (terminalReason === 'awaiting-user' || turn.pendingChoice !== null) return null;
    const kinds = skillsLoaded.map((id) => routeKindFromSkill(id));
    if (!kinds.includes('origin') && !kinds.includes('residence')) return null;
    const combined = combinedFactOnFile;
    if (!combined) return null;
    const parts = threeFactsOf(combined.statement);
    if (!parts) return null;
    // The skill's own origin card already replaces it (see the save handler).
    const originDone = proposals.some((p) => p.replaces === combined.id);
    if (!originDone && deps.combinedFactRewrite && (await deps.combinedFactRewrite.wasOffered(combined.id))) {
      return null;
    }
    const topicSkill = (kind: string) =>
      (deps.skillIds() as readonly string[]).includes(`topics/${kind}`) ? `topics/${kind}` : undefined;
    const hasHome =
      state.persona.facts.some((f) => f.id !== combined.id && isLocationKey(f.attribute))
      || proposals.some((p) => p.kind === 'residence');
    const hasExpat =
      state.persona.facts.some((f) => f.attribute === EXPAT_KEY || isExpatStatement(f.statement))
      || proposals.some((p) => isExpatStatement(p.statement));
    const candidates: Record<string, unknown>[] = [];
    if (!originDone) {
      candidates.push({
        statement: parts.origin,
        questionnaire_attribute: ORIGIN_KEY,
        replaces: combined.id,
        ...(topicSkill('origin') ? { topic_skill_id: topicSkill('origin') } : {}),
      });
    }
    if (parts.expat && !hasExpat) {
      candidates.push({
        statement: parts.expat,
        questionnaire_attribute: EXPAT_KEY,
        ...(topicSkill('origin') ? { topic_skill_id: topicSkill('origin') } : {}),
      });
    }
    if (!hasHome) {
      candidates.push({
        statement: parts.residence,
        questionnaire_attribute: CANONICAL_LOCATION_KEY,
        ...(topicSkill('residence') ? { topic_skill_id: topicSkill('residence') } : {}),
      });
    }
    // Same duplicate rules as any other offer: never a statement already on
    // file or already offered this turn.
    const entries = candidates.filter((e) => {
      const statement = String(e.statement);
      return (
        !existingStatements.has(comparableStatement(statement))
        && !proposedStatements.has(statement.trim().toLowerCase())
      );
    });
    if (entries.length === 0) {
      if (originDone) await deps.combinedFactRewrite?.markOffered(combined.id);
      return originDone ? combined.id : null;
    }
    const splitProposals: AgentProposal[] = entries.map((e) => ({
      statement: String(e.statement),
      kind: e.questionnaire_attribute === CANONICAL_LOCATION_KEY ? 'residence' : 'origin',
      place: null,
      replaces: typeof e.replaces === 'string' ? e.replaces : null,
    }));
    const out = await deps.tools.saveExtractedFacts({
      extracted_user_information: entries,
      proposals: splitProposals,
    });
    const callRaw = JSON.stringify({ extracted_user_information: entries });
    const leg: AgentLeg = {
      index: legs.length,
      role: 'tool',
      systemPrompt: '',
      messages: [],
      toolCalls: [{ name: 'saveExtractedFacts', argumentsRaw: callRaw }],
      toolResults: [{ name: 'saveExtractedFacts', result: out }],
      rawOutput: '',
      result: {
        content: '',
        toolCalls: [{ name: 'saveExtractedFacts', argumentsRaw: callRaw }],
        finishReason: 'synthetic',
        truncated: false,
        usage: null,
        modelSent: null,
        latencyMs: 0,
        error: null,
      },
      inputTokens: 0,
      synthetic: true,
    };
    legs.push(leg);
    proposals.push(...splitProposals);
    for (const p of splitProposals) {
      proposedStatements.add(p.statement.toLowerCase());
      offeredThisTurn.push(p.statement.toLowerCase());
    }
    proposedSomething = true;
    await deps.combinedFactRewrite?.markOffered(combined.id);
    params.onLeg?.(leg);
    return combined.id;
  }

  if (unknownTools.length > 0 && terminalReason === 'settled') {
    terminalReason = 'unknown-tool';
  }

  // ---- THE BACKSTOP ---------------------------------------------------
  // The gate above sits just before the settle `break`, so it sees the reply
  // on exactly ONE of the loop's exits. Every other terminal — leg-cap,
  // no-route, no-proposal, unknown-tool, malformed-choice, awaiting-user —
  // leaves the loop by its own `break` and returned whatever prose the last
  // leg happened to produce, unchecked.
  //
  // That is not theoretical. Reported from TestFlight: a turn answered with an
  // invented copy of its own system prompt, several hundred words of "You are
  // a skilled assistant... Strict Rules... call saveExtractedFacts with an
  // empty array", rendered as a chat bubble. `leaksInternals` matches that
  // text twice over, on `saveExtractedFacts` and on "the user"; it simply
  // never ran, because the turn did not settle.
  //
  // Deterministic and terminal: the loop is over, so there is no leg left to
  // re-ask with, and for a leak replacement was already the policy when a
  // re-ask failed. A save claim is left alone here for the same reason it is
  // left alone above.
  if (leaksInternals(cleanProse(reply))) {
    reply = proposedSomething ? '' : REPLY_LEAK_FALLBACK;
    replyLeakUnfixed = true;
  } else if (narratesProcess(cleanProse(reply))) {
    // Same placement rule as the leak check: every exit, not just the settle
    // break. A card on screen needs no words; otherwise one plain line.
    reply = proposedSomething ? '' : REPLY_PROCESS_FALLBACK;
    replyProcessUnfixed = true;
  }
  // The acknowledgement is rendered too, so it gets the same two checks. It is
  // dropped rather than replaced: the reply below it carries the turn.
  if (leaksInternals(acknowledgement) || narratesProcess(acknowledgement)) {
    acknowledgement = '';
  }

  // ---- THE ONE-TIME SPLIT OF A COMBINED FACT -------------------------------
  const combinedRewriteOffered = await offerCombinedFactSplit();

  turn.turnActive = false;
  turn.offeredStatements = resumedSkill
    ? [...new Set([...turn.offeredStatements, ...offeredThisTurn])]
    : offeredThisTurn;
  turn.lastTurnAskedQuestion = turn.pendingChoice !== null || /\?\s*$/.test(reply);
  // The chip question wins over the prose one: when both exist the chips are
  // what is on screen, so they are what the next message answers.
  turn.lastQuestion = turn.pendingChoice
    ? turn.pendingChoice.question
    : trailingQuestion(cleanProse(reply));
  turn.lastRoute = routeKind;
  turn.lastSkill = skillLoaded;
  // Held for the turn that answers, which arrives carrying only a chip label.
  turn.lastUserMessage = userMessage;
  // CONSUMED. `resolvedChoice` was set and never cleared, so it stayed true for
  // the rest of the conversation and everything gated on it silently widened
  // from "the user confirmed this turn" to "the user has confirmed something,
  // once, at some point".
  //
  // That is almost certainly the TestFlight replace: the destructive `replaces`
  // gate reads it, so after any single chip tap every later turn was free to
  // offer a replacement. It also made the skill resume fire on every subsequent
  // turn, which is how "I am interested in music festivals" routed to
  // `facts/profession` on the simulator.
  //
  // Cleared HERE, at the end of the turn that consumed it, rather than where it
  // is read: the read sites are the resume, the state line, the `replaces` gate
  // and the delete gate, and one of them forgetting would put the bug straight
  // back.
  turn.resolvedChoice = null;

  return {
    legs,
    // Deterministic dash removal. Invariant 7 is unenforceable on model output
    // by prompt alone: 25% of measured prose rows carried one despite the ban.
    reply: cleanProse(reply),
    acknowledgement,
    processRetries,
    replyProcessUnfixed,
    typedYesResume,
    combinedRewriteOffered,
    terminalReason,
    unknownTools,
    // The PRIMARY route, so routing accuracy scores what the route leg chose
    // first; `skillsLoaded` carries the rest.
    routeKind: skillsLoaded.length > 0 ? routeKindFromSkill(skillsLoaded[0]) : routeKind,
    skillLoaded: skillsLoaded[0] ?? skillLoaded,
    skillsLoaded: [...skillsLoaded],
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
    refusedReplaces,
    resumedSkill,
    state: turn,
  };
}
