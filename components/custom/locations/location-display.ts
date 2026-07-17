// Locations screen — pure display metadata (role icons/labels, geo formatting,
// weight buckets). RN-free apart from the MaterialIcons glyph type so it stays
// testable and shared across LocationsScreen + AddLocationModal.

import type { MaterialIcons } from '@expo/vector-icons';
import countries from 'i18n-iso-countries';
import type { LocationRole } from '@/lib/database/models/Location';
// Importing country-utils runs its `registerLocale(en)` side-effect (needed for
// the alpha-2 ↔ alpha-3 / name lookups below).
import { getCountryName } from '@/lib/country-utils';

type GlyphName = keyof typeof MaterialIcons.glyphMap;

export interface RoleMeta {
  readonly role: LocationRole;
  readonly icon: GlyphName;
  /** i18n key under `locations.roles`. */
  readonly labelKey: string;
}

// Locked-plan role icons (all valid MaterialIcons glyphs). partner_family
// REQUIRES icon+label since `diversity-1` reads ambiguously on its own.
export const LOCATION_ROLES: readonly RoleMeta[] = [
  { role: 'home', icon: 'home', labelKey: 'home' },
  { role: 'travel', icon: 'flight', labelKey: 'travel' },
  { role: 'family', icon: 'family-restroom', labelKey: 'family' },
  { role: 'partner_family', icon: 'diversity-1', labelKey: 'partnerFamily' },
  { role: 'interest', icon: 'interests', labelKey: 'interest' },
] as const;

export function roleMeta(role: LocationRole): RoleMeta {
  return LOCATION_ROLES.find((r) => r.role === role) ?? LOCATION_ROLES[0];
}

/** Flag emoji from an ISO alpha-2 code (as stored on `locations.countryCode`). */
export function flagForAlpha2(alpha2: string | null | undefined): string {
  const a2 = (alpha2 ?? '').trim().toUpperCase();
  if (a2.length !== 2) return '';
  const codePoints = [...a2].map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

/** Human country name from an ISO alpha-2 code (via alpha-3 lookup). */
export function countryNameForAlpha2(alpha2: string | null | undefined): string {
  const a2 = (alpha2 ?? '').trim().toUpperCase();
  if (!a2) return '';
  const alpha3 = countries.alpha2ToAlpha3(a2);
  return alpha3 ? getCountryName(alpha3) : a2;
}

/** ISO alpha-3 → alpha-2 (for the manual-entry country picker → storage). */
export function alpha3ToAlpha2(alpha3: string | null | undefined): string | null {
  const a3 = (alpha3 ?? '').trim().toUpperCase();
  if (!a3) return null;
  return countries.alpha3ToAlpha2(a3) ?? null;
}

/** Title-case a raw place string for display (`new delhi` → `New Delhi`). */
export function titleCasePlace(s: string | null | undefined): string {
  return (s ?? '')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Compose a one-line label for a location row: `City, Region, CC` — omitting
 * missing parts. Falls back to the country name when no city/region is set.
 */
export function composeLocationLabel(loc: {
  city: string | null;
  region: string | null;
  countryCode: string;
}): string {
  const parts: string[] = [];
  if (loc.city) parts.push(titleCasePlace(loc.city));
  if (loc.region) parts.push(titleCasePlace(loc.region));
  if (parts.length === 0) return countryNameForAlpha2(loc.countryCode);
  parts.push(loc.countryCode.trim().toUpperCase());
  return parts.join(', ');
}

// ── Weight buckets ──────────────────────────────────────────────────────────
// The list + add-flow use a 3-step control (Low / Medium / High) mapping to
// canonical weights. A row whose stored weight (e.g. the 0.5 default) doesn't
// land exactly on a bucket highlights the NEAREST one.

export type WeightBucket = 'low' | 'medium' | 'high';

export const WEIGHT_BUCKETS: readonly { bucket: WeightBucket; weight: number }[] = [
  { bucket: 'low', weight: 0.3 },
  { bucket: 'medium', weight: 0.6 },
  { bucket: 'high', weight: 0.9 },
] as const;

/** Default weight for a newly-added location (Medium). */
export const DEFAULT_NEW_LOCATION_WEIGHT = 0.6;

export function weightForBucket(bucket: WeightBucket): number {
  return WEIGHT_BUCKETS.find((b) => b.bucket === bucket)?.weight ?? DEFAULT_NEW_LOCATION_WEIGHT;
}

/** Nearest bucket for an arbitrary stored weight (for highlight). */
export function nearestBucket(weight: number): WeightBucket {
  let best = WEIGHT_BUCKETS[0];
  for (const b of WEIGHT_BUCKETS) {
    if (Math.abs(b.weight - weight) < Math.abs(best.weight - weight)) best = b;
  }
  return best.bucket;
}
