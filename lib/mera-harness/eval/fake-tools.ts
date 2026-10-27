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
  PendingProposalView,
  Place,
} from './contract';
import { CARD_ACTION_KINDS, type AgentScript, type ScriptPersona, type ScriptTurn } from './types';

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
  /** applyProposal calls that reached the port. The metric reads the rows, not
   *  this; it is here so a test can see the port was reached. */
  appliedCards: { proposalId: string; actions: Record<string, unknown>[] }[];
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
    appliedCards: [],
    savedFacts: [],
    deleted: [],
  };
}

const foldOutlet = (o: string): string => o.trim().toLowerCase().replace(/\s+/g, ' ');

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
  /** The card on the fake screen, as the loop's state sees it, or null. Held
   *  across TURNS of a script like the device holds it: a staged card is still
   *  waiting on the next turn until applyProposal / cancelProposal clears it. */
  pendingProposal(): PendingProposalView | null;
  /** The filters the loop's `<filters>` state lists; apply and retire change it. */
  activeFilters(): { id: string; pattern: string }[];
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
  const filters = (persona.activeFilters ??= []);
  const outlets = new Set((persona.knownOutlets ?? []).map(foldOutlet));
  let card: { view: PendingProposalView; actions: Record<string, unknown>[] } | null = null;
  let cardCount = 0;
  let filterCount = 0;

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
      // `pendingFacts` like the device: the loop counts a proposal only when
      // something was staged.
      return { accepted, rejected, pendingFacts: accepted.map((s) => ({ options: [s] })) };
    },

    // Deterministic and offline: the eval never reaches the web. A turn may
    // SCRIPT what a query returns (so it really names a subject); an unscripted
    // query is an honestly-labelled empty answer. The SHAPES are the device's
    // (lib/chat-tools/web-search-handler.ts): one query gives the single entry,
    // several give the batch.
    async webSearch(args: { queries: string[] }): Promise<Record<string, unknown>> {
      count('webSearch');
      const scripted = turn?.fakeTools?.webSearch ?? [];
      const entry = (query: string): Record<string, unknown> => {
        const hit = scripted.find((a) => a.query === undefined || query.toLowerCase().includes(a.query));
        return hit && hit.results.length > 0
          ? { query, searched: true, results: hit.results }
          : {
              query,
              searched: true,
              results: [],
              note: 'The search returned nothing for this query. Say you could not find anything on the web for it, and answer from what you already have.',
            };
      };
      if (args.queries.length === 1) return entry(args.queries[0]);
      const searches = args.queries.map(entry);
      return { searched: true, searches };
    },

    // Canned and offline, like webSearch: the eval scores whether the turn
    // asked for the right topics and answered from the result, not the prose
    // of the real reference text (which lives outside the harness).
    async explainMera(args: { topics: string[] }): Promise<Record<string, unknown>> {
      count('explainMera');
      return {
        sections: args.topics.map((topic) => ({
          topic,
          text: `Mera's reference text on ${topic}. Answer only from what is written here.`,
        })),
      };
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

    // CARDS. Staging changes nothing; the slot is what the next turn's state
    // reports. The device's sanitizer decides what a card may hold; the fake
    // mirrors the one rule an eval needs: an outlet the persona does not know
    // is refused, so a model that invents one is seen doing it.
    async proposeChanges(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      count('proposeChanges');
      const raw = Array.isArray(args.actions) ? args.actions : [];
      const actions: Record<string, unknown>[] = [];
      for (const a of raw) {
        const rec = a && typeof a === 'object' ? (a as Record<string, unknown>) : null;
        const type = typeof rec?.type === 'string' ? rec.type : '';
        if (!rec || !CARD_ACTION_KINDS.includes(type as never)) {
          return { error: `unsupported action type: ${type || '(none)'}` };
        }
        if (type === 'set_publication_pref') {
          const name = typeof rec.publicationId === 'string' ? rec.publicationId : '';
          if (!outlets.has(foldOutlet(name))) return { error: `unknown publication: ${name || '(none)'}` };
        }
        actions.push({ ...rec });
      }
      if (actions.length === 0) return { error: 'no actions to stage' };
      cardCount += 1;
      const proposalId = `card-${cardCount}`;
      const summary = typeof args.explanation === 'string' ? args.explanation : actions.map((a) => String(a.type)).join(', ');
      // All four kinds are applicable by typing and none is an alternative.
      card = { view: { id: proposalId, summary, chooseOne: false, appliable: true }, actions };
      return { staged: true, proposalId, actions };
    },

    async applyProposal(): Promise<Record<string, unknown>> {
      count('applyProposal');
      if (!card) return { error: 'No card is waiting.' };
      const done = card;
      card = null;
      for (const a of done.actions) {
        if (a.type === 'add_suppression') {
          filterCount += 1;
          filters.push({ id: `sup-${filterCount}`, pattern: String(a.suppressionPattern ?? '') });
        } else if (a.type === 'retire_suppression') {
          const at = filters.findIndex((f) => f.id === a.suppressionId);
          if (at >= 0) filters.splice(at, 1);
        }
      }
      log.appliedCards.push({ proposalId: done.view.id, actions: done.actions });
      return { applied: done.actions.length, errors: [] };
    },

    async cancelProposal(): Promise<Record<string, unknown>> {
      count('cancelProposal');
      if (!card) return { error: 'No card is waiting.' };
      card = null;
      return { cancelled: true };
    },
  };

  return {
    port,
    log,
    persona,
    declined,
    pendingProposal: () => (card ? { ...card.view } : null),
    activeFilters: () => filters.map((f) => ({ ...f })),
    beginTurn(next: ScriptTurn, turnState: AgentTurnState | null): void {
      turn = next;
      state = turnState;
      log.calls = {};
    },
  };
}
