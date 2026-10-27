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

import { stepKindForTool } from '@/lib/services/chat-phase';
import type { LiveTool } from '@/lib/llm/chat-phase-store';
import type { TFunction } from 'i18next';
import type { AgentStep, AgentStepStatus } from './types';

type TFn = TFunction;

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
  webSearch: 'chatPhases.webSearch',
  proposeChanges: 'agentSteps.proposeChanges',
  applyProposal: 'agentSteps.applyProposal',
  cancelProposal: 'agentSteps.cancelProposal',
  proposeTrack: 'agentSteps.proposeTrack',
  proposeFactCheck: 'agentSteps.proposeFactCheck',
  searchNews: 'agentSteps.searchNews',
};

/**
 * Skill id -> plain phrase key. An id absent here falls back to
 * `agentSteps.loadSkillGeneric`, which is what guarantees rule 1 holds for a
 * skill nobody remembered to map.
 */
const SKILL_PHRASE_KEY: Record<string, string> = {
  'facts/residence': 'skillPhrase.residence',
  'facts/profession': 'skillPhrase.work',
  'facts/interest': 'skillPhrase.interests',
  'facts/origin': 'skillPhrase.origin',
  'facts/family': 'skillPhrase.family',
  'conversation/feed-tuning': 'skillPhrase.feedTuning',
  'conversation/follow-story': 'skillPhrase.followStory',
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
  result?: unknown;
}

/** A refused card: `proposeChanges` answered with an `error`. No card is drawn
 *  for it (derive-proposals), so the box carries the one failure line. */
export const CARD_REFUSED_CONSEQUENCE_KEY = 'agentSteps.cardRefused' as const;

function isRefusedCard(tc: ToolCallLike): boolean {
  return tc.name === 'proposeChanges' && typeof asRecord(tc.result)?.error === 'string';
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
    const refused = !stranded && isRefusedCard(tc);
    const status: AgentStepStatus = stranded || refused ? 'error' : tc.status;
    const { labelKey, labelValues } = labelForToolCall(tc.name, tc.input);
    const step: AgentStep = {
      id: `${messageId}::${idx}`,
      kind: 'tool',
      glyph: stepKindForTool(tc.name),
      toolName: tc.name,
      labelKey,
      status,
    };
    if (labelValues) step.labelValues = labelValues;
    if (refused) step.consequenceKey = CARD_REFUSED_CONSEQUENCE_KEY;
    else if (status === 'error') step.consequenceKey = consequenceKeyFor(tc.name, stranded);
    return step;
  });
}

/** The row that opens a leg, so the thread is never silent while Mera thinks. */
export function legStartStep(messageId: string, settled: boolean): AgentStep {
  return {
    id: `${messageId}::leg`,
    kind: 'leg-start',
    glyph: 'think',
    labelKey: 'agentSteps.legStart',
    status: settled ? 'done' : 'pending',
  };
}

/**
 * The trailing row on a turn that is STILL RUNNING.
 *
 * `onLeg` fires only once a leg's whole tool loop has settled, so every row
 * the box already holds is `done` and the box has no live indicator of its
 * own between legs. That is not cosmetic: `deriveThreadItems` suppresses the
 * typing bubble on "this box has a pending row", so with no pending row the
 * box AND the wait line were both on screen, which a simulator pass caught on
 * real pixels across consecutive frames.
 *
 * Reuses `agentSteps.working` ("Working on it"), which is already translated
 * in all twenty dictionaries, rather than minting a key for a row that says
 * exactly that.
 */
export function continuingStep(
  anchorId: string,
  liveTool: LiveTool | null = null,
  retried = false,
): AgentStep {
  const base = { id: `${anchorId}::continuing`, kind: 'leg-start' as const, status: 'pending' as const };
  if (liveTool) {
    return { ...base, ...labelForToolCall(liveTool.toolName, liveTool.args), glyph: liveTool.kind };
  }
  return {
    ...base,
    labelKey: retried ? 'chatPhases.retrying' : GENERIC_LABEL_KEY,
    glyph: 'working',
  };
}

/** Tools whose turn wrote, or staged, persona data. Drives whether the settled
 *  line survives in scroll-back: a pure-read turn leaves no line behind.
 *  `saveExtractedFacts` counts even though it only STAGES — the turn produced a
 *  card the user must still act on, and the box is the record of how it got
 *  there. This means "touched the persona pipeline", not "wrote a row". */
export const MUTATING_TOOLS = new Set(['saveExtractedFacts', 'deleteUserFacts', 'applyProposal']);

export function changedDataFrom(steps: AgentStep[]): boolean {
  return steps.some((s) => s.toolName !== undefined && MUTATING_TOOLS.has(s.toolName));
}

// THIS FILE IS THE ONE PLACE A STEP KEY BECOMES TEXT.
//
// Every key below is a LITERAL inside a `t()` call, so tsc checks it against
// the union generated from en.json: a key that never reached the dictionaries
// is a build error, not a raw dot-path rendered at a user. That is also why
// the tables are built from `t` rather than holding resolved text — `t()`'s
// overloads pin the option shape per key, so a key held in a variable cannot
// be passed to it at all.

/** The first line of a phrase pool, or the value itself when it is a string. */
export function firstLine(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

/** The three key->text tables, built once per language. Pure given `t`, so a
 *  table test needs no render. */
export function stepTables(t: TFn) {
  /** Step labels with no interpolation. A key absent here renders the generic
   *  line, which is what keeps an unmapped tool from showing a dot-path. */
  const PLAIN_LABEL: Record<string, string> = {
    'agentSteps.legStart': t('agentSteps.legStart'),
    'agentSteps.loadSkillGeneric': t('agentSteps.loadSkillGeneric'),
    'agentSteps.findSimilarFacts': t('agentSteps.findSimilarFacts'),
    'agentSteps.writeUp': t('agentSteps.writeUp'),
    'agentSteps.removing': t('agentSteps.removing'),
    'agentSteps.asking': t('agentSteps.asking'),
    'agentSteps.working': t('agentSteps.working'),
    'agentSteps.proposeChanges': t('agentSteps.proposeChanges'),
    'agentSteps.applyProposal': t('agentSteps.applyProposal'),
    'agentSteps.cancelProposal': t('agentSteps.cancelProposal'),
    'agentSteps.proposeTrack': t('agentSteps.proposeTrack'),
    'agentSteps.proposeFactCheck': t('agentSteps.proposeFactCheck'),
    'agentSteps.searchNews': t('agentSteps.searchNews'),
    // The wait line's own copy, so the box says the same thing the line
    // would (ux2 batch 25, D6). A pool: its first line.
    'chatPhases.webSearch': firstLine(t('chatPhases.webSearch', { returnObjects: true })),
    // A retry in a tool turn: the trailing row carries the retry words.
    'chatPhases.retrying': firstLine(t('chatPhases.retrying', { returnObjects: true })),
  };

  const SKILL_PHRASE: Record<string, string> = {
    'skillPhrase.residence': t('skillPhrase.residence'),
    'skillPhrase.work': t('skillPhrase.work'),
    'skillPhrase.interests': t('skillPhrase.interests'),
    'skillPhrase.origin': t('skillPhrase.origin'),
    'skillPhrase.family': t('skillPhrase.family'),
    'skillPhrase.feedTuning': t('skillPhrase.feedTuning'),
    // Not in the dictionaries yet (spliced later): cast until it is typed.
    'skillPhrase.followStory': (t as unknown as (key: string) => string)('skillPhrase.followStory'),
  };

  const CONSEQUENCE: Record<string, string> = {
    'agentSteps.consequence.generic': t('agentSteps.consequence.generic'),
    'agentSteps.consequence.interrupted': t('agentSteps.consequence.interrupted'),
    'agentSteps.consequence.lookupPlace': t('agentSteps.consequence.lookupPlace'),
    'agentSteps.consequence.findSimilarFacts': t('agentSteps.consequence.findSimilarFacts'),
    'agentSteps.consequence.loadSkill': t('agentSteps.consequence.loadSkill'),
    'agentSteps.consequence.writeUp': t('agentSteps.consequence.writeUp'),
    'agentSteps.consequence.removing': t('agentSteps.consequence.removing'),
    'agentSteps.cardRefused': t('agentSteps.cardRefused'),
  };
  return { PLAIN_LABEL, SKILL_PHRASE, CONSEQUENCE };
}

/** A step's label. The two interpolating keys are handled explicitly; every
 *  other key comes from the table, and an unknown one falls back rather than
 *  rendering its own name. */
export function stepLabel(
  step: AgentStep,
  t: TFn,
  tables: Pick<ReturnType<typeof stepTables>, 'PLAIN_LABEL' | 'SKILL_PHRASE'>,
): string {
  const values = step.labelValues;
  if (step.labelKey === 'agentSteps.loadSkill' && values?.topicKey) {
    const phrase = tables.SKILL_PHRASE[values.topicKey];
    if (phrase) return t('agentSteps.loadSkill', { topic: phrase });
    return tables.PLAIN_LABEL['agentSteps.loadSkillGeneric'];
  }
  if (step.labelKey === 'agentSteps.lookupPlace' && values?.query) {
    return t('agentSteps.lookupPlace', { query: values.query });
  }
  return tables.PLAIN_LABEL[step.labelKey] ?? tables.PLAIN_LABEL['agentSteps.working'];
}
