/**
 * Shared geo/language priority helpers for the For-You feed.
 *
 * Pure functions only — NO imports from React Native, WatermelonDB, Zustand
 * stores, or the logger. This module is unit-tested in isolation and is safe to
 * import from any layer (feed sync, scoring pipeline, screen memos). The
 * RN-coupled loader that BUILDS a `UserGeoLanguageContext` from on-device
 * `locations` + the app-language store lives in
 * `lib/user-context/user-geo-language-context.ts`; this file only consumes one.
 *
 * The problem it solves: representative election (which sibling of a
 * duplicate-story group gets scored / fronts a card) and the merged
 * "Related Articles" list were country/language-blind. The user wants a
 * priority order anchored to their own signals: an article from the user's
 * HOME country outranks one from another of the user's countries, which
 * outranks one merely in the user's app-UI language, which outranks the rest.
 *
 * Country-code format (subtle): article/publication `country_code` is ISO
 * ALPHA-3, and so are the codes carried in `UserGeoLanguageContext` (the loader
 * converts the alpha-2 `locations.countryCode` + device country via
 * `alpha2ToAlpha3` before building the context). Language codes are compared on
 * their BASE tag (`zh-Hans` → `zh`, `pt-BR` → `pt`) — a known, deliberate
 * tradeoff (a `zh-Hant` article matches a `zh-Hans` user), consistent with the
 * existing translation-status logic.
 *
 * Fail-open contract: a `null` context (the loader failed, or nothing is known
 * about the user) collapses every tier to 3 and every rank to `Infinity`, so
 * the call site's existing tiebreaks decide alone — byte-identical to the
 * pre-priority behavior.
 */

/**
 * The user's geo/language signals, resolved once per run from on-device state.
 * All country codes are ISO ALPHA-3 (already normalized upper-case); the
 * language is a BASE tag (`baseLang`-normalized) or null.
 */
export interface UserGeoLanguageContext {
    /** Home country (ISO alpha-3), or null when neither a home location nor the device country resolves. */
    homeCountryAlpha3: string | null;
    /** The user's OTHER countries (ISO alpha-3), ranked weight-desc, deduped, home excluded. */
    otherCountriesAlpha3: string[];
    /** App-UI language base tag (e.g. `zh`), or null. */
    appLanguageBase: string | null;
}

/** The minimal geo/language tag a rankable item carries (decoupled from any model). */
export interface GeoLanguageTagged {
    /** Publishing country, ISO alpha-3 (as stored on the row). Null when unknown. */
    countryCodeAlpha3: string | null;
    /** Article/publication language code (may be a full tag like `zh-Hans`). Null when unknown. */
    languageCode: string | null;
}

/**
 * Base-language tag of a code: `trim().toLowerCase().split('-')[0]`, with an
 * empty result mapped to null. `zh-Hans` → `zh`, `EN` → `en`, `''`/null → null.
 * Never throws.
 */
export function baseLang(code: string | null | undefined): string | null {
    const base = (code ?? '').trim().toLowerCase().split('-')[0];
    return base === '' ? null : base;
}

/**
 * Normalize a country code to the comparable ISO alpha-3 form:
 * `trim().toUpperCase()`, with an empty result mapped to null. Never throws.
 * (Does NOT convert alpha-2 → alpha-3 — that is the loader's job; this only
 * canonicalizes an already-alpha-3 string for comparison.)
 */
export function normAlpha3(code: string | null | undefined): string | null {
    const a3 = (code ?? '').trim().toUpperCase();
    return a3 === '' ? null : a3;
}

/** The user's countries in priority order: `[home, ...others]`, null home dropped. */
function rankedCountries(ctx: UserGeoLanguageContext): string[] {
    return ctx.homeCountryAlpha3 !== null
        ? [ctx.homeCountryAlpha3, ...ctx.otherCountriesAlpha3]
        : ctx.otherCountriesAlpha3;
}

/**
 * Priority tier of an item against the user's context (lower = higher priority):
 *
 *   0 — HOME country (item's alpha-3 === `ctx.homeCountryAlpha3`)
 *   1 — another of the USER's countries (item's alpha-3 ∈ `otherCountriesAlpha3`)
 *   2 — the user's APP language (base compare; only when no country match)
 *   3 — everything else (incl. null country/language)
 *
 * Country beats language: a home-country article in a foreign language is still
 * tier 0. `ctx === null` → always tier 3 (universal fail-open — legacy behavior).
 * Never throws.
 */
export function repPriorityTier(
    item: GeoLanguageTagged,
    ctx: UserGeoLanguageContext | null,
): 0 | 1 | 2 | 3 {
    if (ctx === null) {
        return 3;
    }
    const country = normAlpha3(item.countryCodeAlpha3);
    if (country !== null) {
        if (ctx.homeCountryAlpha3 !== null && country === ctx.homeCountryAlpha3) {
            return 0;
        }
        // Set membership for the "other user country" test — O(1) regardless of
        // how many countries the user has.
        const others = new Set(ctx.otherCountriesAlpha3);
        if (others.has(country)) {
            return 1;
        }
    }
    const lang = baseLang(item.languageCode);
    if (lang !== null && ctx.appLanguageBase !== null && lang === ctx.appLanguageBase) {
        return 2;
    }
    return 3;
}

/**
 * Rank of a country within the user's priority list `[home, ...otherCountries]`:
 * the home country is 0, the first other country 1, and so on. Returns
 * `Infinity` for a country not in the list, a null/empty code, or a null
 * context (unranked sorts last). Shared with the Related-Articles sort.
 * Never throws.
 */
export function countryRank(
    alpha3: string | null | undefined,
    ctx: UserGeoLanguageContext | null,
): number {
    if (ctx === null) {
        return Infinity;
    }
    const country = normAlpha3(alpha3);
    if (country === null) {
        return Infinity;
    }
    const idx = rankedCountries(ctx).indexOf(country);
    return idx === -1 ? Infinity : idx;
}
