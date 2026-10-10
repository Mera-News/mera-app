// mera-harness/core: normalising the facts a model proposes (third person, exact keys,
// combined origin/home split, home chains, delete targets). PURE, RN-free.
// Split out of core.ts; the loop calls these from its save and delete legs.

import { comparableStatement } from './prose';
import { isLocationKey, isRelationalStatement, mayReplace } from './fact-subject';
import {
  CANONICAL_LOCATION_KEY,
  COMBINED_ORIGIN_KEY,
  EXPAT_KEY,
  ORIGIN_KEY,
  countryOf,
  expatStatement,
  toOriginStatement,
  isCombinedOriginFact,
  isExpatStatement,
  isOriginStatement,
  originCountry,
  sameCountry,
  threeFactsOf,
} from './combined-fact';
import type { AgentPersonaFact } from './core';
import type { Place } from './types';

/**
 * First-person statements rewritten as facts. Measured on staging: "I am an
 * expat from India", "I live in Nieuw-West, Amsterdam", "Moved to Berlin, ...
 * last month". A fact names the user in the third person and a home is
 * "Lives in ...", or none of the loop's rules recognise it.
 */
export function asThirdPersonFact(entry: Record<string, unknown>): Record<string, unknown> {
  let t = typeof entry.statement === 'string' ? entry.statement.trim() : '';
  if (!t) return entry;
  t = t.replace(/^(?:i\s+am|i['’]m|im)\s+(?:an?\s+)?/i, '');
  // "User is an expat ...", "The user lives in ...", "Is an expat from
  // India" (all measured on staging). Stripped only when what is left is a
  // home, an origin or an expat status, so no other fact's wording changes.
  const bare = t.replace(/^(?:(?:the\s+)?user\s+)?(?:is\s+(?:an?\s+)?)?/i, '');
  if (bare !== t && (
    isOriginStatement(bare) || isExpatStatement(bare) || /^expat\b/i.test(bare)
    || /^(?:(?:have\s+|recently\s+)?moved|live|lives|living|reside|resides)\s+(?:in|to)\s/i.test(bare)
  )) t = bare;
  const home = /^(?:i\s+)?(?:(?:have\s+|recently\s+)?moved|live|lives|living|reside|resides)\s+(?:in|to)\s+(.+)$/i.exec(t);
  if (home) {
    const where = home[1]
      .replace(/\s+(?:last\s+(?:week|month|year)|this\s+(?:month|year)|recently|a\s+few\s+(?:weeks|months|years)\s+ago)\.?$/i, '')
      .replace(/\.$/, '');
    t = `Lives in ${where}`;
    // "Nieuw-West, Amsterdam (North Holland, The Netherlands)": the chain is
    // written in the comma form (measured on staging).
    t = collapseRepeatedRungs(t.replace(/\s*\(([^()]+)\)\s*$/, ', $1'));
  } else {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t === entry.statement ? entry : { ...entry, statement: t };
}

/** "Lives in <what the user said>, <region>, <country>, <bloc>": the user's
 *  own first rung is kept when it is finer than the locality (a
 *  neighbourhood), then the looked-up chain. */
export function chainStatement(where: string, place: Place): string {
  const first = where.split(',')[0].trim();
  const own = (r: string | undefined) => !!r && first.toLowerCase() === r.toLowerCase();
  const rungs = [
    own(place.locality) || own(place.userTerm) ? null : first,
    // THE USER'S TERM FIRST when it matched only an alias (ux2 D13): "Porto
    // Santo" resolves to Vila Baleira, and a chain without it names a place the
    // user never said, so no topic ever mentions Porto Santo.
    place.userTerm ? `${place.userTerm} (${place.locality})` : place.locality,
    place.admin1,
    place.countryName,
    place.bloc,
  ].filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  return collapseRepeatedRungs(`Lives in ${rungs.join(', ')}`);
}

/** Append "Expat in <country>" for an origin entry when the user's current
 *  country is known and differs, unless one is already offered or on file. */
export function addExpatStatus(
  list: Record<string, unknown>[],
  facts: AgentPersonaFact[],
  known: readonly Place[],
): void {
  const origin = list.find((e) => e.questionnaire_attribute === ORIGIN_KEY);
  if (!origin) return;
  if (list.some((e) => e.questionnaire_attribute === EXPAT_KEY)) return;
  if (facts.some((f) => f.attribute === EXPAT_KEY || isExpatStatement(f.statement))) return;
  const homeEntry = list.find((e) => isHomeEntry(e));
  const homeFact = facts.find(
    (f) => isLocationKey(f.attribute) && !isRelationalStatement(f.statement),
  );
  const country = homeEntry
    ? countryOf(String(homeEntry.statement), known)
    : homeFact
      ? countryOf(homeFact.statement, known)
      : null;
  if (!country || sameCountry(country, originCountry(String(origin.statement)))) return;
  list.push({ statement: expatStatement(country), questionnaire_attribute: EXPAT_KEY });
}

/**
 * A combined origin-and-home entry from the model, expanded into its separate
 * facts; any other entry unchanged. A `replaces` on the combined entry goes
 * with the residence part, the only part that can replace a home.
 */
export function expandCombinedEntry(
  entry: Record<string, unknown>,
  known: readonly Place[],
): Record<string, unknown>[] {
  const statement = typeof entry.statement === 'string' ? entry.statement : '';
  const attribute = typeof entry.questionnaire_attribute === 'string' ? entry.questionnaire_attribute : '';
  const looksCombined =
    attribute.trim().toLowerCase() === COMBINED_ORIGIN_KEY
    || /\b(?:expat|migrant|immigrant|originally|from)\b[^,]*\b(?:living|based|settled|residing)\s+in\b/i.test(statement);
  const parts = looksCombined ? threeFactsOf(statement, known) : null;
  if (!parts) return [entry];
  const out: Record<string, unknown>[] = [
    { statement: parts.origin, questionnaire_attribute: ORIGIN_KEY },
  ];
  if (parts.expat) out.push({ statement: parts.expat, questionnaire_attribute: EXPAT_KEY });
  out.push({
    statement: parts.residence,
    questionnaire_attribute: CANONICAL_LOCATION_KEY,
    ...(typeof entry.replaces === 'string' ? { replaces: entry.replaces } : {}),
  });
  return out;
}

/**
 * The EXACT key for the three identity kinds. The model writes "origin",
 * "expat" or "location" (measured on staging); the topic generator's home
 * anchor matches the canonical home string byte for byte, and the loop's own
 * rules match these constants. Other kinds are left exactly as written.
 */
export function withExactKey(entry: Record<string, unknown>): Record<string, unknown> {
  const statement = typeof entry.statement === 'string' ? entry.statement : '';
  const attribute = typeof entry.questionnaire_attribute === 'string' ? entry.questionnaire_attribute : '';
  const key = attribute.split(':')[0].trim().toLowerCase();
  // The model invents snake-case keys ("origin_country", "country_of_origin",
  // "residence_city"): every word is read, and the statement check below
  // decides which fact it is.
  const words = key.split(/[_\s-]+/).filter(Boolean);
  const loose = key === '' || words.some((w) => ['origin', 'background', 'expat', 'nationality', 'heritage'].includes(w));
  const looseHome = key === '' || words.some((w) => ['residence', 'location', 'home', 'city', 'current', 'lives', 'living'].includes(w));
  if (isExpatStatement(statement) && loose) return { ...entry, questionnaire_attribute: EXPAT_KEY };
  if (isOriginStatement(statement) && loose) {
    // "Expat from India" is the ORIGIN, written "From India"; being an expat
    // is its own fact (see addExpatStatus).
    return { ...entry, statement: toOriginStatement(statement), questionnaire_attribute: ORIGIN_KEY };
  }
  if ((isLocationKey(attribute) || (looseHome && /^lives in\b/i.test(statement.trim())))
      && !isRelationalStatement(statement)) {
    return { ...entry, questionnaire_attribute: CANONICAL_LOCATION_KEY };
  }
  return entry;
}

/** An entry that states where the USER lives: the home key, or a residence-
 *  shaped statement with no key at all. */
export function isHomeEntry(entry: Record<string, unknown>): boolean {
  const attribute = typeof entry.questionnaire_attribute === 'string' ? entry.questionnaire_attribute : null;
  if (attribute) return isLocationKey(attribute);
  return /^lives in\b/i.test(String(entry.statement ?? '').trim());
}

/** "Lives in Porto, Porto, Portugal" gives "Lives in Porto, Portugal": a rung
 *  equal to the one before it (ignoring "Lives in" and case) is dropped. */
export function collapseRepeatedRungs(statement: string): string {
  const parts = statement.split(',').map((p) => p.trim()).filter(Boolean);
  const bare = (p: string) => p.replace(/^(?:lives|living|based|resides?)\s+in\s+/i, '').toLowerCase();
  const out: string[] = [];
  for (const p of parts) {
    if (out.length > 0 && bare(out[out.length - 1]) === bare(p)) continue;
    out.push(p);
  }
  return out.join(', ');
}

/**
 * The facts a deleteUserFacts call names, in the order named, deduplicated:
 * `all: true` is every fact; otherwise each entry is an exact id (brackets
 * stripped), else an attribute key that names exactly ONE fact, else a
 * statement equal in comparable form. An entry naming several facts by key
 * names none: the card must never remove more than was meant.
 */
export function resolveDeleteTargets(
  args: Record<string, unknown>,
  facts: AgentPersonaFact[],
): AgentPersonaFact[] {
  if (args.all === true) return [...facts];
  const named = Array.isArray(args.fact_ids) ? (args.fact_ids as unknown[]) : [];
  const out: AgentPersonaFact[] = [];
  for (const raw of named) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim().replace(/^\[|\]$/g, '');
    const byId = facts.find((f) => f.id === key);
    const byAttr = facts.filter((f) => (f.attribute ?? '').trim().toLowerCase() === key.toLowerCase());
    const byText = facts.filter((f) => comparableStatement(f.statement) === comparableStatement(key));
    const hit = byId ?? (byAttr.length === 1 ? byAttr[0] : byText.length === 1 ? byText[0] : undefined);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** The user's own current home among the facts on file, or null. */
export function currentHomeFact(
  facts: AgentPersonaFact[],
  statement: string,
): AgentPersonaFact | null {
  const isResidenceStatement = (s: string) => /^(?:lives|living|based|resides?)\s+in\b/i.test(s.trim());
  return (
    facts.find(
      (f) =>
        !isCombinedOriginFact(f.attribute)
        && (isLocationKey(f.attribute) || isResidenceStatement(f.statement))
        && mayReplace(statement, f.statement)
        && comparableStatement(f.statement) !== comparableStatement(statement),
    ) ?? null
  );
}

/** Distinct place rungs in a statement ("Porto, Porto, Portugal" is two). */
export function placeRungs(statement: string): number {
  return new Set(
    statement.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean),
  ).size;
}
