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
  | { status: 'resolved'; places: Place[] }
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
  reply: string;
  /** null when the decision did not parse. NEVER defaulted to a kind: a
   *  defaulted route scores as a correct route and inflates accuracy. */
  routeKind: string | null;
  skillLoaded: string | null;
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
  /** Proposals dropped because their statement repeated a fact already on
   *  file. The model was shown them by find_similar_facts. */
  reProposals: number;
  /** Surfaced to the UI so a capped turn renders as capped, not as finished. */
  legCapped: boolean;
  state: AgentTurnState;
}
