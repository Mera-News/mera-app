import {
    baseLang,
    countryRank,
    normAlpha3,
    repPriorityTier,
    sourcePriorityTier,
    type GeoLanguageTagged,
    type UserGeoLanguageContext,
} from '../geo-language-priority';

// User: home = USA, other countries = Great Britain then India, app language zh.
const CTX: UserGeoLanguageContext = {
    homeCountryAlpha3: 'USA',
    otherCountriesAlpha3: ['GBR', 'IND'],
    appLanguageBase: 'zh',
};

function tag(
    countryCodeAlpha3: string | null,
    languageCode: string | null,
): GeoLanguageTagged {
    return { countryCodeAlpha3, languageCode };
}

// ===========================================================================
// baseLang
// ===========================================================================

describe('baseLang', () => {
    it('lower-cases and strips the region subtag', () => {
        expect(baseLang('EN')).toBe('en');
        expect(baseLang('pt-BR')).toBe('pt');
    });

    it('collapses script/region variants to the base tag (zh-Hans → zh)', () => {
        expect(baseLang('zh-Hans')).toBe('zh');
        expect(baseLang('zh-Hant')).toBe('zh');
    });

    it('trims whitespace', () => {
        expect(baseLang('  fr  ')).toBe('fr');
        expect(baseLang(' en-US ')).toBe('en');
    });

    it('maps null/undefined/empty to null', () => {
        expect(baseLang(null)).toBeNull();
        expect(baseLang(undefined)).toBeNull();
        expect(baseLang('')).toBeNull();
        expect(baseLang('   ')).toBeNull();
    });
});

// ===========================================================================
// normAlpha3
// ===========================================================================

describe('normAlpha3', () => {
    it('upper-cases and trims', () => {
        expect(normAlpha3('usa')).toBe('USA');
        expect(normAlpha3('  gbr ')).toBe('GBR');
    });

    it('maps null/undefined/empty to null', () => {
        expect(normAlpha3(null)).toBeNull();
        expect(normAlpha3(undefined)).toBeNull();
        expect(normAlpha3('')).toBeNull();
        expect(normAlpha3('   ')).toBeNull();
    });
});

// ===========================================================================
// repPriorityTier — the 4 tiers
// ===========================================================================

describe('repPriorityTier', () => {
    it('tier 0 for the home country (case/whitespace-insensitive)', () => {
        expect(repPriorityTier(tag('USA', 'en'), CTX)).toBe(0);
        expect(repPriorityTier(tag('  usa ', 'en'), CTX)).toBe(0);
    });

    it('tier 0 for the home country even in a foreign language (country beats language)', () => {
        expect(repPriorityTier(tag('USA', 'fr'), CTX)).toBe(0);
    });

    it('tier 1 for another of the user countries', () => {
        expect(repPriorityTier(tag('GBR', 'en'), CTX)).toBe(1);
        expect(repPriorityTier(tag('ind', 'hi'), CTX)).toBe(1);
    });

    it('tier 2 for an app-language match when no country match (base compare)', () => {
        expect(repPriorityTier(tag('FRA', 'zh-Hans'), CTX)).toBe(2);
        expect(repPriorityTier(tag(null, 'zh'), CTX)).toBe(2);
    });

    it('tier 3 for everything else', () => {
        expect(repPriorityTier(tag('FRA', 'fr'), CTX)).toBe(3);
    });

    it('tier 3 for null country and null language', () => {
        expect(repPriorityTier(tag(null, null), CTX)).toBe(3);
    });

    it('null context → always tier 3 (universal fail-open)', () => {
        expect(repPriorityTier(tag('USA', 'zh'), null)).toBe(3);
        expect(repPriorityTier(tag('GBR', 'en'), null)).toBe(3);
        expect(repPriorityTier(tag(null, null), null)).toBe(3);
    });

    it('does not match tier 0/1 when the context home/others are absent', () => {
        const langOnly: UserGeoLanguageContext = {
            homeCountryAlpha3: null,
            otherCountriesAlpha3: [],
            appLanguageBase: 'en',
        };
        expect(repPriorityTier(tag('USA', 'en'), langOnly)).toBe(2); // language match only
        expect(repPriorityTier(tag('USA', 'fr'), langOnly)).toBe(3);
    });
});

// ===========================================================================
// countryRank
// ===========================================================================

describe('countryRank', () => {
    it('ranks home 0, then other countries in order', () => {
        expect(countryRank('USA', CTX)).toBe(0);
        expect(countryRank('GBR', CTX)).toBe(1);
        expect(countryRank('IND', CTX)).toBe(2);
    });

    it('normalizes case/whitespace before ranking', () => {
        expect(countryRank(' usa ', CTX)).toBe(0);
        expect(countryRank('gbr', CTX)).toBe(1);
    });

    it('returns Infinity for an unranked country', () => {
        expect(countryRank('FRA', CTX)).toBe(Infinity);
    });

    it('returns Infinity for null/empty code', () => {
        expect(countryRank(null, CTX)).toBe(Infinity);
        expect(countryRank(undefined, CTX)).toBe(Infinity);
        expect(countryRank('', CTX)).toBe(Infinity);
    });

    it('returns Infinity for a null context', () => {
        expect(countryRank('USA', null)).toBe(Infinity);
    });

    it('ranks others from 0 when there is no home country', () => {
        const noHome: UserGeoLanguageContext = {
            homeCountryAlpha3: null,
            otherCountriesAlpha3: ['GBR', 'IND'],
            appLanguageBase: null,
        };
        expect(countryRank('GBR', noHome)).toBe(0);
        expect(countryRank('IND', noHome)).toBe(1);
    });
});

// ===========================================================================
// sourcePriorityTier (source-pref, D3)
// ===========================================================================

describe('sourcePriorityTier', () => {
    const PREF_CTX: UserGeoLanguageContext = {
        homeCountryAlpha3: 'USA',
        otherCountriesAlpha3: ['GBR'],
        appLanguageBase: 'en',
        preferredPublications: new Set(['times of india']),
        preferredCountriesAlpha3: new Set(['IND']),
    };

    function src(publicationName: string | null, countryCodeAlpha3: string | null) {
        return { publicationName, countryCodeAlpha3 };
    }

    it('tier 0 for a publication the user named', () => {
        expect(sourcePriorityTier(src('Times of India', 'IND'), PREF_CTX)).toBe(0);
    });

    it('normalizes the publication name (case + collapsed whitespace) before matching', () => {
        expect(sourcePriorityTier(src('  TIMES   OF  India ', null), PREF_CTX)).toBe(0);
    });

    it('tier 1 for a source inside a preferred COUNTRY SCOPE', () => {
        expect(sourcePriorityTier(src('The Hindu', 'IND'), PREF_CTX)).toBe(1);
    });

    it('a named publication BEATS a country scope — the narrower statement wins', () => {
        // Both would match; the named-publication rule must be checked first.
        expect(sourcePriorityTier(src('Times of India', 'IND'), PREF_CTX)).toBe(0);
    });

    it('country scope compares on normalized alpha-3', () => {
        expect(sourcePriorityTier(src(null, ' ind '), PREF_CTX)).toBe(1);
    });

    it('tier 2 for a source matching neither', () => {
        expect(sourcePriorityTier(src('Le Monde', 'FRA'), PREF_CTX)).toBe(2);
    });

    it('a preferred country does NOT leak from the geo tiers — home country is not a preference', () => {
        // USA is the user's HOME country (geo tier 0) but was never asked for as
        // a source preference, so it must stay source tier 2. Confusing the two
        // would make every home-country article "preferred" for free.
        expect(sourcePriorityTier(src('CNN', 'USA'), PREF_CTX)).toBe(2);
    });

    // --- Fail-open / regression contract ------------------------------------

    it('null context ⇒ always tier 2', () => {
        expect(sourcePriorityTier(src('Times of India', 'IND'), null)).toBe(2);
    });

    it('a context with NO preference fields (every pre-source-pref context) ⇒ always tier 2', () => {
        expect(sourcePriorityTier(src('Times of India', 'IND'), CTX)).toBe(2);
    });

    it('a context with EMPTY preference sets ⇒ always tier 2', () => {
        const empty: UserGeoLanguageContext = {
            ...CTX,
            preferredPublications: new Set(),
            preferredCountriesAlpha3: new Set(),
        };
        expect(sourcePriorityTier(src('Times of India', 'IND'), empty)).toBe(2);
    });

    it('a null/empty publication name never matches an empty-string preference', () => {
        const odd: UserGeoLanguageContext = {
            ...CTX,
            preferredPublications: new Set(['']),
            preferredCountriesAlpha3: new Set(),
        };
        expect(sourcePriorityTier(src(null, 'IND'), odd)).toBe(2);
        expect(sourcePriorityTier(src('   ', 'IND'), odd)).toBe(2);
    });
});
