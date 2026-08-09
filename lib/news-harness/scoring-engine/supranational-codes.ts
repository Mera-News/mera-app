/**
 * Supranational PLACE codes accepted in a server geo tag's `countryCode`
 * alongside ISO-3166 alpha-2 country codes.
 *
 * MIRROR, NOT AN IMPORT. This is a deliberate copy of
 * `mera-server/libs/mera-shared/src/enrichment/supranational-codes.ts` — the
 * two repos share no `node_modules` and this file must stay RN-free / import
 * nothing outside `lib/news-harness/`, so the vocabulary is duplicated rather
 * than reached across repos. Keep the two lists in sync by hand; this is a
 * CURATED closed set on both sides, so a member added on the server and not
 * mirrored here is a silent gap, not a crash — it would just read as an
 * unrecognized ISO code (safe: see below) until this file is updated.
 *
 * WHY THE CODES ARE LONGER THAN TWO LETTERS (except EU): ISO-3166 alpha-2 owns
 * the entire two-letter space, so a token of any other length can never
 * collide with a real country. The obvious short forms are all taken — `AF`
 * is Afghanistan, `AS` American Samoa, `NA` Namibia, `SA` Saudi Arabia — so
 * `AFRICA`, `ASIA`, `NORTH_AMERICA` and friends are spelled out. `EU` is the
 * one safe two-letter member: it is an ISO-3166-1 *exceptionally reserved*
 * code, permanently withheld from assignment to any country, so it cannot
 * become ambiguous later.
 *
 * THE TWO-CHARACTER TRAP. `EU` is exactly two letters, same as every real
 * ISO alpha-2 code — a `code.length > 2` heuristic silently misclassifies it
 * as a country. Membership must always be decided by looking the (trimmed,
 * uppercased) token up in this table, never by its length.
 *
 * This is a CURATED list, not an open vocabulary. Consumers key on these
 * exact strings, so adding to it is a deliberate, synchronized act on both
 * repos.
 */
export const SUPRANATIONAL_CODES = Object.freeze({
  EU: 'European Union',
  EUROPE: 'Europe',
  MIDDLE_EAST: 'Middle East',
  NORTH_AFRICA: 'North Africa',
  SUB_SAHARAN_AFRICA: 'Sub-Saharan Africa',
  AFRICA: 'Africa',
  ASIA: 'Asia',
  SOUTH_ASIA: 'South Asia',
  SOUTHEAST_ASIA: 'Southeast Asia',
  CENTRAL_ASIA: 'Central Asia',
  EAST_ASIA: 'East Asia',
  NORTH_AMERICA: 'North America',
  CENTRAL_AMERICA: 'Central America',
  SOUTH_AMERICA: 'South America',
  LATIN_AMERICA: 'Latin America',
  CARIBBEAN: 'Caribbean',
  OCEANIA: 'Oceania',
  BALKANS: 'Balkans',
  NORDICS: 'Nordics',
  BALTICS: 'Baltics',
  GULF: 'Gulf',
  GLOBAL: 'Global',
} as const);

export type SupranationalCode = keyof typeof SUPRANATIONAL_CODES;

const SUPRANATIONAL_CODE_SET: ReadonlySet<string> = new Set(
  Object.keys(SUPRANATIONAL_CODES),
);

/**
 * Whether `code` is one of the curated supranational codes. Matching is on the
 * UPPERCASED, trimmed token — callers hand in whatever the server emitted (or
 * whatever a suppression/persona row copied verbatim from it).
 *
 * ALWAYS an allowlist lookup, NEVER a length check — see the "two-character
 * trap" note above. `EU` (length 2) must return true here; every real ISO
 * alpha-2 country code (also length 2) must return false.
 */
export function isSupranationalCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return SUPRANATIONAL_CODE_SET.has(code.trim().toUpperCase());
}

/**
 * Human-readable English name for a supranational code, or null when `code`
 * is not one (including every real ISO-3166 alpha-2 country code).
 *
 * Use this wherever a geo-tag countryCode reaches a prompt, a topic-text
 * string, or the UI — "Middle East" reads as prose; "MIDDLE_EAST" reads as a
 * bug. Anything that resolves a countryCode to a COUNTRY (a flag, a full
 * country-name lookup, or an equality match against the user's own alpha-2
 * location) must never be handed a supranational code as if it were one —
 * check `isSupranationalCode` / a non-null result here first and skip or
 * branch accordingly.
 */
export function supranationalName(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = code.trim().toUpperCase();
  return SUPRANATIONAL_CODE_SET.has(key)
    ? SUPRANATIONAL_CODES[key as SupranationalCode]
    : null;
}
