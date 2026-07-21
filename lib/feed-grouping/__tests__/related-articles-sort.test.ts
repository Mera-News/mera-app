import {
    makeRelatedComparator,
    sortRelatedArticles,
    type RelatedSortable,
} from '../related-articles-sort';
import type { UserGeoLanguageContext } from '../geo-language-priority';

// User: home = USA, other countries = Great Britain then India, app language en.
const CTX: UserGeoLanguageContext = {
    homeCountryAlpha3: 'USA',
    otherCountriesAlpha3: ['GBR', 'IND'],
    appLanguageBase: 'en',
};

function entry(overrides: Partial<RelatedSortable> & { id: string }): RelatedSortable {
    return {
        languageCode: overrides.languageCode ?? null,
        countryCodeAlpha3: overrides.countryCodeAlpha3 ?? null,
        publicationName: overrides.publicationName ?? null,
        pubDateMs: overrides.pubDateMs ?? null,
        ...overrides,
    };
}

const ids = (items: RelatedSortable[]) => items.map((i) => i.id);

describe('sortRelatedArticles — non-mutation', () => {
    it('returns a new array and leaves the input order untouched', () => {
        const input = [
            entry({ id: 'b', languageCode: 'fr' }),
            entry({ id: 'a', languageCode: 'en' }),
        ];
        const snapshot = ids(input);
        const out = sortRelatedArticles(input, CTX);

        expect(out).not.toBe(input);
        expect(ids(input)).toEqual(snapshot); // input unchanged
        expect(ids(out)).toEqual(['a', 'b']);
    });
});

describe('sortRelatedArticles — language key (highest priority)', () => {
    it('puts the user app language first, then others alphabetical, null last', () => {
        const out = sortRelatedArticles(
            [
                entry({ id: 'null-lang', languageCode: null }),
                entry({ id: 'fr', languageCode: 'fr' }),
                entry({ id: 'en', languageCode: 'en-US' }),
                entry({ id: 'de', languageCode: 'de' }),
            ],
            CTX,
        );
        expect(ids(out)).toEqual(['en', 'de', 'fr', 'null-lang']);
    });

    it('language dominates country — a user-language row outranks a home-country row', () => {
        const out = sortRelatedArticles(
            [
                entry({ id: 'home-country-fr', countryCodeAlpha3: 'USA', languageCode: 'fr' }),
                entry({ id: 'user-lang-fra', countryCodeAlpha3: 'FRA', languageCode: 'en' }),
            ],
            CTX,
        );
        expect(ids(out)).toEqual(['user-lang-fra', 'home-country-fr']);
    });
});

describe('sortRelatedArticles — country key', () => {
    it('orders ranked countries by rank, then unranked alphabetical, null last (within one language)', () => {
        const out = sortRelatedArticles(
            [
                entry({ id: 'null-c', languageCode: 'en', countryCodeAlpha3: null }),
                entry({ id: 'fra', languageCode: 'en', countryCodeAlpha3: 'FRA' }),
                entry({ id: 'ind', languageCode: 'en', countryCodeAlpha3: 'IND' }),
                entry({ id: 'usa', languageCode: 'en', countryCodeAlpha3: 'USA' }),
                entry({ id: 'gbr', languageCode: 'en', countryCodeAlpha3: 'GBR' }),
                entry({ id: 'aus', languageCode: 'en', countryCodeAlpha3: 'AUS' }),
            ],
            CTX,
        );
        // ranked: USA(0), GBR(1), IND(2); then unranked alphabetical AUS, FRA; then null.
        expect(ids(out)).toEqual(['usa', 'gbr', 'ind', 'aus', 'fra', 'null-c']);
    });
});

describe('sortRelatedArticles — publication + date + id tiebreaks', () => {
    it('breaks a language+country tie by publication name (case-insensitive), null last', () => {
        const out = sortRelatedArticles(
            [
                entry({ id: 'no-pub', languageCode: 'en', countryCodeAlpha3: 'USA', publicationName: null }),
                entry({ id: 'zeta', languageCode: 'en', countryCodeAlpha3: 'USA', publicationName: 'zeta times' }),
                entry({ id: 'alpha', languageCode: 'en', countryCodeAlpha3: 'USA', publicationName: 'Alpha Post' }),
            ],
            CTX,
        );
        expect(ids(out)).toEqual(['alpha', 'zeta', 'no-pub']);
    });

    it('breaks a full tie by pubDateMs desc, then id asc (determinism)', () => {
        const base = { languageCode: 'en', countryCodeAlpha3: 'USA', publicationName: 'Same Paper' };
        const out = sortRelatedArticles(
            [
                entry({ id: 'old', ...base, pubDateMs: 1_000 }),
                entry({ id: 'new-b', ...base, pubDateMs: 9_000 }),
                entry({ id: 'new-a', ...base, pubDateMs: 9_000 }),
            ],
            CTX,
        );
        expect(ids(out)).toEqual(['new-a', 'new-b', 'old']);
    });

    it('treats null/NaN pubDateMs as oldest', () => {
        const base = { languageCode: 'en', countryCodeAlpha3: 'USA', publicationName: 'Same Paper' };
        const out = sortRelatedArticles(
            [
                entry({ id: 'null-date', ...base, pubDateMs: null }),
                entry({ id: 'dated', ...base, pubDateMs: 5_000 }),
            ],
            CTX,
        );
        expect(ids(out)).toEqual(['dated', 'null-date']);
    });

    it('is a total order — sorting the reverse gives the same result (idempotent/deterministic)', () => {
        const items = [
            entry({ id: 'a', languageCode: 'en', countryCodeAlpha3: 'USA', publicationName: 'A', pubDateMs: 3 }),
            entry({ id: 'b', languageCode: 'fr', countryCodeAlpha3: 'FRA', publicationName: 'B', pubDateMs: 2 }),
            entry({ id: 'c', languageCode: 'de', countryCodeAlpha3: 'GBR', publicationName: 'C', pubDateMs: 1 }),
        ];
        const forward = ids(sortRelatedArticles(items, CTX));
        const reversed = ids(sortRelatedArticles([...items].reverse(), CTX));
        expect(forward).toEqual(reversed);
    });
});

describe('sortRelatedArticles — null context (legacy fail-open)', () => {
    it('disables the user-language/user-country buckets — no row is promoted for matching the user', () => {
        // With a real ctx these would order USA/en first; with null ctx neither
        // the app-language nor the home-country promotion applies, so the known
        // languages fall back to plain alphabetical (de < en).
        const out = sortRelatedArticles(
            [
                entry({ id: 'en-usa', languageCode: 'en', countryCodeAlpha3: 'USA', publicationName: 'Zeta' }),
                entry({ id: 'de-fra', languageCode: 'de', countryCodeAlpha3: 'FRA', publicationName: 'Alpha' }),
            ],
            null,
        );
        expect(ids(out)).toEqual(['de-fra', 'en-usa']);
    });

    it('falls back to publication → date → id when language and country are unknown', () => {
        const out = sortRelatedArticles(
            [
                entry({ id: 'z', languageCode: null, countryCodeAlpha3: null, publicationName: 'Zeta' }),
                entry({ id: 'a', languageCode: null, countryCodeAlpha3: null, publicationName: 'Alpha' }),
            ],
            null,
        );
        expect(ids(out)).toEqual(['a', 'z']); // by publication name only
    });
});

describe('makeRelatedComparator', () => {
    it('is exposed and usable directly with Array.prototype.sort', () => {
        const cmp = makeRelatedComparator(CTX);
        const out = [
            entry({ id: 'fr', languageCode: 'fr' }),
            entry({ id: 'en', languageCode: 'en' }),
        ].sort(cmp);
        expect(ids(out)).toEqual(['en', 'fr']);
    });
});
