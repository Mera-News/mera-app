// Explore tab — scope derivation.
//
// Turns the user's on-device `locations` (never sent to the server) plus the
// device-locale country into the horizontal scope chips shown on the Explore
// tab. Each scope drives a DIRECT server-paginated article query — there is no
// scoring, no LLM, and nothing persisted (see components/custom/explore).
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
     * Display label for country/city/region scopes. Empty for `world` — the
     * chip renders the translated `explore.scopeWorld` instead (this module is
     * i18n-free so it stays a pure, testable function).
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

/** Minimal shape the derivation needs (decoupled from the WatermelonDB model). */
export interface ScopeLocationInput {
    readonly city: string | null;
    readonly region: string | null;
    /** ISO alpha-2, as stored on the `locations` row. */
    readonly countryCode: string;
    readonly weight: number;
}

/** Hard cap on visible scope chips (World + up to 5 more). */
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
 * Build the Explore scope chips.
 *
 * Order (also the cap priority — World always survives, lowest-priority tail is
 * dropped past {@link MAX_SCOPES}):
 *   1. World (always first).
 *   2. Location-derived scopes, in the locations' own weight-desc order: each
 *      location with a city → a city scope; a location with only a region → a
 *      region scope; and each distinct country → a country scope.
 *   3. The device-locale country (if not already present from a location).
 *
 * De-duped by scope id; capped at {@link MAX_SCOPES}. `locations` is expected
 * pre-sorted weight-desc (as `location-service.getAll/observeAll` returns it).
 */
export function deriveExploreScopes(
    locations: readonly ScopeLocationInput[],
    deviceCountryAlpha2: string | null | undefined,
): ExploreScope[] {
    const ordered: ExploreScope[] = [];
    const seen = new Set<string>();
    const push = (scope: ExploreScope) => {
        if (seen.has(scope.id)) return;
        seen.add(scope.id);
        ordered.push(scope);
    };

    for (const loc of locations) {
        const alpha3 = alpha2ToAlpha3(loc.countryCode);
        if (!alpha3) continue;
        const alpha2 = loc.countryCode.trim().toUpperCase();
        const city = loc.city?.trim();
        const region = loc.region?.trim();
        if (city) push(cityScope(alpha2, alpha3, city, region));
        else if (region) push(regionScope(alpha2, alpha3, region));
        push(countryScope(alpha2, alpha3));
    }

    const deviceAlpha3 = alpha2ToAlpha3(deviceCountryAlpha2);
    if (deviceAlpha3) {
        push(countryScope((deviceCountryAlpha2 ?? '').trim().toUpperCase(), deviceAlpha3));
    }

    return [worldScope(), ...ordered].slice(0, MAX_SCOPES);
}
