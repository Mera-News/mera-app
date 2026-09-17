// Tool call -> human label, and error -> consequence. Pure: no React, no RN, no
// stores, so the whole mapping is unit-testable without a renderer.
//
// Two rules this module exists to enforce, both of which failed review once:
//
//  1. A SKILL ID IS NEVER RENDERED. `load_skill` carries `id` (e.g.
//     "facts/residence"); a reader must see "where you live". The id->phrase map
//     is deliberately paired with a generic fallback, so a skill added later and
//     never mapped degrades to a sentence rather than leaking a path.
//  2. AN ERROR IS NEVER RENDERED. A failed step shows what the failure COST
//     ("Mera used what it already knew"), never a provider string — the app has
//     already shipped an English provider error to users in every locale once.

import type { AgentStep, AgentStepStatus } from './types';

// TOOL NAMES are string literals here on purpose, for now. P1's tool-name
// constants land at '@/lib/mera-harness', which today contains only `skills/`
// and exports no index. The two maps below are the single place they appear, so
// repointing is one import and two object keys — deliberately NOT scattered
// through the deriver or the component.

/** Longest argument value we will interpolate into a label. */
export const MAX_LABEL_ARG = 48;

/** Tool argument fields, verified against P1's tool contract. `load_skill`
 *  takes `id` and `lookup_place` takes `query` — NOT `skill`/`name`/`place`,
 *  which is what an earlier draft of this map assumed. */
const ARG_FIELD: Record<string, string> = {
  load_skill: 'id',
  lookup_place: 'query',
};

const LABEL_KEY: Record<string, string> = {
  load_skill: 'agentSteps.loadSkill',
  find_similar_facts: 'agentSteps.findSimilarFacts',
  lookup_place: 'agentSteps.lookupPlace',
  saveExtractedFacts: 'agentSteps.writeUp',
  deleteUserFacts: 'agentSteps.removing',
  ask_choice: 'agentSteps.asking',
};

/**
 * Skill id -> plain phrase key. An id absent here falls back to
 * `agentSteps.loadSkillGeneric`, which is what guarantees rule 1 holds for a
 * skill nobody remembered to map.
 */
const SKILL_PHRASE_KEY: Record<string, string> = {
  'facts/residence': 'skillPhrase.residence',
  'facts/work': 'skillPhrase.work',
  'facts/interests': 'skillPhrase.interests',
  'facts/origin': 'skillPhrase.origin',
  'facts/family': 'skillPhrase.family',
  'facts/new': 'skillPhrase.newFact',
  'topics/generate': 'skillPhrase.topics',
};

/** What a failed step cost. Keyed by tool; everything else gets the generic. */
const CONSEQUENCE_KEY: Record<string, string> = {
  lookup_place: 'agentSteps.consequence.lookupPlace',
  find_similar_facts: 'agentSteps.consequence.findSimilarFacts',
  load_skill: 'agentSteps.consequence.loadSkill',
  saveExtractedFacts: 'agentSteps.consequence.writeUp',
  deleteUserFacts: 'agentSteps.consequence.removing',
};

export const GENERIC_LABEL_KEY = 'agentSteps.working' as const;
export const GENERIC_CONSEQUENCE_KEY = 'agentSteps.consequence.generic' as const;
export const INTERRUPTED_CONSEQUENCE_KEY = 'agentSteps.consequence.interrupted' as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Trim and cap one argument value. Returns '' when there is nothing usable. */
export function labelArg(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > MAX_LABEL_ARG ? trimmed.slice(0, MAX_LABEL_ARG) : trimmed;
}

export interface ResolvedLabel {
  labelKey: string;
  labelValues?: Record<string, string>;
}

/** One tool call -> the key (and interpolation values) its row renders with. */
export function labelForToolCall(toolName: string, input: unknown): ResolvedLabel {
  const key = LABEL_KEY[toolName];
  if (!key) return { labelKey: GENERIC_LABEL_KEY };

  const field = ARG_FIELD[toolName];
  if (!field) return { labelKey: key };

  const raw = labelArg(asRecord(input)?.[field]);

  if (toolName === 'load_skill') {
    // The id itself must never reach the screen — only a phrase key does.
    const phrase = raw ? SKILL_PHRASE_KEY[raw] : undefined;
    return phrase
      ? { labelKey: key, labelValues: { topicKey: phrase } }
      : { labelKey: 'agentSteps.loadSkillGeneric' };
  }

  // lookup_place: the place word is the user's own and is shown as-is.
  return raw ? { labelKey: key, labelValues: { query: raw } } : { labelKey: GENERIC_LABEL_KEY };
}

/** What to say under an errored row. Always a key, never an error string. */
export function consequenceKeyFor(toolName: string | undefined, interrupted: boolean): string {
  if (interrupted) return INTERRUPTED_CONSEQUENCE_KEY;
  if (toolName && CONSEQUENCE_KEY[toolName]) return CONSEQUENCE_KEY[toolName];
  return GENERIC_CONSEQUENCE_KEY;
}

export interface ToolCallLike {
  name: string;
  input: unknown;
  status: AgentStepStatus;
}

/**
 * Build the tool rows for one assistant message.
 *
 * `interrupted` forces every still-pending row to `error` with the interrupted
 * consequence — the turn is over and nothing will settle these, so leaving them
 * pending is what produced a spinner that never stopped.
 */
export function stepsForMessage(
  messageId: string,
  toolCalls: ToolCallLike[] | undefined,
  interrupted: boolean,
): AgentStep[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  return toolCalls.map((tc, idx) => {
    const stranded = interrupted && tc.status === 'pending';
    const status: AgentStepStatus = stranded ? 'error' : tc.status;
    const { labelKey, labelValues } = labelForToolCall(tc.name, tc.input);
    const step: AgentStep = {
      id: `${messageId}::${idx}`,
      kind: 'tool',
      toolName: tc.name,
      labelKey,
      status,
    };
    if (labelValues) step.labelValues = labelValues;
    if (status === 'error') step.consequenceKey = consequenceKeyFor(tc.name, stranded);
    return step;
  });
}

/** The row that opens a leg, so the thread is never silent while Mera thinks. */
export function legStartStep(messageId: string, settled: boolean): AgentStep {
  return {
    id: `${messageId}::leg`,
    kind: 'leg-start',
    labelKey: 'agentSteps.legStart',
    status: settled ? 'done' : 'pending',
  };
}

/** Tools whose turn wrote, or staged, persona data. Drives whether the settled
 *  line survives in scroll-back: a pure-read turn leaves no line behind.
 *  `saveExtractedFacts` counts even though it only STAGES — the turn produced a
 *  card the user must still act on, and the box is the record of how it got
 *  there. This means "touched the persona pipeline", not "wrote a row". */
export const MUTATING_TOOLS = new Set(['saveExtractedFacts', 'deleteUserFacts']);

export function changedDataFrom(steps: AgentStep[]): boolean {
  return steps.some((s) => s.toolName !== undefined && MUTATING_TOOLS.has(s.toolName));
}
