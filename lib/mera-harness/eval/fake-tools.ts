// mera-harness/eval — the fake device tools, driven by a script.
//
// These stand in for the real device port. Every answer a turn can receive is
// fixed by the fixture, which is what makes the fact and topic metrics
// mechanical rather than a matter of taste.
//
// THE ONE JUDGEMENT THIS LAYER MAKES, AND WHY IT GOES THIS WAY. An UNSCRIPTED
// lookup returns `unavailable`, never `no_match`. An unscripted query is a
// FIXTURE GAP, not evidence that the place does not exist. Answering `no_match`
// would tell the agent "Nieuw-West is not a real place"; it would then
// correctly decline to propose the fact, and the run would score a model
// failure caused entirely by a missing fixture row. `unavailable` degrades to
// "I could not check", which is the honest reading of a gap, and the separate
// counter keeps it from hiding inside the scripted `unavailable` cases.

import type {
  AgentToolPort,
  AskChoiceArgs,
  AskChoiceResult,
  DeleteUserFactsResult,
  FactKind,
  FindSimilarFactsArgs,
  LookupPlaceArgs,
  LookupPlaceResult,
  SimilarFactCandidate,
} from './contract';
import type { AgentScript, ScriptPersona, ScriptTurn } from './types';

export interface FakeToolLog {
  /** Per tool name, how many times it was called this TURN. The B2 test reads
   *  `lookup_place` off this and asserts zero after a choice reply. */
  calls: Record<string, number>;
  /** Queries no fixture answered. Counted separately from scripted
   *  `unavailable` answers so the two never merge into one number. */
  unscriptedPlaceLookups: string[];
  /** `find_similar_facts` calls that supplied no `kind`. Reported as tool-call
   *  quality, not scored: P1 made the argument optional, and scoring an
   *  optional argument as required would be a bar nobody set. */
  similarFactsWithoutKind: number;
  /** A deleteUserFacts fired with no confirmed choice (S9). */
  ungatedDeleteAttempts: number;
  /** Options the model offered on the last ask_choice, so the runner can
   *  compare them against the fixture's `chooses`. */
  lastOfferedOptions: string[] | null;
  /** Set once ask_choice has been answered, which is what un-gates delete. */
  choiceConfirmed: boolean;
  /** Every place the fixture resolved this turn, by display string, so a
   *  choice reply can be mapped back to its STRUCTURED payload instead of a
   *  bare label. Without this the next turn re-runs lookup_place on the same
   *  words and can re-ambiguate. */
  placePayloads: Map<string, unknown>;
  savedFacts: { statement: string; replaces: string | null; placeChain: unknown }[];
}

export function freshLog(): FakeToolLog {
  return {
    calls: {},
    unscriptedPlaceLookups: [],
    similarFactsWithoutKind: 0,
    ungatedDeleteAttempts: 0,
    lastOfferedOptions: null,
    choiceConfirmed: false,
    placePayloads: new Map(),
    savedFacts: [],
  };
}

function normaliseQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A place rendered the way an ask_choice option would show it. Kept here so
 *  the payload map and the runner agree on one spelling. */
export function placeLabel(p: {
  neighbourhood?: string;
  locality: string;
  admin1: string | null;
  countryName: string;
}): string {
  return [p.neighbourhood, p.locality, p.admin1, p.countryName].filter(Boolean).join(', ');
}

export interface FakeToolsHandle {
  port: AgentToolPort;
  log: FakeToolLog;
  /** Called by the loop between turns. Resets per-turn counters but keeps the
   *  persona mutations and the pending choice, which are conversation state. */
  beginTurn(turn: ScriptTurn): void;
  /** State the metrics read after the run. */
  persona: ScriptPersona;
  declined: Set<string>;
}

export function createFakeTools(script: AgentScript): FakeToolsHandle {
  // Deep copy: a repeat must start from the script's own state and never from
  // whatever the previous repeat mutated, or repeat 3 is a different
  // experiment from repeat 1 while still reporting one floor.
  const persona: ScriptPersona = JSON.parse(JSON.stringify(script.persona)) as ScriptPersona;
  const declined = new Set(script.declinedTopics.map((t) => t.trim().toLowerCase()));
  const log = freshLog();
  let turn: ScriptTurn | null = null;

  const count = (name: string): void => {
    log.calls[name] = (log.calls[name] ?? 0) + 1;
  };

  const port: AgentToolPort = {
    async find_similar_facts(args: FindSimilarFactsArgs): Promise<{ candidates: SimilarFactCandidate[] }> {
      count('find_similar_facts');
      if (args.kind === undefined) log.similarFactsWithoutKind += 1;
      const answers = turn?.fakeTools?.find_similar_facts ?? [];
      // Keyed on kind, because the tool carries no query at all (S2). A null
      // kind in the fixture answers any call.
      const hit =
        answers.find((a) => a.kind === (args.kind ?? null)) ?? answers.find((a) => a.kind === null);
      return hit ? hit.returns : { candidates: [] };
    },

    async lookup_place(args: LookupPlaceArgs): Promise<LookupPlaceResult> {
      count('lookup_place');
      const answers = turn?.fakeTools?.lookup_place ?? [];
      const key = normaliseQuery(args.query);
      const hit = answers.find((a) => normaliseQuery(a.query) === key);
      if (!hit) {
        log.unscriptedPlaceLookups.push(args.query);
        // See the header: a gap is "I could not check", never "no such place".
        return { status: 'unavailable' };
      }
      if (hit.returns.status === 'resolved') {
        for (const p of hit.returns.places) log.placePayloads.set(placeLabel(p), p);
      }
      return hit.returns;
    },

    async ask_choice(args: AskChoiceArgs): Promise<AskChoiceResult> {
      count('ask_choice');
      // A malformed call is a COUNTED TERMINAL STATE (S1), never settled prose:
      // without this it degrades into a bare prose question with no chips,
      // which is the failure the offer-don't-ask rule exists to forbid.
      if (!Array.isArray(args.options) || args.options.length < 2 || args.options.length > 3) {
        log.lastOfferedOptions = Array.isArray(args.options) ? args.options : [];
        return { error: 'options must be 2 or 3' };
      }
      log.lastOfferedOptions = args.options;
      return { awaiting: 'user' };
    },

    async deleteUserFacts(args: { fact_ids: string[] }): Promise<DeleteUserFactsResult> {
      count('deleteUserFacts');
      // S9: irreversible and cascading, so the fake ENFORCES the gate rather
      // than trusting the model to respect it.
      if (!log.choiceConfirmed) {
        log.ungatedDeleteAttempts += 1;
        return { error: 'confirm with ask_choice first' };
      }
      // fact_ids are QUESTIONNAIRE ATTRIBUTE STRINGS, not fact ids. Matching
      // them against `id` silently deletes nothing, which is the trap.
      const attrs = new Set(args.fact_ids);
      const before = persona.facts.length;
      persona.facts = persona.facts.filter((f) => !attrs.has(f.questionnaireAttribute));
      return { deleted: args.fact_ids.slice(0, before - persona.facts.length) };
    },

    async saveExtractedFacts(args: Record<string, unknown>) {
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
        const dup = persona.facts.some(
          (f) => f.statement.trim().toLowerCase() === statement.trim().toLowerCase(),
        );
        if (dup) {
          rejected.push({ statement, reason: 'duplicate' });
          continue;
        }
        persona.facts.push({
          id: `new-${persona.facts.length + 1}`,
          statement,
          questionnaireAttribute:
            typeof rec?.questionnaire_attribute === 'string' ? rec.questionnaire_attribute : 'other',
          kind: typeof rec?.kind === 'string' ? (rec.kind as FactKind) : undefined,
        });
        log.savedFacts.push({
          statement,
          replaces: typeof rec?.replaces === 'string' ? rec.replaces : null,
          placeChain: rec?.placeChain ?? null,
        });
        accepted.push(statement);
      }
      return { accepted, rejected };
    },
  };

  return {
    port,
    log,
    persona,
    declined,
    beginTurn(next: ScriptTurn): void {
      turn = next;
      log.calls = {};
      log.lastOfferedOptions = null;
      // Answering a question confirms the choice for the turn that follows it,
      // which is what un-gates deleteUserFacts.
      log.choiceConfirmed = next.chooses !== undefined;
    },
  };
}
