// mera-harness/eval — the tool contract, RE-EXPORTED from core.
//
// This file used to declare its own copy of every shape while
// lib/mera-harness/core did not exist yet, and its header promised to collapse
// into a re-export the moment it did. It has, so it did.
//
// WHY A RE-EXPORT AND NOT A SECOND DECLARATION. Three plans once carried three
// spellings of the same result field, which is the divergence review round 1
// caught (B1). A mirrored type is that bug with extra steps: it typechecks
// against itself, drifts silently, and only fails when a real call disagrees
// with it at run time. core/types.ts is the contract; the eval consumes it.
//
// TWO HARD RULES FOR EVERYTHING UNDER lib/mera-harness/eval:
//
//  1. NO NODE BUILTINS in non-test source. `lib/` is inside the app's tsconfig
//     include (only `harness-local` and `eval/` at the repo root are
//     excluded) and that config sets no `types`, so `node:fs` would not
//     typecheck. Reading fixtures and hashing prompts belong to the CLI.
//  2. NO NETWORK, NO REACT, AND NEVER AN IMPORT FROM harness-local. The
//     dependency runs one way; __tests__/boundary.test.ts enforces it.

export type {
  AgentChoiceOption,
  AgentDeps,
  AgentLeg,
  AgentModelRequest,
  AgentModelResult,
  AgentProposal,
  AgentToolPort,
  AgentTurnResult,
  AgentTurnState,
  AskChoiceResult,
  Bloc,
  FindSimilarFactsResult,
  LoadSkillResult,
  LookupPlaceResult,
  Place,
  SimilarFactCandidate,
} from '../core/types';

export { createAgentTurnState } from '../core/types';

export {
  ASK_CHOICE_TOOL,
  CONTINUATION_TOOLS,
  FIND_SIMILAR_FACTS_TOOL,
  HARNESS_TOOLS,
  LOAD_SKILL_TOOL,
  LOOKUP_PLACE_TOOL,
  MAX_CHOICE_OPTIONS,
  MIN_CHOICE_OPTIONS,
  validateChoiceOptions,
} from '../core/tool-contracts';

/**
 * The fact kinds the topic guidelines are keyed on.
 *
 * EVAL-ONLY, and deliberately so: core keys its skills by id
 * (`topics/residence`), while the eval corpus keys a FACT by kind to pick the
 * guideline it should have selected. Deriving one from the other here would
 * mean the eval asserting a mapping it also owns, which is a tautology rather
 * than a check.
 */
export const FACT_KINDS = ['residence', 'origin', 'profession', 'family', 'interest', 'generic'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** The topic skill a fact kind should select. Asserted against the id the
 *  agent actually loaded, never used to produce it. */
export function expectedTopicSkillFor(kind: FactKind): string {
  return `topics/${kind}`;
}

/**
 * The route kind the core derives from a loaded skill id.
 *
 * MIRRORS `routeKindFromSkill` in core/core.ts, which is module-private. Kept
 * in step with it by `contract.test.ts`, which drives the real loop and
 * compares. The rule: the LEAF of the id, with `generic` and an id carrying no
 * slash both meaning "no kind".
 *
 * A fixture says `"none"` where the core returns null, because a JSON fixture
 * cannot carry the distinction between absent and null usefully and a silent
 * mismatch there would score every generic turn as wrong.
 */
export const NO_ROUTE_KIND = 'none';

export function routeKindForSkill(skillId: string): string {
  const slash = skillId.indexOf('/');
  if (slash === -1) return NO_ROUTE_KIND;
  const leaf = skillId.slice(slash + 1);
  return leaf && leaf !== 'generic' ? leaf : NO_ROUTE_KIND;
}

/** Every route kind a fixture may name, derived from the skill library rather
 *  than listed: a hand-written list drifts the moment a subject is added. */
export function routeKindsFor(skillIds: readonly string[]): string[] {
  return [...new Set(skillIds.map(routeKindForSkill))];
}
