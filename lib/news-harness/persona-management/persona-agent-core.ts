// news-harness — persona-agent-core: pure system-prompt / context / tool-
// definition construction for the persona-update chat agent (onboarding +
// persona-config surfaces).
//
// Extracted from lib/llm/agents/PersonaUpdateAgent.ts so the RN class is a
// thin shell over store/DB reads that delegates all prompt-construction
// "brain" work here. RN-free: no lib/database, lib/stores, expo,
// react-native, lib/logger, or lib/config/endpoints imports.
//
// Seam note: the prompt-string builders (buildPersonaUpdateStaticPrompt,
// buildPersonaUpdateContext, buildToolDefinitions) and the questionnaire
// helpers (buildQuestionnaireGuide, getAttributeKeysForLevel, TOTAL_LEVELS)
// are all accepted as INJECTABLE parameters, defaulting to this harness's own
// canonical imports. PersonaUpdateAgent.ts passes its own imports from the
// (test-mockable) lib/mera-protocol/prompts + lib/mera-protocol/questionnaire-
// data shims explicitly, so the frozen PersonaUpdateAgent.test.ts — which
// mocks those shim modules and asserts on the mock call args — keeps passing
// unmodified. Same pattern as
// lib/news-harness/persona-management/topic-generation.ts's `systemPrompts`
// injection and lib/mera-protocol/scoring-service.ts's mockable-seam notes.

import type { Fact, ToolDefinition } from '../core/types';
import {
  buildPersonaUpdateStaticPrompt,
  buildPersonaUpdateContext,
  buildToolDefinitions,
} from '../prompts/prompts';
import {
  buildQuestionnaireGuide,
  getAttributeKeysForLevel,
  TOTAL_LEVELS,
} from '../prompts/questionnaire-data';

export type PersonaSurface = 'ONBOARDING' | 'CONFIG';
export type PersonaMode = 'CLOUD' | 'LOCAL';

/** Caps facts injected into <context> to stay within the on-device 4096-token
 *  input budget. Mirrors PersonaUpdateAgent's original MAX_FACTS_IN_CONTEXT. */
export const MAX_FACTS_IN_CONTEXT = 22;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export interface PersonaSystemPromptInput {
  surface: PersonaSurface;
  /** When false, omits XML tool format instructions (AI SDK handles tool calling natively). */
  includeToolFormat: boolean;
  /** Human-readable name of the user's app language (e.g. "Hindi", "Spanish"). */
  languageName: string;
  /** Inference path — CLOUD (large MoE) vs LOCAL (on-device). */
  mode: PersonaMode;
  /** When true, uses the legacy level-based questionnaire with [ASK]/[DONE] annotations. */
  useLegacy: boolean;
}

export type BuildStaticPromptFn = typeof buildPersonaUpdateStaticPrompt;

/**
 * Builds the STATIC persona-update system prompt over plain inputs. Mirrors
 * PersonaUpdateAgent.buildSystemPrompt's params-object assembly exactly
 * (session-constant; safe to cache per session).
 */
export function buildPersonaSystemPrompt(
  input: PersonaSystemPromptInput,
  buildStaticPrompt: BuildStaticPromptFn = buildPersonaUpdateStaticPrompt,
): string {
  return buildStaticPrompt({
    surface: input.surface,
    includeToolFormat: input.includeToolFormat,
    languageName: input.languageName,
    mode: input.mode,
    useLegacy: input.useLegacy,
  });
}

// ---------------------------------------------------------------------------
// Known-facts formatting
// ---------------------------------------------------------------------------

// `questionnaireAttribute` is typed as `string | undefined` on Fact, but the
// WatermelonDB-backed getFacts() has been observed to hand back explicit
// `null` too — accept both so callers don't need to coerce first.
export type ContextFact = Pick<Fact, 'statement'> & {
  questionnaireAttribute?: Fact['questionnaireAttribute'] | null;
};

/**
 * Formats facts into the "- 'attr': statement" bullet list used in <context>,
 * capping to the most-recent MAX_FACTS_IN_CONTEXT entries. Pure — mirrors the
 * inline logic that used to live in PersonaUpdateAgent.buildContext.
 */
export function formatKnownFactsList(facts: ContextFact[]): string {
  const displayFacts =
    facts.length > MAX_FACTS_IN_CONTEXT ? facts.slice(-MAX_FACTS_IN_CONTEXT) : facts;

  if (displayFacts.length === 0) return 'Nothing yet.';

  return displayFacts
    .map((f) => `- '${f.questionnaireAttribute ?? 'other'}': ${f.statement}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Questionnaire level recomputation (legacy path)
// ---------------------------------------------------------------------------

export type GetAttributeKeysForLevelFn = typeof getAttributeKeysForLevel;

export interface RecomputeQuestionnaireLevelInput {
  /** Currently persisted level, before recomputation. */
  currentLevel: number;
  /** Attribute keys the user has already covered. */
  coveredAttributes: Set<string>;
}

/**
 * Recomputes the questionnaire level given coverage — pure port of the
 * decrement/increment while-loops previously inline in
 * PersonaUpdateAgent.buildContext's legacy branch. The caller (RN class) owns
 * persisting the result via setQuestionnaireLevel.
 *
 * `getKeysForLevel` and `totalLevels` are injectable (default to this
 * harness's own questionnaire-data) so callers that inject the app's
 * (test-mockable) questionnaire-data shim observe the overridden behavior.
 */
export function recomputeQuestionnaireLevel(
  input: RecomputeQuestionnaireLevelInput,
  getKeysForLevel: GetAttributeKeysForLevelFn = getAttributeKeysForLevel,
  totalLevels: number = TOTAL_LEVELS,
): number {
  let { currentLevel } = input;
  const { coveredAttributes } = input;

  while (currentLevel > 1) {
    const prevLevelKeys = getKeysForLevel(currentLevel - 1);
    const allPrevCovered =
      prevLevelKeys.length > 0 && prevLevelKeys.every((key) => coveredAttributes.has(key));
    if (allPrevCovered) break;
    currentLevel--;
  }
  while (currentLevel < totalLevels) {
    const levelKeys = getKeysForLevel(currentLevel);
    if (levelKeys.length === 0) break;
    const allCovered = levelKeys.every((key) => coveredAttributes.has(key));
    if (!allCovered) break;
    currentLevel++;
  }
  return currentLevel;
}

// ---------------------------------------------------------------------------
// Dynamic <context> block
// ---------------------------------------------------------------------------

export interface PersonaContextInput {
  facts: ContextFact[];
  useLegacy: boolean;
  /** Legacy-only: the already-recomputed level (see recomputeQuestionnaireLevel) + coverage. */
  currentLevel?: number;
  coveredAttributes?: Set<string>;
}

export type BuildQuestionnaireGuideFn = typeof buildQuestionnaireGuide;
export type BuildContextFn = typeof buildPersonaUpdateContext;

export interface PersonaContextDeps {
  buildContext?: BuildContextFn;
  buildGuide?: BuildQuestionnaireGuideFn;
  totalLevels?: number;
}

/**
 * Builds the DYNAMIC <context> block injected into user messages. Mirrors
 * PersonaUpdateAgent.buildContext exactly: caps + formats the known-facts
 * list, and (legacy path) builds the questionnaire guide for the given
 * (already-recomputed) level.
 *
 * `deps` lets the caller inject its own (test-mockable) prompt/questionnaire
 * builders — defaults to this harness's own canonical implementations.
 */
export function buildPersonaContext(
  input: PersonaContextInput,
  deps: PersonaContextDeps = {},
): string {
  const buildContextFn = deps.buildContext ?? buildPersonaUpdateContext;
  const buildGuideFn = deps.buildGuide ?? buildQuestionnaireGuide;
  const totalLevels = deps.totalLevels ?? TOTAL_LEVELS;

  const knownFactsList = formatKnownFactsList(input.facts);

  if (!input.useLegacy) {
    return buildContextFn({ knownFactsList, useLegacy: false });
  }

  const coveredAttributes = input.coveredAttributes ?? new Set<string>();
  const currentLevel = input.currentLevel ?? 1;
  const questionnaireGuide = buildGuideFn(currentLevel, coveredAttributes);

  return buildContextFn({
    knownFactsList,
    useLegacy: true,
    questionnaireGuide,
    currentLevel,
    totalLevels,
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export type BuildToolDefinitionsFn = typeof buildToolDefinitions;

/** Tool definitions for the persona-update agent (OpenAI JSON Schema, cloud). */
export function getPersonaToolDefinitions(
  surface: PersonaSurface,
  useLegacy: boolean,
  buildDefs: BuildToolDefinitionsFn = buildToolDefinitions,
): ToolDefinition[] {
  return buildDefs(surface, useLegacy);
}
