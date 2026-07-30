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
//   • TIER 2 — one batched LLM call over whatever tier 1 could not resolve
//     (cities like "Bangalore", leagues, employers). Every code it returns is
//     validated against the server's allowed-country enum and silently dropped
//     otherwise, so the model cannot invent a country we have no feeds for.
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

/**
 * Nationality/adjectival forms → alpha-2. The curated country-name map only
 * matches nouns, so "Follows Brazilian football" resolves nothing without this.
 * Hand-curated, therefore allowed in a free position.
 */
const DEMONYMS: Record<string, string> = {
  'dutch': 'NL', 'german': 'DE', 'french': 'FR', 'spanish': 'ES',
  'portuguese': 'PT', 'italian': 'IT', 'belgian': 'BE', 'austrian': 'AT',
  'swiss': 'CH', 'british': 'GB', 'english': 'GB', 'scottish': 'GB',
  'welsh': 'GB', 'irish': 'IE', 'polish': 'PL', 'ukrainian': 'UA',
  'russian': 'RU', 'czech': 'CZ', 'slovak': 'SK', 'hungarian': 'HU',
  'romanian': 'RO', 'bulgarian': 'BG', 'greek': 'GR', 'turkish': 'TR',
  'swedish': 'SE', 'norwegian': 'NO', 'danish': 'DK', 'finnish': 'FI',
  'icelandic': 'IS', 'estonian': 'EE', 'latvian': 'LV', 'lithuanian': 'LT',
  'croatian': 'HR', 'serbian': 'RS', 'slovenian': 'SI',
  'american': 'US', 'canadian': 'CA', 'mexican': 'MX', 'brazilian': 'BR',
  'argentine': 'AR', 'argentinian': 'AR', 'chilean': 'CL', 'colombian': 'CO',
  'peruvian': 'PE', 'uruguayan': 'UY',
  'indian': 'IN', 'chinese': 'CN', 'japanese': 'JP', 'korean': 'KR',
  'south korean': 'KR', 'indonesian': 'ID', 'thai': 'TH', 'vietnamese': 'VN',
  'filipino': 'PH', 'philippine': 'PH', 'malaysian': 'MY', 'singaporean': 'SG',
  'taiwanese': 'TW', 'pakistani': 'PK', 'bangladeshi': 'BD',
  'sri lankan': 'LK', 'nepali': 'NP', 'nepalese': 'NP',
  'israeli': 'IL', 'saudi': 'SA', 'emirati': 'AE', 'qatari': 'QA',
  'kuwaiti': 'KW', 'jordanian': 'JO', 'lebanese': 'LB', 'iranian': 'IR',
  'iraqi': 'IQ', 'egyptian': 'EG', 'nigerian': 'NG', 'south african': 'ZA',
  'kenyan': 'KE', 'ethiopian': 'ET', 'ghanaian': 'GH', 'moroccan': 'MA',
  'tunisian': 'TN', 'algerian': 'DZ', 'tanzanian': 'TZ', 'ugandan': 'UG',
  'australian': 'AU', 'new zealander': 'NZ',
};

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
  home: 5,
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

// ── Tier 2 — LLM for the leftovers ────────────────────────────────────────

/** Inline the allowed enum only when it is short enough to be worth the tokens.
 *  The real gate is parse-side (`parseGeoLlmResponse`), so a long list would
 *  burn ~600 tokens of a 4096-token context for nothing. */
const ALLOWED_ENUM_INLINE_MAX = 30;

const GEO_SYSTEM_PROMPT_LINES = [
  'You infer which COUNTRY each short personal fact refers to.',
  'The facts describe ONE person. A fact may name a city, a region, an employer,',
  'a sports league or a nationality — infer the country it implies.',
  '',
  'Rules:',
  '  • One entry per fact you are confident about. SKIP a fact entirely when it',
  '    implies no specific country (e.g. "Enjoys hiking"). Skipping is correct.',
  '  • "country" MUST be an ISO 3166-1 alpha-2 code (two uppercase letters).',
  '  • "role" is how the place relates to the person: "home" (lives there),',
  '    "family" (relatives there), "partner_family", "travel" (visits), or',
  '    "interest" (follows it from afar). Use "interest" when unsure.',
  '  • "city" is a city named in the fact, otherwise null.',
  '  • Reuse the given ids EXACTLY. Never invent an id and never invent a fact.',
  '',
  'Respond with STRICT JSON only, no prose:',
  '{"locations":[{"id":"<id>","country":"NL","city":"Amsterdam","role":"home"}]}',
];

/**
 * Builds the single batched call for the unresolved facts. `allowedAlpha2` is
 * inlined only for a short enum; it is ENFORCED in `parseGeoLlmResponse`.
 */
export function buildGeoLlmRequest(
  unresolved: GeoFactSnapshot[],
  allowedAlpha2: ReadonlySet<string>,
): { systemPrompt: string; prompt: string } {
  const lines = [...GEO_SYSTEM_PROMPT_LINES];
  if (allowedAlpha2.size > 0 && allowedAlpha2.size <= ALLOWED_ENUM_INLINE_MAX) {
    lines.push('', `Valid codes: ${Array.from(allowedAlpha2).sort().join(', ')}`);
  }
  return {
    systemPrompt: lines.join('\n'),
    prompt: unresolved.map((f) => `[${f.id}] ${f.statement}`).join('\n'),
  };
}

const VALID_ROLES: ReadonlySet<string> = new Set<GeoRole>([
  'home', 'travel', 'family', 'partner_family', 'interest',
]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asNullableString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Defensively decodes the model's JSON. Any malformed response → `[]` (tier-1
 * only). Entries are dropped when the id was not in the batch, when the code is
 * not two letters, or when the code is not in `allowedAlpha2` — the model can
 * never introduce a country the server has no feeds for.
 */
export function parseGeoLlmResponse(
  raw: string,
  unresolved: GeoFactSnapshot[],
  allowedAlpha2: ReadonlySet<string>,
): GeoCandidate[] {
  const match = (raw ?? '').trim().match(/\{[\s\S]*\}/);
  if (!match) return [];
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(JSON.parse(match[0]));
  } catch {
    return [];
  }
  if (!root) return [];

  const rows = Array.isArray(root.locations)
    ? root.locations
    : Array.isArray(root.results)
      ? root.results
      : null;
  if (!rows) return [];

  const byId = new Map(unresolved.map((f) => [f.id, f.statement]));
  const seen = new Set<string>();
  const out: GeoCandidate[] = [];

  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec) continue;
    const id = typeof rec.id === 'string' ? rec.id : null;
    if (!id || seen.has(id)) continue;
    const statement = byId.get(id);
    if (statement === undefined) continue;

    const rawCode = typeof rec.country === 'string' ? rec.country.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(rawCode)) continue;
    if (!allowedAlpha2.has(rawCode)) continue;

    const rawRole = typeof rec.role === 'string' ? rec.role.trim().toLowerCase() : '';
    const role: GeoRole = VALID_ROLES.has(rawRole)
      ? (rawRole as GeoRole)
      : inferLocationRole(statement);

    seen.add(id);
    out.push({
      countryCode: rawCode,
      city: asNullableString(rec.city),
      region: asNullableString(rec.region),
      role,
      weight: MIGRATION_ROLE_WEIGHTS[role],
      sourceFactId: id,
    });
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
