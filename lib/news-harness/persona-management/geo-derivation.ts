// news-harness — ongoing fact → country derivation (PURE, RN-free).
//
// The persona-v3 silent migration (persona-migration.ts) is a RUN-ONCE job, so
// after it completes no fact ever produces a `locations` row again. This module
// is the pure core of the recurring sweep that fixes that
// (lib/database/services/geo-derivation-service.ts is the WatermelonDB adapter).
//
// Two tiers:
//   • TIER 1 — deterministic rules, offline, no allowed-enum gate behind them.
//     Because a tier-1 hit ships straight to the Explore pills with nothing to
//     catch a false positive, POSITION decides which resolver is allowed:
//
//       position                          | resolvers allowed
//       ----------------------------------|----------------------------------
//       terminal segment of a comma chain | curated map ∪ FULL ISO name set
//       right after a place preposition   | curated ∪ DEMONYMS ∪ full ISO,
//                                         |   minus AMBIGUOUS_NAMES
//       anywhere else (free position)     | curated ∪ DEMONYMS,
//                                         |   minus AMBIGUOUS_NAMES
//
//     Scanning the full ISO name set in a free position is what turns
//     "My friend Jordan moved to Austin" into JO and "Grew up in Georgia" into
//     GE — Chad / Mali / Niger / Guinea / Turkey / Jersey all collide with
//     ordinary words and given names too. AMBIGUOUS_NAMES additionally blocks
//     those specific names in the ANCHORED position, because a place
//     preposition alone does not disambiguate them ("Grew up in Georgia" is
//     anchored and still means the US state far more often than the country).
//     Every blocked case simply falls through to tier 2, which IS gated.
//
//   • TIER 2 — batched LLM calls over the facts whose PLACE is due
//     (`selectFactsForPlaces`) plus whatever tier 1 could not resolve. Names in,
//     names out: each answer is a fact place (level + names), and, when the fact
//     names the place itself, a `locations` candidate whose country must be in
//     the server's allowed-country enum, so the model cannot invent a country
//     we have no feeds for.
//
// Reconciliation is ADDITIVE ONLY: it never emits a delete and never emits any
// op against a row the user owns (`provenance` 'user' or 'feedback').
//
// RN-free by contract: no react-native, no @nozbe/watermelondb, no expo imports
// (roles are typed with `MigrationLocationRole`, NOT the WatermelonDB model's
// `LocationRole`).

import countries from 'i18n-iso-countries';
import enCountryNames from 'i18n-iso-countries/langs/en.json';
import {
  inferLocationRole,
  parseLocationFromStatement,
  resolveCountryCode,
  MIGRATION_ROLE_WEIGHTS,
  type MigrationLocationRole,
} from './persona-migration';
import {
  DEMONYMS,
  describePlace,
  factPlacesBy,
  normalizePlaces,
  parsePlace,
  placeFromNames,
  placesSourceHash,
  type FactPlacesInput,
  type ReaderPlace,
} from './fact-places';

countries.registerLocale(enCountryNames);

// ── Public shapes ─────────────────────────────────────────────────────────

/** Role union for derived places. Deliberately the harness's own union — the
 *  WatermelonDB `LocationRole` lives behind a `@nozbe/watermelondb` import. */
export type GeoRole = MigrationLocationRole;

export interface GeoFactSnapshot {
  id: string;
  statement: string;
}

export interface GeoCandidate {
  /** ISO 3166-1 alpha-2, upper-cased. */
  countryCode: string;
  city: string | null;
  region: string | null;
  role: GeoRole;
  weight: number;
  sourceFactId: string;
}

export interface ExistingGeoRow {
  id: string;
  countryCode: string;
  city: string | null;
  role: GeoRole;
  weight: number;
  provenance: 'llm' | 'user' | 'feedback' | 'migration';
}

export type GeoOp =
  | { kind: 'add'; candidate: GeoCandidate }
  | { kind: 'setWeight'; locationId: string; weight: number };

// ── Tier-1 vocabulary ─────────────────────────────────────────────────────

// DEMONYMS lives in fact-places.ts (shared with countriesNamedIn).

/**
 * Country names that are ALSO a common English noun, a US state, or a common
 * given/surname. Blocked outside a comma chain — in an anchored or free
 * position they are far more likely to be the other thing. The cost is recall
 * ("Lives in Turkey" falls through), and the fallthrough target is tier 2,
 * which is gated by the server's allowed-country enum. That trade is
 * deliberate: tier 1 has no gate behind it.
 */
// `india`, `china`, `israel`, `england` are deliberately NOT here: they are
// occasionally names too, but the recall they carry far outweighs the collision.
const AMBIGUOUS_NAMES: ReadonlySet<string> = new Set([
  'georgia', // US state (the Georgia gate)
  'jordan', // given name / surname
  'chad', // given name
  'turkey', // the bird
  'chile', // chili
  'mali', 'niger', 'guinea', // given names; "guinea pig"
  'jersey', // US NJ / the garment
  'reunion', // the event
  'us', // the pronoun ("one of us", "sent to us")
]);

/**
 * Words that, immediately after a demonym, mean the fact is about a language
 * or a cuisine rather than a place ("Loves Thai food"). Cheap noise filter for
 * the single highest-volume false-positive class in the demonym scan.
 */
const DEMONYM_STOP_CONTEXT: ReadonlySet<string> = new Set([
  'food', 'foods', 'cuisine', 'cooking', 'recipe', 'recipes', 'dish', 'dishes',
  'restaurant', 'restaurants', 'takeaway', 'takeout',
  'language', 'languages', 'lesson', 'lessons', 'class', 'classes',
  'speaker', 'speakers', 'speaking', 'grammar', 'accent',
  'wine', 'wines', 'beer', 'coffee', 'tea', 'cheese', 'chocolate',
]);

/** Place prepositions — same set as the migration's anchor regex (:209). */
const ANCHOR_RE = /\b(?:in|at|to|near|from|of)\b\s+/gi;

/** A clause boundary ends the place phrase an anchor introduces. */
const CLAUSE_BREAK_RE = /[,;:.!?]/;

/** Longest curated / demonym key is 4 words ("united states of america"). */
const MAX_NGRAM_WORDS = 4;

/** Role → precedence when two facts name the same country differently. */
const ROLE_PRIORITY: Record<GeoRole, number> = {
  home: 6,
  work: 5,
  family: 4,
  partner_family: 3,
  travel: 2,
  interest: 1,
};

// ── Resolvers ─────────────────────────────────────────────────────────────

function normalizeTerm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/'s\b/g, '')
    .replace(/[^a-zÀ-ɏ\s-]/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isoAlpha2(term: string): string | null {
  if (!term) return null;
  const code = countries.getAlpha2Code(term, 'en');
  return code ? code.toUpperCase() : null;
}

/** Terminal segment of a comma chain — the one unambiguous place position. */
function resolveChainSegment(segment: string): string | null {
  return resolveCountryCode(segment) ?? isoAlpha2(normalizeTerm(segment));
}

/** Immediately after a place preposition. Full ISO, minus the ambiguous names. */
function resolveAnchoredTerm(term: string): string | null {
  if (!term || AMBIGUOUS_NAMES.has(term)) return null;
  return resolveCountryCode(term) ?? DEMONYMS[term] ?? isoAlpha2(term);
}

/** Free position. Curated + demonyms only, minus the ambiguous names. */
function resolveFreeTerm(term: string): string | null {
  if (!term || AMBIGUOUS_NAMES.has(term)) return null;
  return resolveCountryCode(term) ?? DEMONYMS[term] ?? null;
}

function toWords(s: string): string[] {
  const t = normalizeTerm(s);
  return t ? t.split(' ').filter(Boolean) : [];
}

/**
 * Anchored scan. For every place preposition we take the clause that follows
 * and test its 1..4-word LEADING prefixes, so "Moved to Kazakhstan last year"
 * still resolves KZ. A leading article is skipped ("in the Netherlands").
 * `lastIndex` advances past the preposition only, so a later anchor inside the
 * same clause is still tried ("Works at a startup in Germany").
 */
function scanAnchored(statement: string): string | null {
  ANCHOR_RE.lastIndex = 0;
  while (ANCHOR_RE.exec(statement) !== null) {
    const clause = statement.slice(ANCHOR_RE.lastIndex).split(CLAUSE_BREAK_RE)[0];
    const words = toWords(clause);
    if (words.length === 0) continue;
    const starts = words[0] === 'the' ? [0, 1] : [0];
    for (const start of starts) {
      for (let n = Math.min(MAX_NGRAM_WORDS, words.length - start); n >= 1; n--) {
        const code = resolveAnchoredTerm(words.slice(start, start + n).join(' '));
        if (code) return code;
      }
    }
  }
  return null;
}

/** Free-position scan over every 1..4-word n-gram of the statement. */
function scanFree(statement: string): string | null {
  const words = toWords(statement);
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(MAX_NGRAM_WORDS, words.length - i); n >= 1; n--) {
      const term = words.slice(i, i + n).join(' ');
      const code = resolveFreeTerm(term);
      if (!code) continue;
      // Demonym hits are dropped when the next word makes it a language/cuisine.
      const isDemonymOnly = DEMONYMS[term] !== undefined && resolveCountryCode(term) === null;
      if (isDemonymOnly && DEMONYM_STOP_CONTEXT.has(words[i + n] ?? '')) continue;
      return code;
    }
  }
  return null;
}

// ── Tier 1 ────────────────────────────────────────────────────────────────

/**
 * Deterministic pass. At most ONE candidate per fact (same as the migration),
 * chosen by the first position tier that resolves: comma chain → anchored →
 * free. Facts that resolve nothing are returned for tier 2.
 */
export function deriveCountriesFromFacts(facts: GeoFactSnapshot[]): {
  resolved: GeoCandidate[];
  unresolved: GeoFactSnapshot[];
} {
  const resolved: GeoCandidate[] = [];
  const unresolved: GeoFactSnapshot[] = [];

  for (const fact of facts) {
    const statement = (fact.statement ?? '').trim();
    if (!statement) continue;

    const role = inferLocationRole(statement);
    const weight = MIGRATION_ROLE_WEIGHTS[role];

    // 1. Comma chain — reuses the migration's chain walk with the wider
    //    resolver injected (terminal-segment position is unambiguous).
    const chained = parseLocationFromStatement(statement, resolveChainSegment);
    if (chained) {
      resolved.push({
        countryCode: chained.countryCode.toUpperCase(),
        city: chained.city,
        region: chained.region,
        role,
        weight,
        sourceFactId: fact.id,
      });
      continue;
    }

    // 2 + 3. Country-only candidates from the anchored, then free, scans.
    const code = scanAnchored(statement) ?? scanFree(statement);
    if (code) {
      resolved.push({
        countryCode: code.toUpperCase(),
        city: null,
        region: null,
        role,
        weight,
        sourceFactId: fact.id,
      });
      continue;
    }

    unresolved.push({ id: fact.id, statement });
  }

  return { resolved, unresolved };
}

// ── Tier 2 — one LLM call that places every due fact (names only) ─────────
//
// The call decides, per fact, WHERE its news should come from and at which
// level (fact places), and, when the fact itself names a place, how that place
// relates to the reader (a `locations` candidate, the old tier 2). Names in,
// names out: the model never sees or writes a code; `placeFromNames` decodes.

/** One fact sent to the model. `rejected` are places the reader called wrong. */
export interface FactPlacesBatchFact {
  id: string;
  statement: string;
  rejected: string[];
}

export interface DecodedFactPlace {
  factId: string;
  /** [] when the model answered with a place the reader rejected or with nothing usable. */
  places: string[];
  location: GeoCandidate | null;
}

/** Facts whose place must be (re)decided: never a user's choice; a changed
 *  statement or residence (places_source), or a wrong-place mark. */
export function selectFactsForPlaces(
  facts: readonly (FactPlacesInput & { id: string })[],
  locations: readonly ReaderPlace[],
): string[] {
  return facts
    .filter((f) => factPlacesBy(f) !== 'user')
    .filter(
      (f) =>
        f.metadata?.places_wrong !== undefined ||
        f.metadata?.places_source !== placesSourceHash(f.statement, locations),
    )
    .map((f) => f.id);
}

/** The place call's gear, shared by the sweep and the tuning eval so they
 *  cannot drift. Output is bounded BY CONSTRUCTION: one named answer is ~50
 *  tokens, so perCall * 50 stays under maxTokens; a truncated reply loses the
 *  whole call and its facts stay due. */
export const FACT_PLACES_CALL = { perCall: 10, maxTokens: 700, temperature: 0.2 } as const;

const MAX_CONTEXT_FACTS = 40;
const MAX_CONTEXT_CHARS = 160;

const FACT_PLACES_SYSTEM_PROMPT = [
  'You decide where the news for each of a reader\'s interests should come from.',
  'You get the places the reader lives and works, everything they told Mera, and a numbered list of facts.',
  'For each fact pick ONE place and its level:',
  '  • "anywhere": the subject is the same news wherever you read it: a science, a technology, a field or',
  '    profession followed for its own sake, a hobby, a cuisine, world markets. "Follows climate science": anywhere.',
  '  • "bloc": a group of countries: European Union, Europe, Asia, Africa, North America, South America or Oceania.',
  '    A part of a continent ("West Africa", "Southeast Asia") is a bloc too. "Works in EU trade law": European Union.',
  '  • "country": the subject is decided by one country: its laws, taxes, prices, wages, pensions, benefits,',
  '    schools, health care, visas, national industries and jobs whose pay and rules the country sets, a national league.',
  '    "Pensioner" for a reader in Bhopal: India.',
  '  • "region": decided by a state, province or county government. "State government jobs" for a reader in Bhopal:',
  '    Madhya Pradesh. A region is always a subdivision INSIDE the country, never part of a continent.',
  '  • "city": the subject physically happens in one town: its water, power, transport, traffic, rents, weather,',
  '    a local club. "Worried about water cuts" for a reader in Bhopal: Bhopal.',
  'How to choose:',
  '  1. A place the fact names itself wins: "Daughter studies in London" is London even when the reader lives elsewhere.',
  '  2. Otherwise first ask whether the subject is the same news everywhere. If so, answer anywhere, wherever the reader lives.',
  '  3. If it is local to the reader, use the reader\'s own place at the level where the subject is DECIDED, not where the',
  '     reader happens to live: a job, a farm, a school, a visa or a shop is decided by the country unless the fact says more.',
  '     When unsure between two levels, pick the wider one.',
  '  4. A nationality or cuisine used as an adjective ("Greek cooking", "Japanese films") does not name a place. Working',
  '     for a foreign or remote employer does not move the subject.',
  '  5. A team, league or competition is news where it plays: a club\'s city, a league\'s country, a contest between',
  '     countries of one bloc is that bloc.',
  'Never pick a place the reader said was wrong for that fact.',
  'Write every place as its English name, never as a code. Fill "country" for city and region; "region" may be null for a city.',
  '"role" only when the fact itself names the place: "home", "work", "family", "partner_family", "travel" or "interest". Otherwise null.',
  'Answer every fact once and reuse the given ids exactly.',
  '',
  'Respond with STRICT JSON only, no prose:',
  '{"facts":[{"id":"<id>","level":"city","bloc":null,"country":"India","region":"Madhya Pradesh","city":"Bhopal","role":null}]}',
].join('\n');

function readerPlaceName(l: ReaderPlace): string | null {
  const cc = (l.countryCode ?? '').trim().toUpperCase();
  const city = (l.city ?? '').trim();
  const region = (l.region ?? '').trim();
  const code = city ? `${cc}|${region}|${city}` : region ? `${cc}|${region}` : cc;
  return describePlace(code);
}

/** The single batched request. Places travel as names; ids are fact ids. */
export function buildFactPlacesRequest(input: {
  batch: readonly FactPlacesBatchFact[];
  otherFacts: readonly string[];
  readerPlaces: readonly ReaderPlace[];
}): { systemPrompt: string; prompt: string } {
  const placeLines = input.readerPlaces
    .map((l) => {
      const name = readerPlaceName(l);
      return name ? `- ${name} (${l.role})` : null;
    })
    .filter((l): l is string => !!l);
  const contextLines = input.otherFacts
    .slice(0, MAX_CONTEXT_FACTS)
    .map((s) => `- ${s.trim().slice(0, MAX_CONTEXT_CHARS)}`);
  const factLines = input.batch.map((f) => {
    const rejected = f.rejected.map(describePlace).filter((n): n is string => !!n);
    const note = rejected.length > 0 ? ` (the reader said this place is wrong: ${rejected.join('; ')})` : '';
    return `[${f.id}] ${f.statement}${note}`;
  });
  return {
    systemPrompt: FACT_PLACES_SYSTEM_PROMPT,
    prompt: [
      'Reader\'s places:',
      ...(placeLines.length > 0 ? placeLines : ['- none known']),
      '',
      'Everything the reader told Mera:',
      ...(contextLines.length > 0 ? contextLines : ['- nothing else']),
      '',
      'Facts to place:',
      ...factLines,
    ].join('\n'),
  };
}

const VALID_ROLES: ReadonlySet<string> = new Set<GeoRole>([
  'home', 'work', 'travel', 'family', 'partner_family', 'interest',
]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Decodes the model's JSON. A malformed reply → []. Rows with an id outside the
 * batch, a repeated id, or names that do not resolve are dropped. A rejected
 * place decodes to `places: []`. A `locations` candidate needs a named role and
 * a country inside `allowedAlpha2`.
 */
export function decodeFactPlaces(
  raw: string,
  batch: readonly FactPlacesBatchFact[],
  allowedAlpha2: ReadonlySet<string>,
): DecodedFactPlace[] {
  const match = (raw ?? '').trim().match(/\{[\s\S]*\}/);
  if (!match) return [];
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(JSON.parse(match[0]));
  } catch {
    return [];
  }
  const rows = root && Array.isArray(root.facts) ? root.facts : null;
  if (!rows) return [];

  const byId = new Map(batch.map((f) => [f.id, f]));
  const out: DecodedFactPlace[] = [];
  for (const row of rows) {
    const rec = asRecord(row);
    const id = typeof rec?.id === 'string' ? rec.id : null;
    const fact = id ? byId.get(id) : undefined;
    if (!rec || !id || !fact || out.some((o) => o.factId === id)) continue;
    const place = placeFromNames(rec);
    if (!place) continue;
    const rejected = normalizePlaces(fact.rejected).includes(place);

    let location: GeoCandidate | null = null;
    const parsed = parsePlace(place);
    const role = typeof rec.role === 'string' ? rec.role.trim().toLowerCase() : '';
    if (!rejected && parsed?.country && VALID_ROLES.has(role) && allowedAlpha2.has(parsed.country)) {
      location = {
        countryCode: parsed.country,
        city: parsed.city ?? null,
        region: parsed.region ?? null,
        role: role as GeoRole,
        weight: MIGRATION_ROLE_WEIGHTS[role as GeoRole],
        sourceFactId: id,
      };
    }
    out.push({ factId: id, places: rejected ? [] : [place], location });
  }
  return out;
}

// ── Reconcile ─────────────────────────────────────────────────────────────

const WEIGHT_EPSILON = 1e-6;

/** Collapse candidates to one per country — strongest role wins, then weight.
 *  Without this, two facts naming the same country emit two adds → two pills. */
function collapseByCountry(candidates: GeoCandidate[]): GeoCandidate[] {
  const best = new Map<string, GeoCandidate>();
  for (const c of candidates) {
    const key = c.countryCode.toUpperCase();
    const current = best.get(key);
    if (
      !current ||
      ROLE_PRIORITY[c.role] > ROLE_PRIORITY[current.role] ||
      (ROLE_PRIORITY[c.role] === ROLE_PRIORITY[current.role] && c.weight > current.weight)
    ) {
      best.set(key, { ...c, countryCode: key });
    }
  }
  return Array.from(best.values());
}

/**
 * Additive, non-destructive plan.
 *  • A country with no existing row → `add`.
 *  • A country whose rows include ANY `provenance` 'user' or 'feedback' row →
 *    NO op at all. The user owns that country; the sweep does not touch it.
 *  • A country held only by 'llm'/'migration' rows whose inferred weight moved
 *    → `setWeight` on the heaviest of them.
 *  • NEVER a delete.
 */
export function reconcileGeoPlan(
  existing: ExistingGeoRow[],
  candidates: GeoCandidate[],
): GeoOp[] {
  const byCountry = new Map<string, ExistingGeoRow[]>();
  for (const row of existing) {
    const key = (row.countryCode ?? '').toUpperCase();
    const list = byCountry.get(key);
    if (list) list.push(row);
    else byCountry.set(key, [row]);
  }

  const ops: GeoOp[] = [];
  for (const candidate of collapseByCountry(candidates)) {
    const rows = byCountry.get(candidate.countryCode);
    if (!rows || rows.length === 0) {
      ops.push({ kind: 'add', candidate });
      continue;
    }
    // User-owned country → hands off entirely.
    if (rows.some((r) => r.provenance === 'user' || r.provenance === 'feedback')) {
      continue;
    }
    const target = rows.reduce((a, b) => (b.weight > a.weight ? b : a));
    if (Math.abs(target.weight - candidate.weight) > WEIGHT_EPSILON) {
      ops.push({ kind: 'setWeight', locationId: target.id, weight: candidate.weight });
    }
  }
  return ops;
}
