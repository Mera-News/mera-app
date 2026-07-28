// Explore tab — scope derivation.
//
// Turns the user's on-device `locations` (never sent to the server) plus the
// device-locale country into the horizontal scope chips shown on the Explore
// tab. Each scope drives a DIRECT server-paginated article query — there is no
// scoring, no LLM, and nothing persisted (see components/custom/explore).
//
// Chips are COUNTRY… + World (geo-derivation wave, 2026-07-27). The Top
// stories chip and its blended GLOBAL+home feed were deleted outright —
// trending headlines mostly don't concern the user, so the tab no longer
// leads with them.
//
// Order is `[primary country?, ...remaining countries weight-desc, World]`:
// World is ALWAYS present and ALWAYS last, so the cap is applied to the
// country list only. The primary country is elected by
// {@link electPrimaryCountry} (highest-weight `role: 'home'` row, else
// highest-weight row overall, else the device country) and de-duped out of
// the tail so it never appears twice. Cold-mount lands on the first chip.
//
// City/region derivation was removed in the app-rethink wave because geo-tags
// are dormant in prod (all null), so those chips showed ~nothing. Each
// location still contributes its country. The `'city'|'region'` scope-kind
// members and their builder functions are kept — see the DEPRECATED markers
// below — purely for type compatibility with any already-persisted
// `explore_last_scope` id; ExploreScreen already falls back to the first scope
// when a persisted id no longer resolves, so no data migration is needed here.
//
// Country-code formats (subtle — three different conventions collide here):
//   • WatermelonDB `locations.countryCode` and `NewsArticle.geo_tags.countryCode`
//     are ISO alpha-2 (the server normalizes geo tags via CountryCodeMapper).
//   • `articlesForCountry(countryCode:)` filters on the publication's
//     `country_code`, which is ISO alpha-3.
// So a scope carries BOTH: alpha-2 (for the on-device geo-tag filter) and
// alpha-3 (the fetch argument). World fetches with the 'GLOBAL' sentinel.

import countries from 'i18n-iso-countries';
import { getCountryName, getFlagEmoji } from '@/lib/country-utils';

export type ExploreScopeKind = 'world' | 'country' | 'city' | 'region';

export interface ExploreScope {
    /** Stable identity (also the FlatList key + persisted selection). */
    readonly id: string;
    readonly kind: ExploreScopeKind;
    /**
     * Display label for country/city/region scopes. Empty for `world` — that
     * chip renders a translated label instead (this module is i18n-free so it
     * stays a pure, testable function).
     */
    readonly label: string;
    readonly icon: 'public' | 'location-city' | 'map' | 'flag';
    /** Flag emoji for country chips (empty for other kinds). */
    readonly flagEmoji?: string;
    /**
     * The `articlesForCountry` fetch argument. null for World (mapped to the
     * 'GLOBAL' sentinel by the caller). ISO alpha-3 for every other kind.
     */
    readonly countryCodeAlpha3: string | null;
    /** ISO alpha-2 — used only for cross-referencing geo tags if ever needed. */
    readonly countryCodeAlpha2?: string;
    /** Present for `city` scopes — the on-device geo-tag filter key. */
    readonly city?: string;
    /** Present for `city`/`region` scopes — the on-device geo-tag filter key. */
    readonly region?: string;
}

/**
 * Role tags a `locations` row can carry. Deliberately a LOCAL string union
 * rather than an import of `LocationRole` from lib/database/models/Location.ts
 * — that file imports `@nozbe/watermelondb`, and this module is decoupled from
 * the model (see {@link ScopeLocationInput}) so it stays pure and testable.
 * Structurally identical to `LocationRole`, so model rows assign directly.
 */
export type ScopeLocationRole = 'home' | 'travel' | 'family' | 'partner_family' | 'interest';

/** Minimal shape the derivation needs (decoupled from the WatermelonDB model). */
export interface ScopeLocationInput {
    readonly city: string | null;
    readonly region: string | null;
    /** ISO alpha-2, as stored on the `locations` row. */
    readonly countryCode: string;
    readonly role: ScopeLocationRole;
    readonly weight: number;
}

/** Hard cap on visible scope chips (up to 5 countries + World, which is exempt). */
export const MAX_SCOPES = 6;

/** ISO alpha-2 → alpha-3, or null when unmappable. */
export function alpha2ToAlpha3(alpha2: string | null | undefined): string | null {
    const a2 = (alpha2 ?? '').trim().toUpperCase();
    if (!a2) return null;
    return countries.alpha2ToAlpha3(a2) ?? null;
}

/** Title-cases a place string for display (`new delhi` → `New Delhi`). */
function titleCase(s: string): string {
    return s
        .trim()
        .split(/\s+/)
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');
}

function worldScope(): ExploreScope {
    return { id: 'world', kind: 'world', label: '', icon: 'public', countryCodeAlpha3: null };
}

function countryScope(alpha2: string, alpha3: string): ExploreScope {
    return {
        id: `country:${alpha3}`,
        kind: 'country',
        label: getCountryName(alpha3),
        icon: 'flag',
        flagEmoji: getFlagEmoji(alpha3),
        countryCodeAlpha3: alpha3,
        countryCodeAlpha2: alpha2,
    };
}

// DEPRECATED(app-rethink wave): geo-tags dormant in prod; city/region chips removed from derivation.
function cityScope(alpha2: string, alpha3: string, city: string, region?: string): ExploreScope {
    return {
        id: `city:${alpha3}:${city.toLowerCase()}`,
        kind: 'city',
        label: titleCase(city),
        icon: 'location-city',
        countryCodeAlpha3: alpha3,
        countryCodeAlpha2: alpha2,
        city,
        region: region || undefined,
    };
}

// DEPRECATED(app-rethink wave): geo-tags dormant in prod; city/region chips removed from derivation.
function regionScope(alpha2: string, alpha3: string, region: string): ExploreScope {
    return {
        id: `region:${alpha3}:${region.toLowerCase()}`,
        kind: 'region',
        label: titleCase(region),
        icon: 'map',
        countryCodeAlpha3: alpha3,
        countryCodeAlpha2: alpha2,
        region,
    };
}

/**
 * Elect the user's primary country — the chip Explore cold-mounts on.
 *
 * Rule, in order:
 *   1. The highest-weight `role: 'home'` location with a mappable country.
 *   2. Failing that, the highest-weight location with a mappable country.
 *   3. Failing that, the device-locale country.
 *   4. Failing that, null.
 *
 * `locations` arrives pre-sorted weight-desc (the `location-service` query
 * sorts on `weight`), so "highest-weight" is just "first match".
 *
 * This is the same precedence `loadUserGeoLanguageContext` applies, so the
 * Explore landing chip and the retrieval profile agree on which country is
 * "the user's". Note step 3 is effectively the last stop in the app:
 * `getDeviceCountryAlpha2()` hard-falls-back to 'US' and never returns null,
 * so only a caller passing an explicit null/unmappable code reaches step 4.
 */
export function electPrimaryCountry(
    locations: readonly ScopeLocationInput[],
    deviceCountryAlpha2: string | null | undefined,
): ExploreScope | null {
    const toScope = (loc: ScopeLocationInput): ExploreScope | null => {
        const alpha3 = alpha2ToAlpha3(loc.countryCode);
        if (!alpha3) return null;
        return countryScope(loc.countryCode.trim().toUpperCase(), alpha3);
    };

    for (const loc of locations) {
        if (loc.role !== 'home') continue;
        const scope = toScope(loc);
        if (scope) return scope;
    }

    for (const loc of locations) {
        const scope = toScope(loc);
        if (scope) return scope;
    }

    const deviceAlpha3 = alpha2ToAlpha3(deviceCountryAlpha2);
    if (deviceAlpha3) {
        return countryScope((deviceCountryAlpha2 ?? '').trim().toUpperCase(), deviceAlpha3);
    }

    return null;
}

/**
 * Build the Explore scope chips.
 *
 * Order:
 *   1. The primary country (see {@link electPrimaryCountry}). Omitted only
 *      when neither the locations nor the device country resolve.
 *   2. The remaining location-derived country scopes (weight-desc, the
 *      primary excluded so it never appears twice). City/region scopes are no
 *      longer derived — see the module header.
 *   3. World — always present, always LAST.
 *
 * De-duped by scope id. The cap applies to the COUNTRY list only
 * ({@link MAX_SCOPES} - 1 countries); World is appended afterwards so it
 * always survives.
 */
export function deriveExploreScopes(
    locations: readonly ScopeLocationInput[],
    deviceCountryAlpha2: string | null | undefined,
): ExploreScope[] {
    const primary = electPrimaryCountry(locations, deviceCountryAlpha2);

    const countryScopes: ExploreScope[] = [];
    const seenAlpha3 = new Set<string>();
    if (primary) {
        seenAlpha3.add(primary.countryCodeAlpha3!);
        countryScopes.push(primary);
    }
    for (const loc of locations) {
        const alpha3 = alpha2ToAlpha3(loc.countryCode);
        if (!alpha3 || seenAlpha3.has(alpha3)) continue;
        seenAlpha3.add(alpha3);
        countryScopes.push(countryScope(loc.countryCode.trim().toUpperCase(), alpha3));
    }

    return [...countryScopes.slice(0, MAX_SCOPES - 1), worldScope()];
}
