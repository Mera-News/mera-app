// mera-harness/core — shared types. PURE: no imports at all, by design.
//
// Everything the harness exposes to the app and to the eval runner is declared
// here. Nothing in this folder may import react, react-native, expo,
// @/lib/database, @/lib/stores, @/lib/hooks, @/components or harness-local;
// __tests__/boundary.test.ts enforces that for the whole folder.

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

/**
 * The closed bloc vocabulary, and the TOP RUNG of a place chain as-is: the
 * residence skill does not translate or re-map it.
 *
 * DECLARED HERE, not in place-service, and the direction matters. The harness
 * must not import place-service (Apollo, RN), so a type owned there could never
 * be referenced from inside this folder. place-service imports `Bloc` from
 * '@/lib/mera-harness' and owns the countryCode -> Bloc map; nothing inside the
 * harness imports place-service. One declaration, one map, and the dependency
 * points the only way the boundary allows.
 */
export type Bloc =
  | 'EU'
  | 'EEA'
  | 'EFTA'
  | 'UK'
  | 'Europe'
  | 'Asia'
  | 'Africa'
  | 'North America'
  | 'South America'
  | 'Oceania'
  | 'Antarctica';

export interface Place {
  /**
   * From the USER'S OWN WORDS only, and validated as a normalised substring of
   * their turn before it is accepted. It is the one place field with no
   * GraphQL source, which makes it the one field the model can invent; an
   * unvalidated value is dropped rather than erroring, because the rest of the
   * chain is still good.
   */
  neighbourhood?: string;
  /**
   * The USER'S OWN NAME for this place when their words matched only one of
   * its alternate names: "Porto Santo" resolves to Vila Baleira. Kept first in
   * any statement ("Porto Santo (Vila Baleira), Madeira, ..."), or no topic
   * ever names the place the user actually said (ux2 D13).
   */
  userTerm?: string;
  locality: string;
  admin1: string | null;
  /** ISO alpha-2, GeoNames convention. */
  countryCode: string;
  countryName: string;
  /** Derived in code from countryCode, and RE-DERIVED on the way in rather than
   *  trusted: the model copies a Place it was given, and a copy-verbatim rule it
   *  breaks silently is not a guarantee. null only for an unknown code, and a
   *  null bloc DROPS the rung instead of guessing a continent. */
  bloc: Bloc | null;
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

export type LoadSkillResult =
  | { id: string; name: string; instructions: string }
  | { error: 'unknown skill id'; availableSkills: string[] };

export interface SimilarFactCandidate {
  factId: string;
  statement: string;
  attribute: string | null;
  overlap: number;
}

export type FindSimilarFactsResult = { candidates: SimilarFactCandidate[] };

export type LookupPlaceResult =
  | {
      status: 'resolved';
      places: Place[];
      /** The words of the query the match did NOT use ("niew west" when only
       *  "Amsterdam" resolved). The place service has no districts, so this is
       *  the only record of the finer area the user named (ux2 D1). */
      unmatched?: string;
    }
  | { status: 'no_match'; query: string }
  /** The lookup FAILED. Never means "no match" — collapsing the two shows a
   *  user an interrogation during a GraphQL outage. */
  | { status: 'unavailable' }
  | { status: 'too_short'; minChars: 2 };

/**
 * The place a saved fact carries, as copied back by the model and reconciled
 * against the candidates the port actually returned.
 *
 * An ALIAS of Place, deliberately, rather than a second shape: the chain the
 * model hands back must be one of the candidates it was given, so a distinct
 * type would only invite the two to drift.
 */
export type PlaceChain = Place;

/** NO statement and NO query: tool arguments sit outside the E2EE envelope and
 *  the device already holds the user's raw message. */
export interface FindSimilarFactsArgs {
  kind?: string;
  limit?: number;
}

export interface LookupPlaceArgs {
  query: string;
  countryHint?: string;
}

export type AskChoiceResult =
  | { awaiting: 'user' }
  | { error: 'options must be 2 or 3' };

// ---------------------------------------------------------------------------
// Turn state
// ---------------------------------------------------------------------------

/** One object per option — never parallel arrays of text and payload. */
export interface AgentChoiceOption {
  text: string;
  /** The STRUCTURED value this option stands for: a candidate Place, or a fact
   *  id for a replace confirmation. Without it the tap arrives as a bare display
   *  string and the next turn re-runs lookup_place on the same words. */
  payload: unknown;
}

export interface AgentTurnState {
  pendingChoice: { question: string; options: AgentChoiceOption[] } | null;

  /**
   * What the user actually TAPPED. The deleteUserFacts gate and the `replaces`
   * validation key off THIS, never off "a question was asked": a question can be
   * asked and ignored, typed past, or answered with something else entirely, and
   * treating "asked" as "confirmed" is how a destructive tool fires on a turn
   * nobody consented to.
   */
  resolvedChoice: { question: string; text: string; payload: unknown } | null;

  /**
   * True from turn start, and TRUE ACROSS EVERY LEG AND EVERY GAP BETWEEN LEGS
   * — device tool execution, and the forced-extraction pass. False ONLY at turn
   * end or transport failure.
   *
   * NEVER derive it from streaming state. `status` / `isStreaming` /
   * `isStreamingRef` go idle EARLY during the forced pass, because
   * startForcedExtraction dispatches with `void` and the pass outlives
   * startTurn's `finally` — which is exactly why `turnBusyRef` exists alongside
   * `isStreamingRef`. A turnActive derived from streaming state reads false
   * while real work is in flight, and the UI renders a live turn as interrupted.
   * Its lifetime mirrors turnBusyRef.
   */
  turnActive: boolean;

  /** Drives the no-two-consecutive-questions rule across a close-and-reopen. */
  lastTurnAskedQuestion: boolean;
  /**
   * The QUESTION ITSELF, not just that there was one.
   *
   * A boolean is enough to stop the agent asking twice and useless for reading
   * the answer. Measured on G3: "Mostly the older road bridges over the Douro"
   * followed "you work on bridge inspections. Is that correct?" and routed to
   * `facts/interest` instead of `facts/profession`; "Try P" followed "a sister
   * in Porto! Let me save that for you." Both are answers whose referent the
   * loop held and never sent, so the model was classifying a sentence fragment
   * with no subject. Slim context drops prior HISTORY, which is the ruling; it
   * was never meant to drop the question the user is answering.
   */
  lastQuestion: string | null;
  lastRoute: string | null;
  lastSkill: string | null;
  /** The user's message from the turn that asked the last question. A chip tap
   *  replaces the message with the chip's own text, so without this the skill
   *  resumes with the subject missing: "my parents live in bhopal" comes back
   *  as the bare place name and the family skill, seeing no relative, proposes
   *  the user's own residence. */
  lastUserMessage: string | null;
  /**
   * The place a chip tap resolved, carried across the turns that RESUME the
   * skill which asked. Without it a resumed residence turn looked the city up
   * again, found the same ambiguity and asked the same question a second time
   * (the audit's B2 took four confirmations for one move). Cleared on any turn
   * that is not a resume.
   */
  confirmedPlace: Place | null;
  /**
   * Statements offered on the previous turn, normalised. A resumed turn seeds
   * its duplicate filter with them, so a chip tap cannot re-offer a card that is
   * still sitting on screen unanswered.
   */
  offeredStatements: string[];
}

export function createAgentTurnState(): AgentTurnState {
  return {
    pendingChoice: null,
    resolvedChoice: null,
    turnActive: false,
    lastTurnAskedQuestion: false,
    lastQuestion: null,
    lastRoute: null,
    lastSkill: null,
    lastUserMessage: null,
    confirmedPlace: null,
    offeredStatements: [],
  };
}

// ---------------------------------------------------------------------------
// Model + tool ports
// ---------------------------------------------------------------------------

export interface AgentModelRequest {
  role: 'route' | 'tool' | 'reply' | 'topicgen';
  model: string;
  systemPrompt: string;
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[];
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  /** FALSE on every call this harness makes, topic generation included
   *  (measured: thinking on returned empty content 8 of 10). */
  enableThinking?: boolean;
  /** 'required' obliges at least one call from the payload. Used ONLY by the
   *  forced-proposal leg, where the payload is saveExtractedFacts alone. */
  toolChoice?: 'auto' | 'required';
  /** Kept available per request so re-enabling thinking on fact legs does not
   *  silently restore the length-truncation condition the degraded fallback
   *  already demonstrates. */
  reasoningHeadroomTokens?: number;
  /** The app forwards streamed deltas through this so the bubble still fills
   *  token by token and the thinking caption still fires; the eval omits it.
   *  Two fields, not one: `reasoning` carries NO payload upstream, it marks that
   *  a trace STARTED, which is the only signal the caption has. */
  onDelta?: (d: { content?: string; reasoning?: string }) => void;
  /**
   * True only for the leg whose text the user should watch arrive: the route
   * leg of a non-resumed turn (the acknowledgement). A driver that streams
   * through its OWN callback must honour this, not just `onDelta`: the app's
   * adapter used to stream every leg into the acknowledgement bubble, so the
   * question from a later leg was appended to it and then split off.
   */
  streamToUser?: boolean;
}

export interface AgentModelResult {
  content: string;
  toolCalls: { name: string; argumentsRaw: string }[];
  finishReason: string;
  truncated: boolean;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
  } | null;
  modelSent: string | null;
  latencyMs: number;
  ttVisibleMs?: number | null;
  error: string | null;
}

/** Every device-backed tool, as a port. The eval supplies fakes. */
export interface AgentToolPort {
  /**
   * NO statement and NO query argument: the device already holds the user's raw
   * message, so sending it would only put persona text into a cleartext tool
   * argument for nothing. `kind` is optional; absent searches all kinds.
   */
  findSimilarFacts(args: FindSimilarFactsArgs): Promise<FindSimilarFactsResult>;
  lookupPlace(args: LookupPlaceArgs): Promise<LookupPlaceResult>;
  saveExtractedFacts(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteUserFacts(args: { fact_ids: string[] }): Promise<Record<string, unknown>>;
}

export interface AgentDeps {
  callModel(req: AgentModelRequest): Promise<AgentModelResult>;
  tools: AgentToolPort;
  /** Returns the COMPOSED string for a leaf (group generic + leaf). */
  loadSkill(id: string): string | null;
  /** Existence, not content: loadSkill returning null cannot distinguish "that
   *  id does not exist" from "that id exists and its body is empty", and the
   *  eval fixture loader validates every expected id at load. */
  skillIds(): readonly string[];
  now?: () => number;
  /**
   * Remembers which combined "origin plus residence" facts were already
   * offered their one-time split, so a skipped offer is not repeated on every
   * later residence or origin turn. Optional: the eval omits it, and without it
   * the offer is made whenever it applies.
   */
  combinedFactRewrite?: {
    wasOffered(factId: string): boolean | Promise<boolean>;
    markOffered(factId: string): void | Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Legs and turn result
// ---------------------------------------------------------------------------

export interface AgentLeg {
  index: number;
  role: 'route' | 'tool' | 'reply';
  /** MATERIALISED, so the runner hashes what was actually sent rather than what
   *  a builder would rebuild. */
  systemPrompt: string;
  messages: { role: string; content: string }[];
  toolCalls: { name: string; argumentsRaw: string }[];
  toolResults: { name: string; result: unknown }[];
  rawOutput: string;
  result: AgentModelResult;
  /** Per-leg input count, so the budget table is measured rather than trusted. */
  inputTokens: number;
  /** A leg the LOOP wrote without a model call (the one-time split offer for
   *  a combined fact). Metrics that count model legs skip it. */
  synthetic?: boolean;
}

export interface AgentProposal {
  statement: string;
  kind: string | null;
  place: Place | null;
  replaces: string | null;
}

export interface AgentTurnResult {
  /** ALWAYS populated, including on an early exit or an error leg: a turn that
   *  dies on leg 2 must still hand back legs 0 and 1, or the failure is
   *  invisible in the rows. */
  legs: AgentLeg[];
  /**
   * The ANSWER: prose written once a skill was loaded. Never the route leg's
   * acknowledgement, which used to become the reply whenever the later legs
   * were silent ("I'll start by loading the appropriate skill for this turn."
   * shipped as a whole reply that way). May be empty: a turn whose only output
   * is a card or chips has nothing to add in words.
   */
  reply: string;
  /** The route leg's one-sentence acknowledgement, cleaned, or '' when it
   *  narrated the loop's own process or leaked internals. The app renders it as
   *  its own bubble above the reply. */
  acknowledgement: string;
  /** Final replies re-asked because they narrated the loop's process or
   *  promised a step the turn never took. Its own budget. */
  processRetries: number;
  /** A process narration that survived its re-ask and was dropped. */
  replyProcessUnfixed: boolean;
  /** The turn resumed the last skill because the user typed a plain yes to
   *  its question. Never a confirmation: `resolvedChoice` stays null. */
  typedYesResume: boolean;
  /** The combined fact id the loop offered to split this turn, if any. */
  combinedRewriteOffered: string | null;
  /** null when the decision did not parse. NEVER defaulted to a kind: a
   *  defaulted route scores as a correct route and inflates accuracy. */
  routeKind: string | null;
  skillLoaded: string | null;
  /** Every skill the turn ran, in order. Longer than one only under the
   *  multi-subject arm. */
  skillsLoaded: string[];
  proposals: AgentProposal[];
  /** True when the leg bound CLAMPED the loop. It clamps; it never throws. */
  legBudgetHit: boolean;
  /** WHY the turn ended. Counted, so a failure appears in the rows instead of
   *  looking like an ordinary settled turn that happened to do nothing. */
  terminalReason:
    | 'settled'
    | 'awaiting-user'
    | 'malformed-choice'
    | 'unknown-tool'
    | 'transport-error'
    | 'leg-cap'
    /** A fact skill ran, the forced leg ran, and still nothing was proposed. */
    | 'no-proposal'
    /** The route leg produced no `load_skill` call, and still none after its
     *  format-error retries. The turn ends VISIBLY rather than as a settled
     *  turn that silently did nothing, which is how 90 of 308 G2d route legs
     *  ended. */
    | 'no-route';
  /** Tool names the model invented, e.g. `add_fact`. Empty on a clean turn. */
  unknownTools: string[];
  /** Attempts to load a second skill after one was already loaded this turn.
   *  Every capped turn in the 312-turn corpus was one of these. */
  rerouteAttempts: number;
  /** A fact skill was loaded and the turn was about to settle having proposed
   *  nothing, so one forced leg ran. */
  forcedProposal: boolean;
  /** Route legs re-asked because they came back with no `load_skill` call.
   *  mini-swe-agent's FormatError, which is the mechanism this copies: the
   *  violation is named back to the model in a user message and the loop asks
   *  again rather than ending the turn. */
  formatRetries: number;
  /** FINAL replies re-asked because they failed the reply gate: a false claim
   *  that something was saved, or loop internals exposed in the bubble. Its own
   *  budget, never shared with `formatRetries`, because a turn that had to
   *  re-route must still be able to correct its reply. */
  replyRetries: number;
  /** A save claim that survived its correction. Kept on screen deliberately and
   *  counted, rather than rewritten: a slightly wrong word beside a visible
   *  card beats a mangled sentence. */
  replyClaimUnfixed: boolean;
  /** A leak that survived its correction. The reply IS replaced in this case,
   *  because showing a user the scaffolding is worse than a generic line. */
  replyLeakUnfixed: boolean;
  /** Proposals dropped because their statement repeated a fact already on
   *  file. The model was shown them by find_similar_facts. */
  reProposals: number;
  /** `replaces` targets refused because the proposed fact and the target are
   *  about different people. A destructive replace demoted to a plain add. */
  refusedReplaces: number;
  /** The turn RESUMED the skill that asked its question instead of routing
   *  the chip tap as a fresh intent. Reported so the continuation is
   *  measurable: an unmeasured one breaks silently, which is how the subject
   *  of a question got lost between two turns in the first place. */
  resumedSkill: boolean;
  /** Surfaced to the UI so a capped turn renders as capped, not as finished. */
  legCapped: boolean;
  state: AgentTurnState;
}
