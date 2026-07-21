import {
    baseLang,
    countryRank,
    normAlpha3,
    repPriorityTier,
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
