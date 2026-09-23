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
