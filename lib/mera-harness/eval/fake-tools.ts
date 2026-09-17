// mera-harness/eval — the fake device tools, driven by a script.
//
// Implements core's AgentToolPort exactly. `ask_choice` is deliberately NOT
// here: it is not a device tool, it terminates the turn, and the loop owns it.
//
// WHERE THE DELETE GATE LIVES, AND WHY NOT HERE. P1 gates deleteUserFacts on
// AgentTurnState.resolvedChoice — what the user actually TAPPED. That gate
// belongs to the loop, so this port does NOT refuse: a fake that enforced a
// rule the real device port does not would measure a different system and
// would hide a missing gate rather than reveal it. The fake performs the
// delete and RECORDS whether a choice had been resolved, and the metric turns
// "reached the port with resolvedChoice null" into a hard fail.
//
// THE ONE JUDGEMENT THIS LAYER DOES MAKE. An UNSCRIPTED lookup returns
// `unavailable`, never `no_match`. An unscripted query is a FIXTURE GAP, not
// evidence that the place does not exist. Answering `no_match` would tell the
// agent "Nieuw-West is not a real place"; it would then correctly decline to
// propose the fact, and the run would score a model failure caused entirely by
// a missing fixture row. `unavailable` degrades to "I could not check", which
// is the honest reading of a gap, and the separate counter keeps it from
// hiding inside the scripted `unavailable` cases.

import type {
  AgentToolPort,
  AgentTurnState,
  FindSimilarFactsResult,
  LookupPlaceResult,
  Place,
} from './contract';
import type { AgentScript, ScriptPersona, ScriptTurn } from './types';

export interface FakeToolLog {
  /** Per tool name, how many times it was called THIS TURN. The choice test
   *  reads `lookupPlace` off this and asserts zero after a choice reply. */
  calls: Record<string, number>;
  /** Queries no fixture answered. Counted apart from scripted `unavailable`
   *  answers so the two never merge into one number. */
  unscriptedPlaceLookups: string[];
  /** findSimilarFacts calls that supplied no `kind`. Reported as tool-call
   *  quality, never scored: the argument is optional, and scoring an optional
   *  argument as required would be a bar nobody set. */
  similarFactsWithoutKind: number;
  /** deleteUserFacts calls that REACHED the port while no choice had been
   *  resolved. The loop is supposed to refuse these; each one is a hard fail
   *  and the fake is how they become visible. */
  ungatedDeletesReachingPort: { factIds: string[]; turnIndex: number }[];
  /** Every place the fixture resolved this turn, keyed by the label an option
   *  would carry, so a choice reply maps back to its STRUCTURED payload rather
   *  than a bare display string. */
  placePayloads: Map<string, Place>;
  savedFacts: { statement: string; replaces: string | null; place: unknown }[];
  deleted: string[];
}

export function freshLog(): FakeToolLog {
  return {
    calls: {},
    unscriptedPlaceLookups: [],
    similarFactsWithoutKind: 0,
    ungatedDeletesReachingPort: [],
    placePayloads: new Map(),
    savedFacts: [],
    deleted: [],
  };
}

function normaliseQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A place rendered the way an ask_choice option shows it. One spelling, so
 *  the payload map and the runner cannot disagree about what was offered. */
export function placeLabel(p: Place): string {
  return [p.neighbourhood, p.locality, p.admin1, p.countryName].filter(Boolean).join(', ');
}

export interface FakeToolsHandle {
  port: AgentToolPort;
  log: FakeToolLog;
  persona: ScriptPersona;
  declined: Set<string>;
  /** Called between turns. Clears the per-turn counters and points the fakes
   *  at this turn's scripted answers; the persona mutations carry forward,
   *  because they are the conversation. */
  beginTurn(turn: ScriptTurn, state: AgentTurnState | null): void;
}

export function createFakeTools(script: AgentScript): FakeToolsHandle {
  // Deep copy: a repeat starts from the script's own state, never from what
  // the previous repeat mutated. Otherwise repeat 3 is a different experiment
  // from repeat 1 while still reporting one floor.
  const persona: ScriptPersona = JSON.parse(JSON.stringify(script.persona)) as ScriptPersona;
  const declined = new Set(script.declinedTopics.map((t) => t.trim().toLowerCase()));
  const log = freshLog();
  let turn: ScriptTurn | null = null;
  let state: AgentTurnState | null = null;

  const count = (name: string): void => {
    log.calls[name] = (log.calls[name] ?? 0) + 1;
  };

  const port: AgentToolPort = {
    async findSimilarFacts(args: { kind?: string; limit?: number }): Promise<FindSimilarFactsResult> {
      count('findSimilarFacts');
      if (args.kind === undefined) log.similarFactsWithoutKind += 1;
      const answers = turn?.fakeTools?.find_similar_facts ?? [];
      // Keyed on kind, because the tool carries no query and no statement at
      // all. A null kind in the fixture answers any call.
      const hit =
        answers.find((a) => a.kind === (args.kind ?? null)) ?? answers.find((a) => a.kind === null);
      return hit ? hit.returns : { candidates: [] };
    },

    async lookupPlace(args: { query: string; countryHint?: string }): Promise<LookupPlaceResult> {
      count('lookupPlace');
      const answers = turn?.fakeTools?.lookup_place ?? [];
      const key = normaliseQuery(args.query);
      const hit = answers.find((a) => normaliseQuery(a.query) === key);
      if (!hit) {
        log.unscriptedPlaceLookups.push(args.query);
        return { status: 'unavailable' };
      }
      if (hit.returns.status === 'resolved') {
        for (const p of hit.returns.places) log.placePayloads.set(placeLabel(p), p);
      }
      return hit.returns;
    },

    async saveExtractedFacts(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      count('saveExtractedFacts');
      const entries = Array.isArray(args.extracted_user_information)
        ? args.extracted_user_information
        : [];
      const accepted: string[] = [];
      const rejected: { statement: string; reason: string }[] = [];
      for (const e of entries) {
        const rec = e && typeof e === 'object' ? (e as Record<string, unknown>) : null;
        const statement = typeof rec?.statement === 'string' ? rec.statement : '';
        if (!statement) {
          rejected.push({ statement: '', reason: 'empty' });
          continue;
        }
        if (persona.facts.some((f) => f.statement.trim().toLowerCase() === statement.trim().toLowerCase())) {
          rejected.push({ statement, reason: 'duplicate' });
          continue;
        }
        persona.facts.push({
          id: `new-${persona.facts.length + 1}`,
          statement,
          questionnaireAttribute:
            typeof rec?.questionnaire_attribute === 'string' ? rec.questionnaire_attribute : 'other',
        });
        log.savedFacts.push({
          statement,
          replaces: typeof rec?.replaces === 'string' ? rec.replaces : null,
          place: rec?.placeChain ?? rec?.place ?? null,
        });
        accepted.push(statement);
      }
      return { accepted, rejected };
    },

    async deleteUserFacts(args: { fact_ids: string[] }): Promise<Record<string, unknown>> {
      count('deleteUserFacts');
      // Observed, never refused here. See the header: the gate is the loop's.
      if (!state?.resolvedChoice) {
        log.ungatedDeletesReachingPort.push({
          factIds: args.fact_ids,
          turnIndex: turn?.index ?? -1,
        });
      }
      // fact_ids are QUESTIONNAIRE ATTRIBUTE STRINGS, not fact ids. Matching
      // them against `id` silently deletes nothing, which is the trap.
      const attrs = new Set(args.fact_ids);
      const before = persona.facts.length;
      persona.facts = persona.facts.filter((f) => !attrs.has(f.questionnaireAttribute));
      const removed = before - persona.facts.length;
      const deleted = args.fact_ids.slice(0, removed);
      log.deleted.push(...deleted);
      return { deleted };
    },
  };

  return {
    port,
    log,
    persona,
    declined,
    beginTurn(next: ScriptTurn, turnState: AgentTurnState | null): void {
      turn = next;
      state = turnState;
      log.calls = {};
    },
  };
}
