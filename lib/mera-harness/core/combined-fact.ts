// mera-harness/core — the retired "origin plus residence" fact. PURE.
//
// Origin and residence used to be composed into ONE fact ("Expat from India
// living in Amsterdam, Netherlands, EU") under its own key. That fact carried
// the user's home without the home key, so a later move replaced the
// residence fact and left the combined one naming the old city (the audit's
// B3), and an origin turn could replace the real residence fact with it.
// Owner ruling: stop combining. Existing combined facts get ONE offer to split.

/** The key every combined fact was written under (`facts/origin.md`). */
export const COMBINED_ORIGIN_KEY = 'background: origin and current residence';

/** Where the user is from, on its own. Not a questionnaire key: none exists
 *  for origin, and `nationality` claims citizenship the user may not have. */
export const ORIGIN_KEY = 'background: country of origin';

/** The canonical home key, byte for byte. The topic generator's tier-1
 *  location resolver matches this exact string. */
export const CANONICAL_LOCATION_KEY =
  'location: neighborhood/area, city, and country (preserve specifics)';

export function isCombinedOriginFact(attribute: string | null | undefined): boolean {
  return typeof attribute === 'string' && attribute.trim().toLowerCase() === COMBINED_ORIGIN_KEY;
}

/**
 * Split a combined statement into its two halves, or null when it does not
 * have the combined shape.
 *
 * "Expat from India living in Amsterdam, Netherlands, EU" gives
 * { origin: "Expat from India", residence: "Lives in Amsterdam, Netherlands, EU" }.
 * "Expat originally from India" (the no-city form) has no residence half and
 * gives null: it is already an origin fact in all but its key.
 */
export function splitCombinedFact(
  statement: string,
): { origin: string; residence: string } | null {
  const m = /^(.*?\S)\s*,?\s+(?:living|based|settled|residing)\s+in\s+(.+?)\s*\.?$/i.exec(
    (statement ?? '').trim(),
  );
  if (!m) return null;
  const origin = m[1].trim();
  const place = m[2].trim();
  if (!origin || !place) return null;
  return { origin, residence: `Lives in ${place}` };
}

// ---------------------------------------------------------------------------
// THREE FACTS FOR AN EXPAT (owner decision, ux1). Origin, expat status and
// residence are separate, each with its own key, each manageable on its own.
// ---------------------------------------------------------------------------

/** Expat status: which country the user lives in as someone from elsewhere.
 *  "Expat in The Netherlands". Changes only when the COUNTRY changes. */
export const EXPAT_KEY = 'background: expat in country of residence';

/** Blocs and continents: the top rung of a place chain, never a country. */
const NOT_A_COUNTRY = new Set([
  'eu', 'eea', 'efta', 'europe', 'asia', 'africa', 'north america',
  'south america', 'oceania', 'antarctica',
]);

/** "Expat from India" or "Expat originally from Kerala, India" gives
 *  "From India" / "From Kerala, India". A text with no "from" is returned as is. */
export function toOriginStatement(originHalf: string): string {
  const m = /\bfrom\s+(.+?)\s*\.?$/i.exec((originHalf ?? '').trim());
  return m ? `From ${m[1].trim()}` : (originHalf ?? '').trim();
}

/**
 * The country of a place statement, or null when it cannot be KNOWN.
 *
 * Read from a RESOLVED chain only: one that ends in a bloc ("..., Germany,
 * EU"), which is how every looked-up place is written, so the rung before the
 * bloc is the country. Or from a place the lookup actually returned whose
 * locality appears in the statement. Never the last rung of an unresolved
 * text: "Nieuw-West, Amsterdam" gave "Expat in Amsterdam" on staging.
 */
export function countryOf(
  statement: string,
  known: readonly { locality: string; countryName: string }[] = [],
): string | null {
  const text = (statement ?? '').replace(/^(?:lives|living|based|resides?)\s+in\s+/i, '');
  const rungs = text
    .split(',')
    .map((r) => r.trim().replace(/\.$/, ''))
    .filter(Boolean);
  if (rungs.length >= 2 && NOT_A_COUNTRY.has(rungs[rungs.length - 1].toLowerCase())) {
    const country = rungs[rungs.length - 2];
    return NOT_A_COUNTRY.has(country.toLowerCase()) ? null : country;
  }
  const lower = text.toLowerCase();
  const hit = known.find((p) => p.locality && lower.includes(p.locality.toLowerCase()));
  return hit ? hit.countryName : null;
}

/** The country an origin statement names ("From Kerala, India" gives "India"). */
export function originCountry(statement: string): string | null {
  const rungs = (statement ?? '')
    .replace(/^(?:expat\s+)?(?:originally\s+)?from\s+/i, '')
    .split(',')
    .map((r) => r.trim().replace(/\.$/, ''))
    .filter(Boolean);
  return rungs.length > 0 ? rungs[rungs.length - 1] : null;
}

/** Country names compared loosely: case and a leading "the" do not matter. */
export function sameCountry(a: string | null, b: string | null): boolean {
  const n = (x: string | null) => (x ?? '').trim().toLowerCase().replace(/^the\s+/, '');
  return n(a) !== '' && n(a) === n(b);
}

export function expatStatement(country: string): string {
  return `Expat in ${country}`;
}

export function isOriginStatement(statement: string): boolean {
  return /^(?:expat\s+)?(?:originally\s+)?from\b/i.test((statement ?? '').trim());
}

export function isExpatStatement(statement: string): boolean {
  return /^expat\s+(?:living\s+)?in\b/i.test((statement ?? '').trim());
}

/**
 * The three facts a combined origin-and-home statement stands for, in order:
 * origin, expat status (only when the two countries differ), residence.
 * Null when the statement does not have the combined shape.
 */
export function threeFactsOf(
  statement: string,
  known: readonly { locality: string; countryName: string }[] = [],
): { origin: string; expat: string | null; residence: string } | null {
  const halves = splitCombinedFact(statement);
  if (!halves) return null;
  const origin = toOriginStatement(halves.origin);
  const country = countryOf(halves.residence, known);
  const expat = country && !sameCountry(country, originCountry(origin)) ? expatStatement(country) : null;
  return { origin, expat, residence: halves.residence };
}
