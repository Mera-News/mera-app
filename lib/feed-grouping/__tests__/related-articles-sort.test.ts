import {
    orderRelatedArticles,
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
const countries = (items: RelatedSortable[]) =>
    items.map((i) => i.countryCodeAlpha3);

/** n rows in one country, ids prefixed so they stay identifiable. */
function block(a3: string, n: number): RelatedSortable[] {
    return Array.from({ length: n }, (_, i) =>
        entry({ id: `${a3}-${i}`, countryCodeAlpha3: a3 }),
    );
}

/**
 * True when every country's rows are adjacent — the invariant that actually
 * proves blocks formed (size ordering alone doesn't).
 */
function isContiguousByCountry(items: RelatedSortable[]): boolean {
    const seen = new Set<string | null>();
    let prev: string | null | undefined;
    for (const item of items) {
        const c = item.countryCodeAlpha3;
        if (c !== prev) {
            if (seen.has(c)) return false; // country reappears after a different one
            seen.add(c);
            prev = c;
        }
    }
    return true;
}

describe('orderRelatedArticles — non-mutation', () => {
    it('returns a new array and leaves the input order untouched', () => {
        const input = [
            entry({ id: 'b', countryCodeAlpha3: 'FRA' }),
            entry({ id: 'a', countryCodeAlpha3: 'USA' }),
        ];
        const snapshot = ids(input);
        const out = orderRelatedArticles(input, 'USA', CTX);

        expect(out).not.toBe(input);
        expect(ids(input)).toEqual(snapshot); // input unchanged
        expect(ids(out)).toEqual(['a', 'b']);
    });
});

describe('orderRelatedArticles — current article country (tier A)', () => {
    it('leads with the current country even when it is the SMALLEST block', () => {
        const out = orderRelatedArticles(
            [...block('USA', 5), ...block('FRA', 1), ...block('DEU', 3)],
            'FRA',
            CTX,
        );

        expect(countries(out)).toEqual([
            'FRA', // 1 row, but it is the current article's country
            'USA',
            'USA',
            'USA',
            'USA',
            'USA',
            'DEU',
            'DEU',
            'DEU',
        ]);
    });

    it('renders the current country exactly once (never a second block)', () => {
        const out = orderRelatedArticles(
            [...block('USA', 2), ...block('FRA', 4)],
            'USA',
            CTX,
        );

        expect(countries(out)).toEqual(['USA', 'USA', 'FRA', 'FRA', 'FRA', 'FRA']);
        expect(isContiguousByCountry(out)).toBe(true);
    });

    it('matches the current country case/whitespace-insensitively', () => {
        const out = orderRelatedArticles(
            [...block('DEU', 4), ...block('FRA', 1)],
            '  fra ',
            CTX,
        );

        expect(countries(out)[0]).toBe('FRA');
    });

    it('falls back to pure block ordering when the current country is null', () => {
        const out = orderRelatedArticles(
            [...block('FRA', 1), ...block('DEU', 3)],
            null,
            CTX,
        );

        expect(countries(out)).toEqual(['DEU', 'DEU', 'DEU', 'FRA']);
    });

    it('does not create a tier A block when no row matches the current country', () => {
        const out = orderRelatedArticles(
            [...block('DEU', 3), ...block('FRA', 1)],
            'JPN',
            CTX,
        );

        expect(countries(out)).toEqual(['DEU', 'DEU', 'DEU', 'FRA']);
    });
});

describe('orderRelatedArticles — remaining countries (tier B)', () => {
    it('orders blocks by size DESC', () => {
        const out = orderRelatedArticles(
            [...block('FRA', 1), ...block('JPN', 4), ...block('BRA', 2)],
            null,
            CTX,
        );

        expect(countries(out)).toEqual([
            'JPN',
            'JPN',
            'JPN',
            'JPN',
            'BRA',
            'BRA',
            'FRA',
        ]);
    });

    it("breaks size ties by the user's country rank, then alpha-3", () => {
        // Equal size (2 each). Rank: USA (home) 0 → GBR 1 → IND 2 → unranked.
        // Unranked DEU/FRA fall through to alphabetical.
        const out = orderRelatedArticles(
            [
                ...block('FRA', 2),
                ...block('IND', 2),
                ...block('DEU', 2),
                ...block('USA', 2),
                ...block('GBR', 2),
            ],
            null,
            CTX,
        );

        expect(countries(out).filter((c, i, arr) => c !== arr[i - 1])).toEqual([
            'USA',
            'GBR',
            'IND',
            'DEU',
            'FRA',
        ]);
    });

    it('keeps size ahead of rank — a big unranked block beats the home country', () => {
        const out = orderRelatedArticles(
            [...block('USA', 1), ...block('JPN', 3)],
            null,
            CTX,
        );

        expect(countries(out)).toEqual(['JPN', 'JPN', 'JPN', 'USA']);
    });

    it('is contiguous by country across a messy interleaved input', () => {
        const out = orderRelatedArticles(
            [
                entry({ id: '1', countryCodeAlpha3: 'FRA' }),
                entry({ id: '2', countryCodeAlpha3: 'USA' }),
                entry({ id: '3', countryCodeAlpha3: 'DEU' }),
                entry({ id: '4', countryCodeAlpha3: 'FRA' }),
                entry({ id: '5', countryCodeAlpha3: null }),
                entry({ id: '6', countryCodeAlpha3: 'USA' }),
                entry({ id: '7', countryCodeAlpha3: 'DEU' }),
                entry({ id: '8', countryCodeAlpha3: 'JPN' }),
                entry({ id: '9', countryCodeAlpha3: 'FRA' }),
            ],
            'JPN',
            CTX,
        );

        expect(isContiguousByCountry(out)).toBe(true);
        expect(countries(out)[0]).toBe('JPN');
    });
});

describe('orderRelatedArticles — countryless rows (tier C)', () => {
    it('puts rows with no country last, after every known country', () => {
        const out = orderRelatedArticles(
            [
                entry({ id: 'none-1' }),
                ...block('FRA', 1),
                entry({ id: 'none-2' }),
                ...block('DEU', 3),
            ],
            'FRA',
            CTX,
        );

        expect(countries(out)).toEqual([
            'FRA',
            'DEU',
            'DEU',
            'DEU',
            null,
            null,
        ]);
    });

    it('treats an empty-string country as countryless', () => {
        const out = orderRelatedArticles(
            [entry({ id: 'blank', countryCodeAlpha3: '  ' }), ...block('DEU', 1)],
            null,
            CTX,
        );

        expect(ids(out)).toEqual(['DEU-0', 'blank']);
    });
});

describe('orderRelatedArticles — within-block order', () => {
    it('puts the app language first, then others alphabetical, null last', () => {
        const out = orderRelatedArticles(
            [
                entry({ id: 'none', countryCodeAlpha3: 'IND', languageCode: null }),
                entry({ id: 'ta', countryCodeAlpha3: 'IND', languageCode: 'ta' }),
                entry({ id: 'en', countryCodeAlpha3: 'IND', languageCode: 'en-IN' }),
                entry({ id: 'hi', countryCodeAlpha3: 'IND', languageCode: 'hi' }),
            ],
            'IND',
            CTX,
        );

        expect(ids(out)).toEqual(['en', 'hi', 'ta', 'none']);
    });

    it('orders by publication name, then date DESC, then id ASC', () => {
        const out = orderRelatedArticles(
            [
                entry({
                    id: 'z',
                    countryCodeAlpha3: 'USA',
                    languageCode: 'en',
                    publicationName: null,
                }),
                entry({
                    id: 'b',
                    countryCodeAlpha3: 'USA',
                    languageCode: 'en',
                    publicationName: 'beta',
                }),
                entry({
                    id: 'a2',
                    countryCodeAlpha3: 'USA',
                    languageCode: 'en',
                    publicationName: 'Alpha',
                    pubDateMs: 100,
                }),
                entry({
                    id: 'a1',
                    countryCodeAlpha3: 'USA',
                    languageCode: 'en',
                    publicationName: 'alpha',
                    pubDateMs: 200,
                }),
            ],
            'USA',
            CTX,
        );

        // Alpha (case-insensitive) before beta; newest first inside alpha;
        // the null publication trails.
        expect(ids(out)).toEqual(['a1', 'a2', 'b', 'z']);
    });

    it('never lets a within-block key pull a row out of its block', () => {
        // The USA row is in the user's app language AND home country, but DEU is
        // the current article's country, so DEU still leads.
        const out = orderRelatedArticles(
            [
                entry({
                    id: 'usa',
                    countryCodeAlpha3: 'USA',
                    languageCode: 'en',
                    publicationName: 'AAA',
                }),
                entry({
                    id: 'deu',
                    countryCodeAlpha3: 'DEU',
                    languageCode: 'de',
                    publicationName: 'zzz',
                }),
            ],
            'DEU',
            CTX,
        );

        expect(ids(out)).toEqual(['deu', 'usa']);
    });
});

describe('orderRelatedArticles — determinism', () => {
    const items = [
        entry({ id: 'a', countryCodeAlpha3: 'USA', languageCode: 'en', pubDateMs: 5 }),
        entry({ id: 'b', countryCodeAlpha3: 'USA', languageCode: 'en', pubDateMs: 5 }),
        entry({ id: 'c', countryCodeAlpha3: 'DEU', languageCode: 'de' }),
        entry({ id: 'd', countryCodeAlpha3: 'FRA', languageCode: 'fr' }),
        entry({ id: 'e', countryCodeAlpha3: null }),
        entry({ id: 'f', countryCodeAlpha3: 'DEU', languageCode: 'en' }),
    ];

    it('produces the same order regardless of input order', () => {
        const forward = ids(orderRelatedArticles(items, 'FRA', CTX));
        const reversed = ids(orderRelatedArticles([...items].reverse(), 'FRA', CTX));

        expect(reversed).toEqual(forward);
    });

    it('is idempotent — re-ordering an ordered list is a no-op', () => {
        const once = orderRelatedArticles(items, 'FRA', CTX);
        const twice = orderRelatedArticles(once, 'FRA', CTX);

        expect(ids(twice)).toEqual(ids(once));
    });

    it('handles empty and single-item lists', () => {
        expect(orderRelatedArticles([], 'USA', CTX)).toEqual([]);
        expect(ids(orderRelatedArticles([entry({ id: 'only' })], 'USA', CTX))).toEqual([
            'only',
        ]);
    });
});

describe('orderRelatedArticles — null context (fail-open)', () => {
    it('still forms blocks: current country first, then size DESC', () => {
        const out = orderRelatedArticles(
            [...block('USA', 1), ...block('JPN', 3), ...block('FRA', 2)],
            'USA',
            null,
        );

        expect(countries(out)).toEqual([
            'USA',
            'JPN',
            'JPN',
            'JPN',
            'FRA',
            'FRA',
        ]);
    });

    it('breaks size ties by alpha-3 alone (every rank collapses to Infinity)', () => {
        const out = orderRelatedArticles(
            [...block('USA', 2), ...block('DEU', 2), ...block('GBR', 2)],
            null,
            null,
        );

        expect(countries(out).filter((c, i, arr) => c !== arr[i - 1])).toEqual([
            'DEU',
            'GBR',
            'USA',
        ]);
        expect(isContiguousByCountry(out)).toBe(true);
    });

    it('ignores the app-language preference within a block', () => {
        const out = orderRelatedArticles(
            [
                entry({ id: 'fr', countryCodeAlpha3: 'USA', languageCode: 'fr' }),
                entry({ id: 'en', countryCodeAlpha3: 'USA', languageCode: 'en' }),
            ],
            'USA',
            null,
        );

        // Both land in language group 1 → alphabetical by base tag.
        expect(ids(out)).toEqual(['en', 'fr']);
    });
});
