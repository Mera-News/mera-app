// scoring-engine — the plain, RN-free persona snapshot the deterministic
// relevance math runs against, plus the normalizers that produce it.
//
// Nothing here touches WatermelonDB, zustand, or expo — the RN-coupled services
// (topic-service, location-service, …) build these plain snapshots and hand
// them to computeRelevance(). Every matching key (city/region/entity/publication)
// is normalized the SAME way the server tagging normalizes (trim + lowercase;
// country codes upper-cased) so on-device geo/entity/pub matching lines up with
// the tags Gemini produced server-side.

/** Lower-cased, trimmed matching key (city, region, entity, publication). */
export function normText(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

/** Upper-cased, trimmed ISO country code. */
export function normCountry(v: string | null | undefined): string {
  return (v ?? '').trim().toUpperCase();
}

/** A role-tagged place entity the scorer needs (subset of the WMDB `locations`
 *  row — no provenance/timestamps). city/region are normalized keys. */
export interface PersonaLocationSnapshot {
  id: string;
  city?: string;
  region?: string;
  countryCode: string;
  role: string;
  /** Ordering + scoring strength, [0,1]. */
  weight: number;
  /** Travel windows expire; a location past its window is dropped upstream. */
  validUntilMs?: number;
}

/** A soft (score-penalty) suppression. Hard suppressions (strength ≥ 0.8) are
 *  filtered out BEFORE the engine — the engine only demotes. */
export interface SoftSuppression {
  /** Normalized (lower-cased) keywords; a substring hit on title/description/
   *  entities counts as a match. */
  keywords: string[];
  /** [0,1]. */
  strength: number;
}

/** The plain persona snapshot computeRelevance() reads. Never leaves the device;
 *  the server never sees weights, negatives, locations, or suppressions. */
export interface PersonaScoringContext {
  locations: PersonaLocationSnapshot[];
  /** normalizedPublicationName → weight [-1,1]. */
  pubPrefs: Map<string, number>;
  softSuppressions: SoftSuppression[];
  /** normalizedEntity → interest weight [0,1]. Optional; from topics/facts. */
  entityInterest?: Map<string, number>;
  /** Article ids OR stable-cluster ids already seen → seenPenalty. */
  seenStoryIds?: Set<string>;
}

/** Normalize a location snapshot's matching keys in place-safe fashion. */
export function normalizeLocation(
  loc: PersonaLocationSnapshot,
): PersonaLocationSnapshot {
  return {
    ...loc,
    city: loc.city ? normText(loc.city) : undefined,
    region: loc.region ? normText(loc.region) : undefined,
    countryCode: normCountry(loc.countryCode),
  };
}

/** Build a normalized pub-pref map from raw {name, weight} rows. */
export function buildPubPrefs(
  rows: { publicationName: string; weight: number }[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const key = normText(r.publicationName);
    if (key) m.set(key, r.weight);
  }
  return m;
}

/** Build a normalized entity-interest map from raw {entity, weight} rows. */
export function buildEntityInterest(
  rows: { entity: string; weight: number }[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const key = normText(r.entity);
    if (key) m.set(key, r.weight);
  }
  return m;
}

/** Normalize a whole persona context (idempotent). */
export function normalizePersonaContext(
  ctx: PersonaScoringContext,
): PersonaScoringContext {
  return {
    ...ctx,
    locations: ctx.locations.map(normalizeLocation),
  };
}
