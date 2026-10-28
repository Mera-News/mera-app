// mera-harness/eval — conversation script parsing and validation.
//
// PURE: takes already-parsed JSON, returns a validated script or throws. The
// fs read belongs to the harness-local CLI (no node builtins here, see
// contract.ts).
//
// EVERY CHECK HERE EXISTS BECAUSE ITS ABSENCE IS SILENT. A fixture with a
// typo'd skill id does not crash, it scores as "wrong id" forever. A fake tool
// answer no turn reaches does not crash, it just stops testing anything. A
// choice reply with no question before it does not crash, it sends a bare
// option string as if the user had typed it. All three are load errors.

import { CARD_ACTION_KINDS } from './types';
import type {
  AgentScript,
  ExpectedCard,
  ExpectedTrack,
  FakeSearchNewsAnswer,
  FakeSimilarFactsAnswer,
  ScriptMoreOptions,
  FakeLookupPlaceAnswer,
  ReplyScript,
  ScriptPersona,
  ScriptTurn,
} from './types';
import type { FactKind } from './contract';

export interface ParseOptions {
  /** The route kinds the agent core actually exports. Passed in rather than
   *  copied, so a rename upstream fails loudly here instead of scoring. */
  routeKinds: readonly string[];
  /** Every skill id that exists. `loadSkill` returning null cannot separate
   *  "id does not exist" from "id exists but is empty", which is why the core
   *  exposes the list. */
  skillIds: readonly string[];
}

const REPLY_SCRIPTS: readonly ReplyScript[] = ['devanagari'];

const SURFACE_KINDS = ['persona', 'article', 'follow-story', 'tutorial', 'optimisation-plan', 'onboarding'] as const;

const FACT_KINDS: readonly FactKind[] = [
  'residence',
  'origin',
  'profession',
  'family',
  'generic',
];

function fail(scriptId: string, message: string): never {
  throw new Error(`mera-harness/eval: script '${scriptId}' ${message}`);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Validates one script. Throws on the first violation with the script id and
 * turn index in the message: a fixture error found at load costs seconds, and
 * the same error found after a paid run costs the run.
 */
export function parseScript(raw: unknown, opts: ParseOptions): AgentScript {
  const root = asRecord(raw);
  if (!root) throw new Error('mera-harness/eval: script is not an object.');
  const id = typeof root.id === 'string' ? root.id : '';
  if (!id) throw new Error('mera-harness/eval: script has no id.');

  const cohort = typeof root.cohort === 'string' ? root.cohort : id;
  const persona = parsePersona(id, root.persona);
  const declinedTopics = asStringArray(root.declinedTopics);

  const rawTurns = Array.isArray(root.turns) ? root.turns : null;
  if (!rawTurns || rawTurns.length === 0) fail(id, 'has no turns.');

  const turns: ScriptTurn[] = rawTurns.map((t, i) => parseTurn(id, i, t, opts));

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.index !== i) {
      fail(id, `turn at position ${i} declares index ${turn.index}; indexes must be 0..n in order.`);
    }
    // A choice reply is only meaningful after a question. Without this, the
    // runner would send a bare option string as though the user had typed it,
    // and the consecutive-question metric would be reading a conversation that
    // never happened.
    if (turn.chooses !== undefined) {
      const prev = turns[i - 1];
      if (!prev) fail(id, `turn ${i} is a choice reply but is the first turn.`);
      if (!prev.expect.tools.includes('ask_choice')) {
        fail(
          id,
          `turn ${i} is a choice reply but turn ${i - 1} does not expect ask_choice. ` +
            'A choice reply must answer a question the previous turn was expected to ask.',
        );
      }
    }
  }

  assertEveryFakeAnswerIsReachable(id, turns);

  return {
    id,
    cohort,
    note: typeof root.note === 'string' ? root.note : undefined,
    persona,
    declinedTopics,
    ...(root.surface !== undefined ? { surface: parseSurface(id, root.surface) } : {}),
    turns,
  };
}

function parseSurface(scriptId: string, raw: unknown): NonNullable<AgentScript['surface']> {
  const r = asRecord(raw);
  const kind = r?.kind;
  if (!r || !SURFACE_KINDS.includes(kind as never)) {
    fail(scriptId, `surface needs a kind, one of: ${SURFACE_KINDS.join(', ')}.`);
  }
  for (const f of ['hint', 'context'] as const) {
    if (r[f] !== null && typeof r[f] !== 'string') fail(scriptId, `surface.${f} must be a string or null.`);
  }
  return { kind: kind as (typeof SURFACE_KINDS)[number], hint: r.hint as string | null, context: r.context as string | null };
}

function parseMoreOptions(scriptId: string, i: number, raw: unknown): ScriptMoreOptions {
  const r = asRecord(raw);
  const shown = r && Array.isArray(r.shown) ? r.shown : null;
  const ok = shown && shown.length > 0 && shown.every((o) => {
    const or = asRecord(o);
    return !!or && typeof or.label === 'string' && or.label !== '' && typeof or.searchText === 'string';
  });
  if (!r || !ok) fail(scriptId, `turn ${i} moreOptions needs a non-empty shown list of { label, searchText }.`);
  if (typeof r.room !== 'number' || !Number.isInteger(r.room) || r.room < 1) {
    fail(scriptId, `turn ${i} moreOptions.room must be an integer of 1 or more.`);
  }
  return { shown: shown as ScriptMoreOptions['shown'], room: r.room };
}

function parseTrack(scriptId: string, i: number, raw: unknown): ExpectedTrack | undefined {
  if (raw === undefined) return undefined;
  const t = asRecord(raw);
  if (!t || typeof t.staged !== 'boolean') fail(scriptId, `turn ${i} expect.track needs a boolean staged.`);
  for (const f of ['minOptions', 'maxOptions'] as const) {
    if (t[f] !== undefined && (typeof t[f] !== 'number' || !Number.isInteger(t[f]) || (t[f] as number) < 1)) {
      fail(scriptId, `turn ${i} expect.track.${f} must be an integer of 1 or more.`);
    }
  }
  if (typeof t.minOptions === 'number' && typeof t.maxOptions === 'number' && t.minOptions > t.maxOptions) {
    fail(scriptId, `turn ${i} expect.track.minOptions is above maxOptions.`);
  }
  return {
    staged: t.staged,
    ...(t.minOptions !== undefined ? { minOptions: t.minOptions as number } : {}),
    ...(t.maxOptions !== undefined ? { maxOptions: t.maxOptions as number } : {}),
    ...(t.labelMatches !== undefined ? { labelMatches: parseNeedles(scriptId, i, 'track.labelMatches', t.labelMatches) } : {}),
    ...(t.labelExcludes !== undefined ? { labelExcludes: parseNeedles(scriptId, i, 'track.labelExcludes', t.labelExcludes) } : {}),
  };
}

function parsePersona(scriptId: string, raw: unknown): ScriptPersona {
  const rec = asRecord(raw);
  if (!rec) fail(scriptId, 'has no persona object.');
  const facts = Array.isArray(rec.facts) ? rec.facts : [];
  const topics = Array.isArray(rec.topics) ? rec.topics : [];
  if ('languageName' in rec && (typeof rec.languageName !== 'string' || rec.languageName.trim() === '')) {
    fail(scriptId, 'persona languageName must be a non-empty string, or absent.');
  }
  const knownOutlets = rec.knownOutlets;
  if (knownOutlets !== undefined && (!Array.isArray(knownOutlets) || knownOutlets.some((o) => typeof o !== 'string'))) {
    fail(scriptId, 'persona knownOutlets must be an array of strings, or absent.');
  }
  const activeFilters = rec.activeFilters;
  if (
    activeFilters !== undefined &&
    (!Array.isArray(activeFilters) ||
      activeFilters.some((f) => {
        const fr = asRecord(f);
        return !fr || typeof fr.id !== 'string' || typeof fr.pattern !== 'string';
      }))
  ) {
    fail(scriptId, 'persona activeFilters must be an array of { id, pattern } strings, or absent.');
  }
  return {
    ...(typeof rec.languageName === 'string' ? { languageName: rec.languageName } : {}),
    ...(knownOutlets !== undefined ? { knownOutlets: knownOutlets as string[] } : {}),
    ...(activeFilters !== undefined ? { activeFilters: activeFilters as { id: string; pattern: string }[] } : {}),
    facts: facts.map((f, i) => {
      const fr = asRecord(f);
      if (!fr || typeof fr.statement !== 'string' || typeof fr.id !== 'string') {
        fail(scriptId, `persona fact ${i} needs an id and a statement.`);
      }
      const kind = typeof fr.kind === 'string' ? (fr.kind as FactKind) : undefined;
      if (kind !== undefined && !FACT_KINDS.includes(kind)) {
        fail(scriptId, `persona fact ${i} has kind '${kind}'; known: ${FACT_KINDS.join(', ')}.`);
      }
      return {
        id: fr.id as string,
        statement: fr.statement as string,
        questionnaireAttribute:
          typeof fr.questionnaireAttribute === 'string' ? fr.questionnaireAttribute : 'other',
        kind,
        placeChain: fr.placeChain as ScriptPersona['facts'][number]['placeChain'],
      };
    }),
    topics: topics.map((t, i) => {
      const tr = asRecord(t);
      if (!tr || typeof tr.text !== 'string') fail(scriptId, `persona topic ${i} needs a text.`);
      return { id: typeof tr.id === 'string' ? tr.id : `t${i}`, text: tr.text as string };
    }),
  };
}

function parseTurn(scriptId: string, i: number, raw: unknown, opts: ParseOptions): ScriptTurn {
  const rec = asRecord(raw);
  if (!rec) fail(scriptId, `turn ${i} is not an object.`);
  const user = typeof rec.user === 'string' ? rec.user : undefined;
  const chooses = typeof rec.chooses === 'string' ? rec.chooses : undefined;
  const moreOptions = rec.moreOptions === undefined ? undefined : parseMoreOptions(scriptId, i, rec.moreOptions);
  if ([user, chooses, moreOptions].filter((v) => v !== undefined).length !== 1) {
    fail(scriptId, `turn ${i} must carry exactly one of 'user', 'chooses' or 'moreOptions'.`);
  }

  const pendingCards = rec.pendingCards;
  if (
    pendingCards !== undefined
    && (!Array.isArray(pendingCards) || pendingCards.some((c) => typeof c !== 'string' || c.trim() === ''))
  ) {
    fail(scriptId, `turn ${i} pendingCards must be an array of non-empty statements, or absent.`);
  }

  // A More options tap is scored by its own block, so it may leave `expect` out.
  const ex = asRecord(rec.expect) ?? (moreOptions ? {} : null);
  if (!ex) fail(scriptId, `turn ${i} has no expect block.`);

  // routeKind, skill and legs are optional; a value that IS written must be real.
  const routeKind = typeof ex.routeKind === 'string' ? ex.routeKind : ex.routeKind === undefined ? undefined : '';
  if (routeKind !== undefined && !opts.routeKinds.includes(routeKind)) {
    fail(
      scriptId,
      `turn ${i} expects routeKind '${routeKind}', which the agent core does not export. ` +
        `Known: ${opts.routeKinds.join(', ')}.`,
    );
  }

  const skill = typeof ex.skill === 'string' ? ex.skill : ex.skill === undefined ? undefined : '';
  if (skill !== undefined && !opts.skillIds.includes(skill)) {
    fail(
      scriptId,
      `turn ${i} expects skill '${skill}', which does not exist. ` +
        `Known: ${opts.skillIds.join(', ')}. A renamed or deleted skill must fail here, ` +
        'not score as "wrong id" on every repeat.',
    );
  }

  const legs = typeof ex.legs === 'number' ? ex.legs : ex.legs === undefined ? undefined : NaN;
  if (legs !== undefined && (!Number.isInteger(legs) || legs < 1)) {
    fail(scriptId, `turn ${i} needs an integer expect.legs (exact, not a ceiling).`);
  }

  return {
    index: typeof rec.index === 'number' ? rec.index : i,
    user,
    chooses,
    ...(moreOptions ? { moreOptions } : {}),
    ...(pendingCards !== undefined ? { pendingCards: pendingCards as string[] } : {}),
    expect: {
      ...(routeKind !== undefined ? { routeKind } : {}),
      ...(skill !== undefined ? { skill } : {}),
      tools: asStringArray(ex.tools),
      ...(legs !== undefined ? { legs } : {}),
      endedOn: (ex.endedOn as ScriptTurn['expect']['endedOn']) ?? 'settled',
      proposals: (ex.proposals as ScriptTurn['expect']['proposals']) ?? undefined,
      replyScript: parseReplyScript(scriptId, i, ex.replyScript),
      replyExcludes: parseNeedles(scriptId, i, 'replyExcludes', ex.replyExcludes),
      replyMatches: parseNeedles(scriptId, i, 'replyMatches', ex.replyMatches),
      card: parseCard(scriptId, i, ex.card),
      track: parseTrack(scriptId, i, ex.track),
      offerExcludes: parseNeedles(scriptId, i, 'offerExcludes', ex.offerExcludes),
      ...(ex.noOffer === true ? { noOffer: true as const } : {}),
    },
    fakeTools: parseFakeTools(scriptId, i, rec.fakeTools),
  };
}

function parseCard(scriptId: string, i: number, raw: unknown): ExpectedCard | undefined {
  if (raw === undefined) return undefined;
  const c = asRecord(raw);
  if (!c) fail(scriptId, `turn ${i} expect.card must be an object.`);
  const kinds = c.kinds;
  if (kinds !== undefined) {
    const bad = !Array.isArray(kinds) || kinds.length === 0 || kinds.some((k) => !CARD_ACTION_KINDS.includes(k as never));
    if (bad) fail(scriptId, `turn ${i} expect.card.kinds must be a non-empty list of: ${CARD_ACTION_KINDS.join(', ')}.`);
  }
  if (c.applied !== undefined && typeof c.applied !== 'boolean') {
    fail(scriptId, `turn ${i} expect.card.applied must be a boolean.`);
  }
  if (c.noApply !== undefined && c.noApply !== true) {
    fail(scriptId, `turn ${i} expect.card.noApply can only be true.`);
  }
  if (c.noApply === true && c.applied === true) {
    fail(scriptId, `turn ${i} expect.card asks for applied: true and noApply: true at once.`);
  }
  return {
    ...(kinds !== undefined ? { kinds: kinds as string[] } : {}),
    ...(c.applied !== undefined ? { applied: c.applied as boolean } : {}),
    ...(c.noApply === true ? { noApply: true as const } : {}),
  };
}

function parseReplyScript(scriptId: string, i: number, raw: unknown): ReplyScript | undefined {
  if (raw === undefined) return undefined;
  if (!REPLY_SCRIPTS.includes(raw as ReplyScript)) {
    fail(scriptId, `turn ${i} replyScript '${String(raw)}' is not one of: ${REPLY_SCRIPTS.join(', ')}.`);
  }
  return raw as ReplyScript;
}

/** The reply is lowercased before matching, so an uppercase needle can never
 *  hit: "MB" would fail every reply and "Menu" would pass every one. */
function parseNeedles(scriptId: string, i: number, field: string, raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((x) => typeof x !== 'string' || x === '')) {
    fail(scriptId, `turn ${i} ${field} must be a non-empty array of non-empty strings.`);
  }
  const bad = (raw as string[]).filter((x) => x !== x.toLowerCase());
  if (bad.length > 0) {
    fail(scriptId, `turn ${i} ${field} must be lowercase (the reply is lowercased first): ${bad.join(', ')}.`);
  }
  return raw as string[];
}

function parseFakeTools(scriptId: string, i: number, raw: unknown): ScriptTurn['fakeTools'] {
  const rec = asRecord(raw);
  if (!rec) return undefined;

  const lookup = Array.isArray(rec.lookup_place) ? rec.lookup_place : [];
  const web = Array.isArray(rec.webSearch) ? rec.webSearch : [];
  const webAnswers = web.map((a, j) => {
    const ar = asRecord(a);
    const results = ar && Array.isArray(ar.results) ? ar.results : null;
    if (!ar || !results || results.some((r) => {
      const rr = asRecord(r);
      return !rr || typeof rr.title !== 'string' || typeof rr.url !== 'string' || typeof rr.snippet !== 'string';
    })) {
      fail(scriptId, `turn ${i} webSearch answer ${j} needs results of { title, url, snippet }.`);
    }
    if (ar.query !== undefined && (typeof ar.query !== 'string' || ar.query !== ar.query.toLowerCase())) {
      fail(scriptId, `turn ${i} webSearch answer ${j} query must be a lowercase string, or absent.`);
    }
    return {
      ...(typeof ar.query === 'string' ? { query: ar.query } : {}),
      results: results as { title: string; url: string; snippet: string }[],
    };
  });
  const news = Array.isArray(rec.searchNews) ? rec.searchNews : [];
  const newsAnswers: FakeSearchNewsAnswer[] = news.map((a, j) => {
    const ar = asRecord(a);
    const headlines = ar && Array.isArray(ar.headlines) ? ar.headlines : null;
    if (!ar || !headlines || headlines.some((h) => typeof h !== 'string' || h === '')) {
      fail(scriptId, `turn ${i} searchNews answer ${j} needs headlines, a list of non-empty strings.`);
    }
    if (ar.query !== undefined && (typeof ar.query !== 'string' || ar.query !== ar.query.toLowerCase())) {
      fail(scriptId, `turn ${i} searchNews answer ${j} query must be a lowercase string, or absent.`);
    }
    return { ...(typeof ar.query === 'string' ? { query: ar.query } : {}), headlines: headlines as string[] };
  });
  const similar = Array.isArray(rec.find_similar_facts) ? rec.find_similar_facts : [];

  const lookupAnswers: FakeLookupPlaceAnswer[] = lookup.map((a, j) => {
    const ar = asRecord(a);
    if (!ar || typeof ar.query !== 'string') {
      fail(scriptId, `turn ${i} lookup_place answer ${j} needs a query.`);
    }
    if (!asRecord(ar.returns)) {
      fail(scriptId, `turn ${i} lookup_place answer ${j} needs a returns object.`);
    }
    return { query: ar.query as string, returns: ar.returns as FakeLookupPlaceAnswer['returns'] };
  });

  const similarAnswers: FakeSimilarFactsAnswer[] = similar.map((a, j) => {
    const ar = asRecord(a);
    if (!ar) fail(scriptId, `turn ${i} find_similar_facts answer ${j} is not an object.`);
    // The tool takes NO query and NO statement (S2). A fixture still carrying
    // one was written against the pre-freeze contract, and accepting it would
    // let the privacy removal quietly regress with nothing failing.
    if ('query' in ar || 'statement' in ar) {
      fail(
        scriptId,
        `turn ${i} find_similar_facts answer ${j} carries a query/statement. The tool takes ` +
          'neither (S2: no persona text in cleartext). Key on kind instead, or null for any kind.',
      );
    }
    const kind = ar.kind === null || ar.kind === undefined ? null : (ar.kind as FactKind);
    if (kind !== null && !FACT_KINDS.includes(kind)) {
      fail(scriptId, `turn ${i} find_similar_facts answer ${j} has kind '${String(kind)}'.`);
    }
    if (!asRecord(ar.returns)) {
      fail(scriptId, `turn ${i} find_similar_facts answer ${j} needs a returns object.`);
    }
    return { kind, returns: ar.returns as FakeSimilarFactsAnswer['returns'] };
  });

  return {
    lookup_place: lookupAnswers.length > 0 ? lookupAnswers : undefined,
    find_similar_facts: similarAnswers.length > 0 ? similarAnswers : undefined,
    webSearch: webAnswers.length > 0 ? webAnswers : undefined,
    searchNews: newsAnswers.length > 0 ? newsAnswers : undefined,
  };
}

/**
 * A fake answer no turn can reach is a fixture that has stopped testing what it
 * claims to. It never throws at run time and never shows up in a report, so it
 * is caught here: every turn carrying a `lookup_place` answer must also expect
 * `lookup_place` among its tools, and likewise for `find_similar_facts`.
 */
function assertEveryFakeAnswerIsReachable(scriptId: string, turns: ScriptTurn[]): void {
  for (const turn of turns) {
    const ft = turn.fakeTools;
    if (!ft) continue;
    if (ft.lookup_place && !turn.expect.tools.includes('lookup_place')) {
      fail(
        scriptId,
        `turn ${turn.index} scripts ${ft.lookup_place.length} lookup_place answer(s) but does not ` +
          'expect that tool, so no call can ever reach them.',
      );
    }
    if (ft.searchNews && !turn.expect.tools.includes('searchNews')) {
      fail(
        scriptId,
        `turn ${turn.index} scripts ${ft.searchNews.length} searchNews answer(s) but does not ` +
          'expect that tool, so no call can ever reach them.',
      );
    }
    if (ft.find_similar_facts && !turn.expect.tools.includes('find_similar_facts')) {
      fail(
        scriptId,
        `turn ${turn.index} scripts ${ft.find_similar_facts.length} find_similar_facts answer(s) ` +
          'but does not expect that tool, so no call can ever reach them.',
      );
    }
  }
}
