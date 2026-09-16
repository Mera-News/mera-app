// harness-local — the persona corpus: four cohorts, and the cross-turn state
// that makes two of them mean anything.
//
// WHOSE SEMANTICS THESE ARE. There is NO function in lib/news-harness that
// takes a tool call and returns the next persona state. The rails are FILTERS,
// DETECTORS and PROPOSERS: `filterFactChoiceGroups` returns offerable groups
// plus rejections, `detectFactConflicts` returns FactConflict[]. Neither
// mutates anything. So the COMMIT step below is this file's definition and
// says so. Everything before it is the app's own code.
//
// WHAT THE TOOL ACTUALLY DOES. `saveExtractedFacts` does not save: it OFFERS
// readings for the user to tap, and `filterFactChoiceGroups` decides what is
// offerable. So the corpus runs the real filter, records what it rejected as
// the rails' verdict, and then commits the FIRST option of each surviving
// group, which is the reading the card presents by default. That is why a
// rater scores the post-filter view: it is what a user would have been shown.
//
// TRAP. `deleteUserFacts.fact_ids` are QUESTIONNAIRE ATTRIBUTE STRINGS, not
// fact ids, per the tool schema in prompts/persona-prompts.ts. Matching them
// against `id` silently deletes nothing.
//
// WHY CROSS-TURN STATE AT ALL. The `confused` cohort restates facts that are
// already saved and the `heavy` cohort adds facts that conflict with existing
// ones. Both are cross-turn behaviours. If every turn rebuilt its context from
// the cohort's starting persona, every turn would see the same facts and
// neither cohort would test anything.
//
// Node-only: never imported by the app bundle.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  formatKnownFactsList,
  MAX_FACTS_IN_CONTEXT,
  MAX_HISTORY_USER_TURNS,
} from '../../lib/news-harness';
// fact-conflict and fact-hygiene are NOT on the news-harness public index
// (lib/news-harness/index.ts re-exports core, prompts, fact-rules,
// topic-generation, persona-agent-core, article-pipeline, article-feedback,
// scoring-engine and feed-select, and nothing else), so these two are imported
// from their own modules.
import {
  detectFactConflicts,
  type FactForConflict,
} from '../../lib/news-harness/persona-management/fact-conflict';
import {
  analyzeHygiene,
  type HygieneFactInput,
  type HygieneTopicInput,
} from '../../lib/news-harness/persona-management/fact-hygiene';
import {
  filterFactChoiceGroups,
  normalizeStatement,
  type FactEntry,
} from '../../lib/news-harness/persona-management/fact-rules';

export const COHORTS = ['good', 'confused', 'adversarial', 'heavy'] as const;
export type CohortName = (typeof COHORTS)[number];

export interface CorpusFact {
  id: string;
  statement: string;
  questionnaireAttribute: string;
  questionnaireLevel: number;
  questionnaireLevelCategory: string;
  weight: number;
  createdAtMs: number;
  metadata: { topics: string[] };
}

export interface CorpusTopic {
  id: string;
  factId: string | null;
  text: string;
  normalizedText: string;
  weight: number;
  status: 'active' | 'suppressed' | 'retired';
  lastSignalAtMs: number | null;
}

export interface CorpusPersona {
  cohort: string;
  facts: CorpusFact[];
  topics: CorpusTopic[];
}

export interface CorpusTurn {
  index: number;
  user: string;
}

export interface Cohort {
  name: string;
  persona: CorpusPersona;
  turns: CorpusTurn[];
}

const CORPUS_ROOT = resolve(__dirname, '..', 'fixtures', 'persona-corpus');

export function loadCohort(name: string): Cohort {
  const persona = JSON.parse(
    readFileSync(resolve(CORPUS_ROOT, 'personas', `${name}.json`), 'utf8'),
  ) as CorpusPersona;
  const script = JSON.parse(
    readFileSync(resolve(CORPUS_ROOT, 'scripts', `${name}.json`), 'utf8'),
  ) as { turns: CorpusTurn[] };
  return { name, persona, turns: script.turns };
}

/** A deep copy, so a repeat starts from the cohort's own state and never from
 *  whatever the previous repeat mutated. Getting this wrong makes repeat 3 a
 *  different experiment from repeat 1 while still reporting one floor. */
export function freshState(persona: CorpusPersona): CorpusPersona {
  return JSON.parse(JSON.stringify(persona)) as CorpusPersona;
}

export interface StateDelta {
  /** Statements COMMITTED to state: the first option of each group that
   *  survived the filter. */
  added: string[];
  /** Every reading the model offered, including the alternatives the user
   *  would have seen beside the committed one. */
  offered: string[];
  conflicts: string[];
  /** The app's own verdict, from filterFactChoiceGroups: empty, too-long,
   *  meta-conversational, or duplicate of a fact already held. A confused
   *  cohort restating a saved fact should land here. */
  rejectedByRails: string[];
  /** Hygiene proposals the state would raise, kept separate from the
   *  per-turn rejections so the two are never confused. */
  hygieneProposals: string[];
}

interface ParsedToolCall {
  name: string;
  parsed: Record<string, unknown> | null;
}

function asFactEntries(parsed: Record<string, unknown> | null): FactEntry[] {
  const raw = parsed?.extracted_user_information;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is FactEntry =>
      typeof e === 'string' ||
      (typeof e === 'object' && e !== null && typeof (e as { statement?: unknown }).statement === 'string'),
  );
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Applies one turn's tool calls through the real filter, then runs the real
 * detectors over the result.
 *
 * Returns the NEXT state plus what the rails said. Only the commit step is
 * this file's own (see the header).
 */
export function applyToolCalls(
  state: CorpusPersona,
  calls: ParsedToolCall[],
  now = Date.now(),
): { state: CorpusPersona; delta: StateDelta } {
  const next = freshState(state);
  const added: string[] = [];
  const offered: string[] = [];
  const rejectedByRails: string[] = [];

  for (const call of calls) {
    const name = call.name;
    if (name === 'saveExtractedFacts') {
      const entries = asFactEntries(call.parsed);
      if (entries.length === 0) continue;
      // The app's own filter, against the facts already held.
      // Normalized here too, though filterNewFacts now normalizes on insert
      // itself, so this is no longer required. Kept because normalizeStatement
      // is idempotent, it costs nothing, and it makes this harness correct
      // against either version of fact-rules rather than only the current one.
      // The precondition it used to work around is documented in the self-test,
      // which pins the fixed behaviour in both directions.
      const { groups, rejected } = filterFactChoiceGroups(
        entries,
        next.facts.map((f) => normalizeStatement(f.statement)),
      );
      rejectedByRails.push(...rejected.map((r) => `${r.reason}: ${r.statement}`));
      for (const g of groups) {
        offered.push(...g.options);
        const chosen = g.options[0];
        if (!chosen) continue;
        next.facts.push({
          id: `new-${next.facts.length + 1}`,
          statement: chosen,
          questionnaireAttribute: g.questionnaire?.attribute ?? 'other',
          questionnaireLevel: 2,
          questionnaireLevelCategory: 'Chat',
          weight: 1,
          createdAtMs: now,
          metadata: { topics: [] },
        });
        added.push(chosen);
      }
    } else if (name === 'deleteUserFacts') {
      // ATTRIBUTE STRINGS, not ids. See the trap note in the header.
      const attrs = new Set(asStringArray(call.parsed?.fact_ids));
      if (attrs.size > 0) {
        next.facts = next.facts.filter((fct) => !attrs.has(fct.questionnaireAttribute));
      }
    }
  }

  const newFacts: FactForConflict[] = next.facts
    .filter((fct) => added.includes(fct.statement))
    .map((fct) => ({
      id: fct.id,
      statement: fct.statement,
      questionnaireAttribute: fct.questionnaireAttribute,
    }));
  const existing: FactForConflict[] = next.facts
    .filter((fct) => !added.includes(fct.statement))
    .map((fct) => ({
      id: fct.id,
      statement: fct.statement,
      questionnaireAttribute: fct.questionnaireAttribute,
    }));
  const conflicts = detectFactConflicts(newFacts, existing).map(
    (c) => `${c.kind}: "${c.newStatement}" vs "${c.existingStatement}"`,
  );

  const hygieneFacts: HygieneFactInput[] = next.facts.map((fct) => ({
    id: fct.id, statement: fct.statement, weight: fct.weight, createdAtMs: fct.createdAtMs,
  }));
  const hygieneTopics: HygieneTopicInput[] = next.topics.map((t) => ({
    id: t.id, factId: t.factId, text: t.text, normalizedText: t.normalizedText,
    weight: t.weight, status: t.status, lastSignalAtMs: t.lastSignalAtMs,
  }));
  const hygieneProposals = analyzeHygiene({ facts: hygieneFacts, topics: hygieneTopics, now })
    .filter((pr) => pr.kind === 'duplicate_facts' || pr.kind === 'too_broad_fact')
    .map((pr) => `${pr.kind}: ${pr.id}`);

  return {
    state: next,
    delta: { added, offered, conflicts, rejectedByRails, hygieneProposals },
  };
}

/**
 * MEASURED, never computed. The point of the heavy cohort is to observe what
 * the prompt builder's cap actually did, so this counts the bullets
 * `formatKnownFactsList` really emitted in the string that was hashed and
 * sent. Setting it to `Math.min(factCount, MAX_FACTS_IN_CONTEXT)` would record
 * the constant and show nothing.
 */
export function measureFactsInPrompt(knownFactsList: string): number {
  if (knownFactsList.trim() === 'Nothing yet.') return 0;
  return knownFactsList.split('\n').filter((l) => l.startsWith("- '")).length;
}

/** Likewise measured: how many user turns survived the history window. */
export function measureTurnsInPrompt(messages: { role: string }[]): number {
  return messages.filter((m) => m.role === 'user').length;
}

/** Renders the fact list exactly as the app does, so the measurement above is
 *  taken from the same string the model receives. */
export function renderKnownFacts(state: CorpusPersona): string {
  return formatKnownFactsList(
    state.facts.map((f) => ({
      statement: f.statement,
      questionnaireAttribute: f.questionnaireAttribute,
    })),
  );
}

/** The caps the cohorts are designed to cross, re-exported so a runner reports
 *  them next to what it measured rather than hardcoding a second copy. */
export const PROMPT_CAPS = {
  maxFactsInContext: MAX_FACTS_IN_CONTEXT,
  maxHistoryUserTurns: MAX_HISTORY_USER_TURNS,
} as const;
