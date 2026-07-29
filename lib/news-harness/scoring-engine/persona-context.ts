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

/** What a suppression matches against. Mirrors `SUPPRESSION_KINDS` in
 *  `lib/database/models/PersonaSuppression` (duplicated here so the engine
 *  stays RN-free / DB-free). An absent kind means 'keyword'. */
export type SuppressionKind =
  | 'keyword'
  | 'category'
  | 'event_type'
  | 'entity'
  | 'publication'
  | 'place'
  | 'topic';

/**
 * One suppression as the engine sees it. The SAME shape carries both flavours —
 * the hard/soft split is made once by the persona loader (by comparing
 * `strength` against the DB service's HARD_SUPPRESSION_STRENGTH) and surfaces
 * here as two separate lists:
 *
 *  - `softSuppressions` → a capped score penalty (relevance.ts).
 *  - `hardSuppressions` → the candidate is screened out entirely, before any
 *    math or judge work (scoring-engine/suppression.ts::screenHardSuppressions,
 *    called from both orchestrators).
 *
 * Matching for every kind lives in `scoring-engine/suppression.ts`.
 */
export interface SoftSuppression {
  /** Normalized (lower-cased) keywords; a substring hit on title/description/
   *  entities counts as a match. Used by the `keyword` kind only. */
  keywords: string[];
  /** [0,1]. */
  strength: number;
  /** Absent ⇒ 'keyword' (pre-v46 rows). */
  kind?: SuppressionKind;
  /** The single token the non-keyword kinds compare against. Pre-normalized by
   *  the loader; the matcher normalizes again defensively (idempotent). */
  value?: string;
  /** Human-readable original phrase — display/fallback only, never matched
   *  against directly. */
  pattern?: string;
}

/** The plain persona snapshot computeRelevance() reads. Never leaves the device;
 *  the server never sees weights, negatives, locations, or suppressions. */
export interface PersonaScoringContext {
  locations: PersonaLocationSnapshot[];
  /** normalizedPublicationName → weight [-1,1]. */
  pubPrefs: Map<string, number>;
  softSuppressions: SoftSuppression[];
  /** Hard "not interested" filters — matching candidates are dropped entirely
   *  rather than demoted. Optional: absent/empty ⇒ nothing is screened out
   *  (which is exactly the pre-wave behaviour). */
  hardSuppressions?: SoftSuppression[];
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
