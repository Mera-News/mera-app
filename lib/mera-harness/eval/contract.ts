// mera-harness/eval — the frozen tool wire contract, mirroring P1 §16.
//
// WHY THIS FILE EXISTS AT ALL, AND WHEN IT DIES. Three plans once carried three
// spellings of the same result field, which is the divergence review round 1
// (B1) caught. So the contract lives in ONE place. Until
// lib/persona-agent/core.ts lands, that place is here; the moment it does,
// every type below is replaced by a direct import from it and this file keeps
// only the parts the agent core does not export. `contract.test` pins the
// shapes key for key so the swap is mechanical rather than hopeful.
//
// TWO HARD RULES FOR EVERYTHING UNDER lib/mera-harness/eval:
//
//  1. NO NODE BUILTINS. `lib/` is inside the app's tsconfig `include` (only
//     `harness-local` and `eval` are excluded), and that tsconfig sets no
//     `types`, so `node:fs` / `node:crypto` do not typecheck here. Reading
//     fixtures and hashing prompts belong to the harness-local CLI. Verified,
//     not assumed: tsconfig.json exclude is ["harness-local","eval","node_modules"].
//  2. NO NETWORK, NO REACT, AND NEVER AN IMPORT FROM harness-local. The
//     dependency runs one way; P1 owns the boundary test that enforces it.

/** Closed vocabulary, P3's. Nullable on a resolved place. */
export type Bloc = 'EU' | 'EEA' | 'ASEAN' | 'AU' | 'MERCOSUR' | 'NAFTA' | 'NONE';

export type FactKind = 'residence' | 'origin' | 'profession' | 'family' | 'generic';

/** One candidate from `lookup_place`. `admin1` and `bloc` are NULLABLE: a
 *  short-chain place (a city-state, or a place whose admin1 the provider does
 *  not carry) is a real case and the fakes must be able to produce it. */
export interface ResolvedPlace {
  /** Optional, and substring-validated against the user's own words (S14):
   *  it is the one field the model may invent, and a fabricated neighbourhood
   *  anchors every future topic run. */
  neighbourhood?: string;
  locality: string;
  admin1: string | null;
  countryCode: string;
  countryName: string;
  bloc: Bloc | null;
}

export type LookupPlaceResult =
  | { status: 'resolved'; places: ResolvedPlace[] }
  | { status: 'no_match'; query: string }
  | { status: 'unavailable' }
  | { status: 'too_short'; minChars: number };

export interface SimilarFactCandidate {
  factId: string;
  statement: string;
  attribute: string;
  overlap: number;
}

/** ARGS carry NO statement and NO query (S2): the device already holds the
 *  user's raw message, so no persona text travels in cleartext. `kind` is the
 *  only argument and it is optional. A fake keyed on a query is therefore
 *  impossible to drive, which is why the fixtures key on (turnIndex, kind). */
export interface FindSimilarFactsArgs {
  kind?: FactKind;
}

export interface LookupPlaceArgs {
  query: string;
  countryHint?: string;
}

export interface AskChoiceArgs {
  question: string;
  options: string[];
}

export type AskChoiceResult =
  | { awaiting: 'user' }
  | { error: 'options must be 2 or 3' };

export type DeleteUserFactsResult =
  | { deleted: string[] }
  /** S9: never fired directly. The model confirms with ask_choice first. */
  | { error: 'confirm with ask_choice first' };

export interface PlaceChain {
  neighbourhood?: string;
  locality: string;
  admin1: string | null;
  countryCode: string;
  countryName: string;
  bloc: Bloc | null;
}

/** Every device-backed tool. The eval supplies fakes; the app supplies the real
 *  thing. Shapes are P1 §16 and nothing here may drift from it. */
export interface AgentToolPort {
  find_similar_facts(args: FindSimilarFactsArgs): Promise<{ candidates: SimilarFactCandidate[] }>;
  lookup_place(args: LookupPlaceArgs): Promise<LookupPlaceResult>;
  ask_choice(args: AskChoiceArgs): Promise<AskChoiceResult>;
  deleteUserFacts(args: { fact_ids: string[] }): Promise<DeleteUserFactsResult>;
  saveExtractedFacts(args: Record<string, unknown>): Promise<{
    accepted: string[];
    rejected: { statement: string; reason: string }[];
  }>;
}

export const TOOL_NAMES = [
  'load_skill',
  'find_similar_facts',
  'lookup_place',
  'ask_choice',
  'saveExtractedFacts',
  'deleteUserFacts',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** `ask_choice` is deliberately NOT here: it terminates the turn. */
export const CONTINUATION_TOOLS: readonly ToolName[] = [
  'load_skill',
  'find_similar_facts',
  'lookup_place',
];

export const MAX_AGENT_LEGS = 4;
export const MAX_TOPICS_PER_FACT = 12;
