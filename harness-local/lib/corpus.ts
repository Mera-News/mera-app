// harness-local — the persona corpus: four cohorts, and the cross-turn state
// that makes two of them mean anything.
//
// WHOSE SEMANTICS THESE ARE. There is NO function in lib/news-harness that
// takes a saveFact tool call and returns the next persona state. The rails are
// DETECTORS and PROPOSERS: `detectFactConflicts` returns FactConflict[],
// `analyzeHygiene` returns HygieneProposal[]. Neither mutates anything. So the
// application below (append on save, remove on delete, replace on update) is
// THIS FILE's definition, not the app's, and it is stated here and in the
// report so nobody reads a cohort result as a claim about production
// behaviour. What IS the app's is everything the detectors then say about the
// result, which is recorded per turn.
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
  added: string[];
  conflicts: string[];
  rejectedByRails: string[];
}

interface ParsedToolCall {
  name: string;
  parsed: Record<string, unknown> | null;
}

function statementOf(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) return null;
  for (const key of ['statement', 'fact', 'text', 'value']) {
    const v = parsed[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Applies one turn's tool calls, then runs the real detectors over the result.
 *
 * Returns the NEXT state plus what the rails said about it. The conflicts and
 * the hygiene proposals are the app's own verdicts; the mutation is this
 * file's (see the header).
 */
export function applyToolCalls(
  state: CorpusPersona,
  calls: ParsedToolCall[],
  now = Date.now(),
): { state: CorpusPersona; delta: StateDelta } {
  const next = freshState(state);
  const added: string[] = [];

  for (const call of calls) {
    const name = call.name.toLowerCase();
    const statement = statementOf(call.parsed);
    if (name.includes('savefact') || name.includes('addfact')) {
      if (!statement) continue;
      const id = `new-${next.facts.length + 1}`;
      next.facts.push({
        id,
        statement,
        questionnaireAttribute:
          typeof call.parsed?.attribute === 'string' ? call.parsed.attribute : 'other',
        questionnaireLevel: 2,
        questionnaireLevelCategory: 'Chat',
        weight: 1,
        createdAtMs: now,
        metadata: { topics: [] },
      });
      added.push(statement);
    } else if (name.includes('deletefact') || name.includes('removefact')) {
      const target = typeof call.parsed?.factId === 'string' ? call.parsed.factId : null;
      if (target) next.facts = next.facts.filter((f) => f.id !== target);
    } else if (name.includes('updatefact') || name.includes('editfact')) {
      const target = typeof call.parsed?.factId === 'string' ? call.parsed.factId : null;
      const found = target ? next.facts.find((f) => f.id === target) : undefined;
      if (found && statement) found.statement = statement;
    }
  }

  // The app's own detectors, over the result. Both are pure and read-only.
  const newFacts: FactForConflict[] = next.facts
    .filter((f) => added.includes(f.statement))
    .map((f) => ({ id: f.id, statement: f.statement, questionnaireAttribute: f.questionnaireAttribute }));
  const existing: FactForConflict[] = next.facts
    .filter((f) => !added.includes(f.statement))
    .map((f) => ({ id: f.id, statement: f.statement, questionnaireAttribute: f.questionnaireAttribute }));

  const conflicts = detectFactConflicts(newFacts, existing).map(
    (c) => `${c.kind}: "${c.newStatement}" vs "${c.existingStatement}"`,
  );

  const hygieneFacts: HygieneFactInput[] = next.facts.map((f) => ({
    id: f.id, statement: f.statement, weight: f.weight, createdAtMs: f.createdAtMs,
  }));
  const hygieneTopics: HygieneTopicInput[] = next.topics.map((t) => ({
    id: t.id, factId: t.factId, text: t.text, normalizedText: t.normalizedText,
    weight: t.weight, status: t.status, lastSignalAtMs: t.lastSignalAtMs,
  }));
  const rejectedByRails = analyzeHygiene({ facts: hygieneFacts, topics: hygieneTopics, now })
    .filter((p) => p.kind === 'duplicate_facts' || p.kind === 'too_broad_fact')
    .map((p) => `${p.kind}: ${p.id}`);

  return { state: next, delta: { added, conflicts, rejectedByRails } };
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
