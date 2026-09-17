// mera-harness/eval — the eval loop's own types and its two ports.
//
// THE WHOLE POINT OF THE PORTS. This module is pure: no network, no fs, no
// clock it does not own. The NEAR caller, the staging rail and the JSONL writer
// live in harness-local and are injected. That is what lets the same eval loop
// run under a CLI, under jest, or against a fake model with zero calls, and it
// is why `runAgentCorpus` can be dry-run to completion for free.

import type { FactKind, LookupPlaceResult, SimilarFactCandidate } from './contract';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface EvalModelRequest {
  role: 'route' | 'tool' | 'reply' | 'topicgen';
  model: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  /** Thinking is OFF on every call the agent makes, topic generation included:
   *  measured in this tree, thinking ON returned empty content on 8 of 10 probe
   *  runs because the trace ate the whole budget. Recorded on the row as
   *  `thinkingRequested` so an unhonoured switch is visible — NEAR answers 200
   *  for unknown chat_template_kwargs, so nothing else would say so. */
  enableThinking?: boolean;
  /** Object, not a bare string (P1 §16). `ttVisibleMs` keys on the first
   *  CONTENT delta; a reasoning-only delta is not prose and must not start the
   *  clock. */
  onDelta?: (d: { content?: string; reasoning?: string }) => void;
}

export interface EvalModelResult {
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
  /** Time to the first CONTENT delta. Null for a leg that emitted no prose —
   *  a tool-call-only leg has none, and averaging those in as zero is the same
   *  error as rating a punctuation rule over rows that have no prose. */
  ttVisibleMs: number | null;
  error: string | null;
}

/** Injected. The eval never constructs a transport.
 *
 *  ERRORS DIVIDE IN TWO AND THE SPLIT IS LOAD-BEARING. A transport failure is
 *  RETURNED (`result.error` set) and ends the TURN. Anything THROWN is a
 *  run-ending condition the caller raised — the provider's 402 spend limit is
 *  one — and the loop must let it out untouched, or a run records the same
 *  refusal as leg data across every remaining script and reads as the model
 *  failing. Catch what you raise, rethrow what you did not. */
export type ModelCaller = (req: EvalModelRequest) => Promise<EvalModelResult>;

/** Injected. One call per leg, in order. The harness-local adapter enriches
 *  each row with run id, cost and catalogue data before writing JSONL; none of
 *  that belongs in here. */
export type RowSink = (row: EvalRow) => void;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type EvalCallType = 'agent-route' | 'agent-tool' | 'agent-reply' | 'agent-topicgen';

export type TurnEnd = 'settled' | 'awaiting_user' | 'transport_error' | 'leg_cap';

export interface EvalRow {
  scriptId: string;
  cohort: string;
  turnIndex: number;
  /** Which model leg inside one user turn. 0 is the router leg. A topic-gen
   *  call is terminal and outside the leg budget, so it carries the next index
   *  after the last leg rather than pretending to be one. */
  legIndex: number;
  repeat: number;
  arm: string;
  variant: string;
  callType: EvalCallType;
  /** The work unit every arm shares. THE TURN, never the leg: leg counts are
   *  ragged across repeats and the one-shot control arm has no leg above 0, so
   *  a leg-level group would mark every high leg non-interleaved and empty the
   *  latency columns. */
  interleaveGroup: string;
  /** True only for turn 0 leg 0. Every other leg carries prior tool results or
   *  prior saved facts, so its repeats diverge by design and a runner that
   *  demanded one prompt hash per cell would fail every live run. */
  promptDeterministic: boolean;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  toolSchemaNames: string[];
  rawOutput: string;
  toolCalls: EvalToolCall[];
  /** Absolute marks. Time-to-first-prose spans legs and cannot be rebuilt from
   *  per-leg durations once a tool call runs between them. */
  turnStartedAtMs: number;
  legStartedAtMs: number;
  latencyMs: number;
  ttVisibleMs: number | null;
  /** What the REQUEST asked for. Never chosen here; the agent core owns the
   *  gear and this only records it. */
  thinkingRequested: boolean | null;
  inputTokens: number | null;
  usage: EvalModelResult['usage'];
  finishReason: string;
  truncated: boolean;
  error: string | null;
  modelRequested: string;
  modelSent: string | null;
  /** Set on the last leg of a turn; null on every earlier leg. */
  endedOn: TurnEnd | null;
  awaitingUser: boolean;
  /** Topic-gen rows only: the fact this call served, and the kind that selected
   *  its guideline. `items` mirrors the shape run-topicgen-corpus already uses,
   *  so a downstream join is by key rather than by parsing titles back out. */
  items: { id: string }[] | null;
  factKind: FactKind | null;
  topics: string[] | null;
  /** Why topics were dropped before they reached the set. Without these, "done
   *  with zero topics" is an unfalsifiable user report. */
  dropped: { veto: number; filter: number } | null;
}

export interface EvalToolCall {
  name: string;
  argumentsRaw: string;
  parsed: Record<string, unknown> | null;
  /** Parsed cleanly AND satisfies the tool's required properties. Split from
   *  `parsed === null` so a malformed-JSON call and a schema-violating call are
   *  different findings rather than one blurred rate. */
  schemaValid: boolean;
  /** A name outside TOOL_NAMES: the model invented a tool. Distinct again,
   *  because inventing a tool is not the same failure as misusing a real one. */
  unknownTool: boolean;
  /** What the fake answered, so a rater or a re-read never has to consult the
   *  fixture to know what the model was told. */
  result: unknown;
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

export interface ScriptExpect {
  routeKind: string;
  /** A SKILL ID, written out per turn, never derived from the route kind: five
   *  intents map onto thirteen ids, `chat` collapses into
   *  conversation/question and `fact_update` splits between facts/<subject> and
   *  conversation/correction. Validated at load against the ids the agent core
   *  actually exports. */
  skill: string;
  tools: string[];
  /** EXACT leg count, not a ceiling. The normal residence turn is 3 legs, so a
   *  leg-cap hit there is a planted failure and the metric counts it as one;
   *  writing a ceiling would have made it invisible on the one fixture whose
   *  leg count is known. */
  legs: number;
  /** Defaults to 'settled'. A transport failure ends the turn, so a failure
   *  fixture expects FEWER legs and ending early there is correct. */
  endedOn?: TurnEnd;
  proposals?: ExpectedProposal[];
}

export interface ExpectedProposal {
  /** Lowercase substrings, ALL of which must appear. Never a full-phrase
   *  equality: the model's wording is not what is under test. */
  statementMatches: string[];
  kind: string | null;
  placeChain: 'required' | 'forbidden' | null;
  replaces: string | null;
}

export interface FakeLookupPlaceAnswer {
  query: string;
  returns: LookupPlaceResult;
}

export interface FakeSimilarFactsAnswer {
  /** Keyed on (turnIndex, kind) because the tool takes NO query and NO
   *  statement (S2). A fixture carrying a query is a load error, so the
   *  privacy removal cannot silently regress back in. */
  kind: FactKind | null;
  returns: { candidates: SimilarFactCandidate[] };
}

export interface ScriptTurn {
  index: number;
  /** Free text, or absent when this is a choice reply. */
  user?: string;
  /** A choice reply. Must equal one of the options the PREVIOUS turn offered;
   *  a mismatch is counted, never followed, so every arm keeps answering the
   *  same question and stays comparable. */
  chooses?: string;
  expect: ScriptExpect;
  fakeTools?: {
    lookup_place?: FakeLookupPlaceAnswer[];
    find_similar_facts?: FakeSimilarFactsAnswer[];
  };
}

export interface AgentScript {
  id: string;
  cohort: string;
  note?: string;
  /** Starting facts and topics. Referenced from the existing persona-corpus
   *  fixtures where they fit, so there is one copy of each persona. */
  persona: ScriptPersona;
  declinedTopics: string[];
  turns: ScriptTurn[];
}

export interface ScriptPersona {
  facts: {
    id: string;
    statement: string;
    questionnaireAttribute: string;
    kind?: FactKind;
    placeChain?: import('./contract').PlaceChain;
  }[];
  topics: { id: string; text: string }[];
}

// ---------------------------------------------------------------------------
// Topic expectations (P5's file)
// ---------------------------------------------------------------------------

export interface TopicExpectationCase {
  id: string;
  /** AND over lowercase substrings: EVERY term must appear in the fact. Cases
   *  are mutually exclusive, enforced statically at load and again at match
   *  time, so a composed origin-plus-residence fact is never scored against
   *  two ladders. */
  factMatches: string[];
  countRange: [number, number] | null;
  /** PER CASE, and rung names differ between cases (neighbourhood/city/... for
   *  a residence, origin/host/diaspora for an origin, a single `exact` for a
   *  family relative). A pooled rung percentage across cases would sum
   *  different denominators, so the block prints per case. */
  ladder: Record<string, string[]>;
  /** AT-LEAST-ONE. Null means the case does not test it; only the profession
   *  cases do. */
  fieldGeneric: string[] | null;
  /** PRESENCE per pair only. No rate, no cap, no ratio. */
  crossProducts: { a: string[]; b: string[] }[];
  mustNotContain: string[];
}

export interface TopicExpectations {
  version: number;
  cases: TopicExpectationCase[];
}

/** One fact backing one expectation case. The expectations file selects by
 *  factMatches, so a case with no fact behind it scores nothing at all. */
export interface TopicFact {
  caseId: string;
  id: string;
  statement: string;
  questionnaireAttribute: string;
  kind: FactKind;
  placeChain?: import('./contract').PlaceChain;
}
