// Explore tab — scope derivation.
//
// Turns the user's on-device `locations` (never sent to the server) plus the
// device-locale country into the horizontal scope chips shown on the Explore
// tab. Each scope drives a DIRECT server-paginated article query — there is no
// scoring, no LLM, and nothing persisted (see components/custom/explore).
//
// Chips are TOP STORIES + COUNTRY + World (app-rethink wave, 2026-07-20 +
// top-stories-blend wave): city/region derivation was removed because
// geo-tags are dormant in prod (all null), so those chips showed ~nothing.
// Each location still contributes its country. The `'city'|'region'`
// scope-kind members and their builder functions are kept — see the
// DEPRECATED markers below — purely for type compatibility with any
// already-persisted `explore_last_scope` id; ExploreScreen already falls back
// to World when a persisted id no longer resolves, so no data migration is
// needed here.
//
// The 'top' scope (id 'top-stories') is a blended GLOBAL+home feed (see
// lib/explore/top-stories.ts) — it carries no country code of its own.
// "Home" is the device-locale country when mappable, else the highest-weight
// location country; it's promoted to the 2nd chip (right after Top stories,
// ahead of World) and de-duped out of the location-derived tail so it never
// appears twice.
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

export type ExploreScopeKind = 'top' | 'world' | 'country' | 'city' | 'region';

export interface ExploreScope {
    /** Stable identity (also the FlatList key + persisted selection). */
    readonly id: string;
    readonly kind: ExploreScopeKind;
    /**
     * Display label for country/city/region scopes. Empty for `world`/`top` —
     * those chips render translated labels instead (this module is i18n-free
     * so it stays a pure, testable function).
     */
    readonly label: string;
    readonly icon: 'public' | 'location-city' | 'map' | 'flag' | 'trending-up';
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

/** Hard cap on visible scope chips (Top stories + World + up to 4 more). */
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

function topScope(): ExploreScope {
    return { id: 'top-stories', kind: 'top', label: '', icon: 'trending-up', countryCodeAlpha3: null };
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
 * Build the Explore scope chips.
 *
 * Order (also the cap priority — Top stories, home, and World always survive;
 * the lowest-priority tail is dropped past {@link MAX_SCOPES}):
 *   1. Top stories (always first — the blended GLOBAL+home feed).
 *   2. Home — the device-locale country when mappable, else the
 *      highest-weight location country (locations arrive pre-sorted
 *      weight-desc). Omitted when neither resolves.
 *   3. World.
 *   4. The remaining location-derived country scopes (weight-desc, home
 *      excluded so it never appears twice). City/region scopes are no longer
 *      derived — see the module header.
 *
 * De-duped by scope id; capped at {@link MAX_SCOPES}.
 */
export function deriveExploreScopes(
    locations: readonly ScopeLocationInput[],
    deviceCountryAlpha2: string | null | undefined,
): ExploreScope[] {
    const locationScopes: ExploreScope[] = [];
    const seenAlpha3 = new Set<string>();
    for (const loc of locations) {
        const alpha3 = alpha2ToAlpha3(loc.countryCode);
        if (!alpha3 || seenAlpha3.has(alpha3)) continue;
        seenAlpha3.add(alpha3);
        const alpha2 = loc.countryCode.trim().toUpperCase();
        locationScopes.push(countryScope(alpha2, alpha3));
    }

    const deviceAlpha3 = alpha2ToAlpha3(deviceCountryAlpha2);
    const home: ExploreScope | null = deviceAlpha3
        ? countryScope((deviceCountryAlpha2 ?? '').trim().toUpperCase(), deviceAlpha3)
        : (locationScopes[0] ?? null);

    const ordered: ExploreScope[] = [topScope()];
    if (home) ordered.push(home);
    ordered.push(worldScope());
    for (const scope of locationScopes) {
        if (home && scope.id === home.id) continue;
        ordered.push(scope);
    }

    return ordered.slice(0, MAX_SCOPES);
}
