// news-harness — bounded persona-mutation rails (PURE, RN-free).
//
// Wave 8 M-P6. The math + compilers behind every on-device persona nudge: the
// weight clamp, the per-topic per-day nudge budget, the signal→delta lookup,
// and the wrong-location compiler that turns a "this story is about the wrong
// place" signal into an ordered list of plain action descriptors. The RN
// adapter (lib/database/services/mutation-rails-service.ts) executes those
// descriptors against WatermelonDB — nothing here touches the DB.
//
// Style mirrors the sibling pure file persona-migration.ts / fact-rules.ts:
// plain data in, plain data out, deterministic, config injected (defaults to
// DEFAULT_HARNESS_CONFIG so callers can omit it).

import {
  DEFAULT_HARNESS_CONFIG,
  type HarnessConfig,
} from '../core/config';

// ── Weight clamp ───────────────────────────────────────────────────────────

/** Clamp a topic weight to the valid [-1, 1] band. */
export function clampWeight(w: number): number {
  if (Number.isNaN(w)) return 0;
  return w < -1 ? -1 : w > 1 ? 1 : w;
}

// ── Per-topic per-day nudge budget ─────────────────────────────────────────

export interface NudgeResult {
  /** Clamped current weight before the nudge. */
  before: number;
  /** Clamped weight after the (budget- and range-limited) nudge. */
  after: number;
  /** The delta actually applied (after − before). 0 when the budget is spent. */
  appliedDelta: number;
  /** The delta the caller asked for (unmodified). */
  requestedDelta: number;
  /** True when the daily budget (or the ±1 clamp) shrank the requested delta. */
  budgetExceeded: boolean;
}

/**
 * Apply one nudge to a topic weight under the per-topic per-day budget.
 *
 * remaining      = max(0, NUDGE_DAY_BUDGET − |todayBudgetUsedAbs|)
 * clampedDelta   = clamp(delta, −remaining, +remaining)   ← budget leash
 * before         = clampWeight(currentWeight)
 * after          = clampWeight(before + clampedDelta)     ← ±1 range leash
 * appliedDelta   = after − before
 * budgetExceeded = |clampedDelta| < |delta|
 *
 * When the day's budget is already spent (todayBudgetUsedAbs ≥ budget),
 * remaining is 0 → clampedDelta 0 → appliedDelta 0 (signal recorded elsewhere;
 * the digest decides). budgetExceeded is still true when a non-zero delta was
 * requested.
 */
export function nudgeTopicWeight(
  currentWeight: number,
  delta: number,
  todayBudgetUsedAbs: number,
  config: HarnessConfig = DEFAULT_HARNESS_CONFIG,
): NudgeResult {
  const budget = config.mutationRails.NUDGE_DAY_BUDGET;
  const remaining = Math.max(0, budget - Math.abs(todayBudgetUsedAbs));
  const clampedDelta = Math.max(-remaining, Math.min(remaining, delta));
  const before = clampWeight(currentWeight);
  const after = clampWeight(before + clampedDelta);
  const appliedDelta = after - before;
  const budgetExceeded = Math.abs(clampedDelta) < Math.abs(delta);
  return { before, after, appliedDelta, requestedDelta: delta, budgetExceeded };
}

// ── Signal → delta ─────────────────────────────────────────────────────────

export type NudgeSignal = 'show_less' | 'thumbs_down';

/** The config-driven weight delta for a feedback signal. */
export function signalDelta(
  signal: NudgeSignal,
  config: HarnessConfig = DEFAULT_HARNESS_CONFIG,
): number {
  const r = config.mutationRails;
  switch (signal) {
    case 'show_less':
      return r.SHOW_LESS;
    case 'thumbs_down':
      return r.THUMBS_DOWN;
    default:
      return 0;
  }
}

// ── Wrong-location compiler ────────────────────────────────────────────────

/** Lowercase + trim + collapse whitespace — mirror of topic-service's key. */
function normalizePlace(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** A single article geo tag (the article's tagged place). */
export interface WrongLocationGeoTag {
  city?: string | null;
  region?: string | null;
  countryCode?: string | null;
}

/** A user location (never leaves the device). */
export interface WrongLocationUserLocation {
  city?: string | null;
  region?: string | null;
  countryCode: string;
}

export interface WrongLocationInput {
  articleGeo: WrongLocationGeoTag | WrongLocationGeoTag[];
  matchedTopics: { topicId: string | null; text: string }[];
  locations: WrongLocationUserLocation[];
  entities?: string[];
}

/** The plain action descriptors the RN service executes, in order. */
export type WrongLocationAction =
  | { kind: 'add_negative_topic'; text: string; weight: number }
  | {
      kind: 'add_suppression';
      pattern: string;
      keywords: string[];
      strength: number;
    };

/** The most specific human place name of a geo tag (city → region → country). */
function placeName(g: WrongLocationGeoTag): string | null {
  const city = normalizePlace(g.city);
  if (city) return city;
  const region = normalizePlace(g.region);
  if (region) return region;
  const country = normalizePlace(g.countryCode);
  return country || null;
}

/**
 * True when a geo tag corresponds to a place the user cares about: at the
 * FINEST level where BOTH the tag and the location carry a value, they are
 * equal. A sibling-city tag (same country, different city) matches at neither
 * city nor region → falls through to country; but because city IS present on
 * both, the finest shared level is city, which differs → NOT a match (wrong).
 */
function geoMatchesLocation(
  g: WrongLocationGeoTag,
  l: WrongLocationUserLocation,
): boolean {
  const gCity = normalizePlace(g.city);
  const lCity = normalizePlace(l.city);
  if (gCity && lCity) return gCity === lCity;
  const gRegion = normalizePlace(g.region);
  const lRegion = normalizePlace(l.region);
  if (gRegion && lRegion) return gRegion === lRegion;
  return normalizePlace(g.countryCode) === normalizePlace(l.countryCode);
}

/**
 * Compile a wrong-location feedback signal into an ordered list of plain action
 * descriptors. Deterministic + pure — no DB, no clock.
 *
 * 1. add_negative_topic — for the FIRST article geo tag (input order) that
 *    matches NONE of the user's locations. text = `news about <place>` (the
 *    tag's most specific place, lowercased); weight = WRONG_LOCATION_NEG_TOPIC.
 *    When every tag matches a user location (or no place can be named), no
 *    negative-topic action is emitted.
 * 2. add_suppression (SOFT, strength 0.5 < the 0.8 hard cutoff) — only when the
 *    article carries bad-context `entities`. keywords = entities lowercased;
 *    pattern = a short phrase built from them.
 */
export function buildWrongLocationActions(
  input: WrongLocationInput,
  config: HarnessConfig = DEFAULT_HARNESS_CONFIG,
): WrongLocationAction[] {
  const geoTags = Array.isArray(input.articleGeo)
    ? input.articleGeo
    : [input.articleGeo];
  const actions: WrongLocationAction[] = [];

  // 1. Wrong-place negative topic — first tag matching no user location.
  const wrongTag = geoTags.find(
    (g) =>
      placeName(g) != null &&
      !input.locations.some((l) => geoMatchesLocation(g, l)),
  );
  if (wrongTag) {
    const name = placeName(wrongTag)!;
    actions.push({
      kind: 'add_negative_topic',
      text: `news about ${name}`,
      weight: config.mutationRails.WRONG_LOCATION_NEG_TOPIC,
    });
  }

  // 2. Optional soft suppression from the article's bad-context entities.
  const keywords = (input.entities ?? [])
    .map((e) => normalizePlace(e))
    .filter((e) => e.length > 0);
  if (keywords.length > 0) {
    actions.push({
      kind: 'add_suppression',
      pattern: keywords.join(', '),
      keywords,
      strength: 0.5,
    });
  }

  return actions;
}
