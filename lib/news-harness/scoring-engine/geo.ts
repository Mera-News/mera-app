// scoring-engine — geo alignment + wrong-location detection.
//
// The on-device geo scorer is AUTHORITATIVE: it has the full role-tagged
// location list the server never sees (the server's coarse geoMatch hint is
// only a cross-check). resolveGeoMatch() answers two things:
//   (1) geoComp / alignment — how well the article's places align with any
//       persona location (CITY > REGION > COUNTRY > NONE), scaled by the
//       matched location's weight; and
//   (2) wrongLocationFlag — the "asked for Chhindwara, got Dindori" guard.

import type { ScoringEngineConfig } from '../core/config';
import { normCountry, normText, type PersonaLocationSnapshot } from './persona-context';

export type GeoAlignment = 'CITY' | 'REGION' | 'COUNTRY' | 'NONE';

/** An article geo tag (mirrors the server's normalized {city?,region?,countryCode}
 *  tuple — city/region lower-cased, countryCode UPPER). */
export interface ArticleGeoTag {
  city?: string;
  region?: string;
  countryCode: string;
}

export interface GeoMatchResult {
  /** Best alignment tier across all tags × persona locations. */
  alignment: GeoAlignment;
  /** geoComp in [0,1]: best (alignmentMultiplier × location.weight) across tags. */
  geoScore: number;
  /** The persona location that produced the best alignment (audit). */
  matchedLocationId?: string;
  /** 1 when the article resolves to a sibling city of a matched anchored
   *  location (see wrong-location rule below); 0 otherwise. */
  wrongLocationFlag: 0 | 1;
}

const cityEq = (a?: string, b?: string): boolean =>
  !!a && !!b && normText(a) === normText(b);
const regionEq = (a?: string, b?: string): boolean =>
  !!a && !!b && normText(a) === normText(b);
const countryEq = (a: string, b: string): boolean =>
  normCountry(a) === normCountry(b);

/**
 * Resolve the geo alignment + wrong-location flag for one article.
 *
 * @param articleGeoTags  the article's normalized geo tags (may be empty).
 * @param locations       the FULL persona location list (normalized).
 * @param config          scoring-engine constants (GEO_* multipliers).
 * @param anchoredLocationIds  ids of the persona locations that a matched,
 *        location-anchored topic points at. Only these drive wrongLocationFlag;
 *        when empty (no location-anchored topic matched) the flag is always 0.
 *
 * Wrong-location rule (exact, per SUB-PLAN M decision "Exclude entirely: P_WRONG"):
 *   fires (=1) iff — for some matched anchored location L —
 *     (a) the article does NOT match ANY persona location at CITY level
 *         (i.e. it isn't about a city the user actually follows), AND
 *     (b) no article tag names L's city, AND
 *     (c) some article tag names a DIFFERENT specific city in L's same country
 *         (region, when both present, must also match — Dindori vs Chhindwara).
 *   Region-wide stories (a tag with region but no city) name no different city →
 *   they resolve REGION and are NEVER wrong-location. Cross-country matches never
 *   fire (Bhopal-topic → Birmingham GB article resolves NONE, no sibling city).
 */
export function resolveGeoMatch(
  articleGeoTags: ArticleGeoTag[],
  locations: PersonaLocationSnapshot[],
  config: ScoringEngineConfig,
  anchoredLocationIds: ReadonlySet<string> = new Set(),
): GeoMatchResult {
  const tags = articleGeoTags ?? [];
  if (tags.length === 0 || locations.length === 0) {
    return { alignment: 'NONE', geoScore: 0, wrongLocationFlag: 0 };
  }

  // (1) best alignment / geoComp across every tag × location pair.
  let bestScore = 0;
  let bestAlignment: GeoAlignment = 'NONE';
  let bestLocationId: string | undefined;
  const rank: Record<GeoAlignment, number> = { CITY: 3, REGION: 2, COUNTRY: 1, NONE: 0 };

  for (const tag of tags) {
    for (const loc of locations) {
      if (!countryEq(tag.countryCode, loc.countryCode)) continue;
      let align: GeoAlignment;
      let mult: number;
      if (cityEq(tag.city, loc.city) && (!tag.region || !loc.region || regionEq(tag.region, loc.region))) {
        align = 'CITY';
        mult = config.GEO_CITY;
      } else if (regionEq(tag.region, loc.region)) {
        align = 'REGION';
        mult = config.GEO_REGION;
      } else {
        align = 'COUNTRY';
        mult = config.GEO_COUNTRY;
      }
      const score = mult * loc.weight;
      // Prefer higher score; break ties toward the stronger alignment tier.
      if (score > bestScore || (score === bestScore && rank[align] > rank[bestAlignment])) {
        bestScore = score;
        bestAlignment = align;
        bestLocationId = loc.id;
      }
    }
  }

  // (2) wrong-location flag — only when a location-anchored topic matched AND
  //     the article isn't about any city the user actually follows.
  let wrongLocationFlag: 0 | 1 = 0;
  if (anchoredLocationIds.size > 0 && bestAlignment !== 'CITY') {
    const anchored = locations.filter((l) => anchoredLocationIds.has(l.id));
    for (const L of anchored) {
      const articleNamesLCity = tags.some((t) => cityEq(t.city, L.city));
      if (articleNamesLCity) continue; // article is about L's city → fine
      // "same region/country, different city": same country + a specific
      // different city is the trigger (a same-country/different-region city —
      // e.g. Mumbai vs Bhopal — is still a wrong place for a Bhopal-anchored
      // topic, so we gate on country, not region).
      const hasSiblingDifferentCity = tags.some(
        (t) =>
          !!t.city &&
          countryEq(t.countryCode, L.countryCode) &&
          !cityEq(t.city, L.city),
      );
      if (hasSiblingDifferentCity) {
        wrongLocationFlag = 1;
        break;
      }
    }
  }

  return {
    alignment: bestAlignment,
    geoScore: bestScore,
    matchedLocationId: bestLocationId,
    wrongLocationFlag,
  };
}
