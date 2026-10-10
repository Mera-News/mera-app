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

// ===========================================================================
// source-pref — tier P (preferred sources lift to the head of the list)
// ===========================================================================

describe('orderRelatedArticles — preferred sources (source-pref, D1/D3)', () => {
    const PREF_CTX: UserGeoLanguageContext = {
        ...CTX,
        preferredPublications: new Set(['times of india']),
        preferredCountriesAlpha3: new Set(['IND']),
    };

    it('a preferred PUBLICATION lifts to the top, ahead of the current article\'s own country block', () => {
        const items = [
            ...block('USA', 3), // current-article country = tier A, normally first
            entry({ id: 'toi', countryCodeAlpha3: 'IND', publicationName: 'Times of India' }),
        ];
        const out = orderRelatedArticles(items, 'USA', PREF_CTX);
        expect(out[0].id).toBe('toi');
    });

    it('a preferred COUNTRY SCOPE lifts its rows to the top too', () => {
        const items = [
            ...block('USA', 3),
            entry({ id: 'hindu', countryCodeAlpha3: 'IND', publicationName: 'The Hindu' }),
        ];
        const out = orderRelatedArticles(items, 'USA', PREF_CTX);
        expect(out[0].id).toBe('hindu');
    });

    it('within tier P a named publication comes before a country-scope match', () => {
        const items = [
            entry({ id: 'hindu', countryCodeAlpha3: 'IND', publicationName: 'The Hindu' }),
            entry({ id: 'toi', countryCodeAlpha3: 'IND', publicationName: 'Times of India' }),
            ...block('USA', 2),
        ];
        const out = orderRelatedArticles(items, 'USA', PREF_CTX);
        expect(ids(out).slice(0, 2)).toEqual(['toi', 'hindu']);
    });

    it('tier P is a CROSS-COUNTRY head block — the remaining rows still form contiguous country blocks', () => {
        const items = [
            entry({ id: 'toi', countryCodeAlpha3: 'IND', publicationName: 'Times of India' }),
            entry({ id: 'guardian', countryCodeAlpha3: 'GBR', publicationName: 'The Guardian' }),
            ...block('USA', 2),
            ...block('FRA', 3),
        ];
        // Prefer one GBR paper by name too, so tier P spans two countries.
        const ctx: UserGeoLanguageContext = {
            ...CTX,
            preferredPublications: new Set(['times of india', 'the guardian']),
            preferredCountriesAlpha3: new Set(),
        };
        const out = orderRelatedArticles(items, 'USA', ctx);
        expect(ids(out).slice(0, 2)).toEqual(['guardian', 'toi']); // alphabetical within the block
        // Everything after the head block is still contiguous by country.
        const tail = countries(out.slice(2));
        expect(tail).toEqual([...new Set(tail)].flatMap((c) => tail.filter((x) => x === c)));
    });

    it('block sizes EXCLUDE lifted rows, so a preference cannot reshuffle the other blocks', () => {
        // FRA has 3 rows; IND has 4, of which 3 lift into tier P. If lifted rows
        // still counted, IND (4) would out-rank FRA (3) and its single remaining
        // row would render before the French block.
        const items = [
            ...block('FRA', 3),
            entry({ id: 'ind-plain', countryCodeAlpha3: 'IND', publicationName: 'Plain Indian Paper' }),
            entry({ id: 'toi-1', countryCodeAlpha3: 'IND', publicationName: 'Times of India' }),
            entry({ id: 'toi-2', countryCodeAlpha3: 'IND', publicationName: 'Times of India' }),
            entry({ id: 'toi-3', countryCodeAlpha3: 'IND', publicationName: 'Times of India' }),
        ];
        const ctx: UserGeoLanguageContext = {
            ...CTX,
            preferredPublications: new Set(['times of india']),
            preferredCountriesAlpha3: new Set(),
        };
        const out = orderRelatedArticles(items, null, ctx);
        expect(ids(out).slice(0, 3)).toEqual(['toi-1', 'toi-2', 'toi-3']);
        // FRA (3 remaining) beats IND (1 remaining).
        expect(countries(out).slice(3)).toEqual(['FRA', 'FRA', 'FRA', 'IND']);
    });

    // --- Regression contract --------------------------------------------------

    it('REGRESSION CONTRACT: with no source preferences the order is identical to today', () => {
        const items = [
            ...block('USA', 2),
            ...block('FRA', 3),
            entry({ id: 'toi', countryCodeAlpha3: 'IND', publicationName: 'Times of India' }),
            entry({ id: 'nowhere', countryCodeAlpha3: null, publicationName: 'Nowhere Post' }),
        ];
        const baseline = orderRelatedArticles(items, 'USA', CTX);
        const emptySets: UserGeoLanguageContext = {
            ...CTX,
            preferredPublications: new Set(),
            preferredCountriesAlpha3: new Set(),
        };
        expect(orderRelatedArticles(items, 'USA', emptySets)).toEqual(baseline);
        expect(orderRelatedArticles(items, 'USA', null)).toEqual(
            orderRelatedArticles(items, 'USA', null),
        );
    });
});

// ===========================================================================
// ordering modes (`RelatedSortMode`)
// ===========================================================================

describe('orderRelatedArticles — mode selection', () => {
    const MODE_PREF_CTX: UserGeoLanguageContext = {
        ...CTX,
        preferredPublications: new Set(['times of india']),
        preferredCountriesAlpha3: new Set(['DEU']),
    };

    /** A fixture exercising every `relevance` key at once: a preferred
     *  publication, a preferred country scope, the current article's country,
     *  two rival country blocks, app-language vs other-language rows, a null
     *  publication, and a countryless/undated row. */
    const GOLDEN: RelatedSortable[] = [
        entry({ id: 'g1', countryCodeAlpha3: 'FRA', languageCode: 'fr', publicationName: 'Le Monde', pubDateMs: 300 }),
        entry({ id: 'g2', countryCodeAlpha3: 'USA', languageCode: 'en', publicationName: 'NYT', pubDateMs: 100 }),
        entry({ id: 'g3', countryCodeAlpha3: 'IND', languageCode: 'hi', publicationName: 'Times of India', pubDateMs: 500 }),
        entry({ id: 'g4', countryCodeAlpha3: 'DEU', languageCode: 'de', publicationName: 'Die Zeit', pubDateMs: 200 }),
        entry({ id: 'g5', countryCodeAlpha3: null, languageCode: null, publicationName: null, pubDateMs: null }),
        entry({ id: 'g6', countryCodeAlpha3: 'FRA', languageCode: 'en', publicationName: 'AFP', pubDateMs: 400 }),
        entry({ id: 'g7', countryCodeAlpha3: 'USA', languageCode: 'en', publicationName: 'NYT', pubDateMs: 900 }),
        entry({ id: 'g8', countryCodeAlpha3: 'FRA', languageCode: 'fr', publicationName: null, pubDateMs: 700 }),
        entry({ id: 'g9', countryCodeAlpha3: 'GBR', languageCode: 'en', publicationName: 'BBC', pubDateMs: 600 }),
        entry({ id: 'g10', countryCodeAlpha3: 'DEU', languageCode: 'de', publicationName: 'FAZ', pubDateMs: 800 }),
    ];

    /**
     * GOLDEN ORDER — captured by running this exact fixture through
     * `orderRelatedArticles` BEFORE the `mode` parameter existed. It is the
     * regression lock on "`'relevance'` is byte-identical to today": if adding
     * the mode switch had perturbed any tiered key, this literal would move.
     */
    const GOLDEN_RELEVANCE_ORDER = ['g3', 'g4', 'g10', 'g7', 'g2', 'g6', 'g1', 'g8', 'g9', 'g5'];

    it("'relevance' reproduces the pre-mode ordering exactly", () => {
        expect(ids(orderRelatedArticles(GOLDEN, 'USA', MODE_PREF_CTX, 'relevance'))).toEqual(
            GOLDEN_RELEVANCE_ORDER,
        );
    });

    it("'relevance' is the default — the omitted argument and the explicit value agree", () => {
        expect(ids(orderRelatedArticles(GOLDEN, 'USA', MODE_PREF_CTX))).toEqual(
            GOLDEN_RELEVANCE_ORDER,
        );
    });

    it("'oldest' sorts by publish date ascending, ignoring every tier", () => {
        expect(ids(orderRelatedArticles(GOLDEN, 'USA', MODE_PREF_CTX, 'oldest'))).toEqual([
            'g2', 'g4', 'g1', 'g6', 'g3', 'g9', 'g8', 'g10', 'g7', 'g5',
        ]);
    });

    it("'newest' sorts by publish date descending, ignoring every tier", () => {
        expect(ids(orderRelatedArticles(GOLDEN, 'USA', MODE_PREF_CTX, 'newest'))).toEqual([
            'g7', 'g10', 'g8', 'g9', 'g3', 'g6', 'g1', 'g4', 'g2', 'g5',
        ]);
    });

    it('undated rows trail in BOTH date modes — so oldest is not the exact reverse of newest', () => {
        const items = [
            entry({ id: 'undated-a', pubDateMs: null }),
            entry({ id: 'dated', pubDateMs: 500 }),
            entry({ id: 'undated-b', pubDateMs: NaN }),
        ];
        expect(ids(orderRelatedArticles(items, null, CTX, 'oldest'))).toEqual([
            'dated', 'undated-a', 'undated-b',
        ]);
        expect(ids(orderRelatedArticles(items, null, CTX, 'newest'))).toEqual([
            'dated', 'undated-a', 'undated-b',
        ]);
        const oldest = ids(orderRelatedArticles(GOLDEN, 'USA', CTX, 'oldest'));
        const newest = ids(orderRelatedArticles(GOLDEN, 'USA', CTX, 'newest'));
        expect(newest).not.toEqual([...oldest].reverse());
    });

    it('the date modes ignore the context and the current country entirely', () => {
        for (const mode of ['oldest', 'newest'] as const) {
            const withCtx = ids(orderRelatedArticles(GOLDEN, 'USA', MODE_PREF_CTX, mode));
            expect(ids(orderRelatedArticles(GOLDEN, null, null, mode))).toEqual(withCtx);
            expect(ids(orderRelatedArticles(GOLDEN, 'FRA', CTX, mode))).toEqual(withCtx);
        }
    });

    it('equal dates fall to id ASC in both date modes', () => {
        const items = [
            entry({ id: 'z', pubDateMs: 100 }),
            entry({ id: 'a', pubDateMs: 100 }),
        ];
        expect(ids(orderRelatedArticles(items, null, CTX, 'oldest'))).toEqual(['a', 'z']);
        expect(ids(orderRelatedArticles(items, null, CTX, 'newest'))).toEqual(['a', 'z']);
    });

    it('every mode is non-mutating, deterministic and idempotent', () => {
        for (const mode of ['relevance', 'oldest', 'newest'] as const) {
            const input = [...GOLDEN];
            const snapshot = ids(input);
            const once = orderRelatedArticles(input, 'USA', MODE_PREF_CTX, mode);
            expect(ids(input)).toEqual(snapshot);
            expect(once).not.toBe(input);
            expect(ids(orderRelatedArticles(once, 'USA', MODE_PREF_CTX, mode))).toEqual(ids(once));
            expect(
                ids(orderRelatedArticles([...GOLDEN].reverse(), 'USA', MODE_PREF_CTX, mode)),
            ).toEqual(ids(once));
            expect(orderRelatedArticles([], 'USA', MODE_PREF_CTX, mode)).toEqual([]);
        }
    });
});
