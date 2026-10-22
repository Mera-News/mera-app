import { orderRelatedArticles, type RelatedSortable } from '../related-articles-sort';
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

describe('orderRelatedArticles — Best match', () => {
  const PREFS: UserGeoLanguageContext = {
    ...CTX,
    subscribedPublications: new Set(['the hindu']),
    preferredPublications: new Set(['the hindu', 'le monde']),
  };

  it('puts Subscribed first, then More from, whatever their language or country', () => {
    const out = orderRelatedArticles(
      [
        entry({
          id: 'en-new',
          languageCode: 'en',
          countryCodeAlpha3: 'USA',
          pubDateMs: 900,
        }),
        entry({
          id: 'more',
          languageCode: 'fr',
          countryCodeAlpha3: 'FRA',
          publicationName: 'Le Monde',
          pubDateMs: 1,
        }),
        entry({
          id: 'sub',
          languageCode: 'ta',
          countryCodeAlpha3: 'IND',
          publicationName: '  The  HINDU ',
          pubDateMs: 2,
        }),
      ],
      PREFS,
    );
    expect(ids(out)).toEqual(['sub', 'more', 'en-new']);
  });

  it('then the app language, then other languages alphabetical, unknown last, whatever the country', () => {
    const out = orderRelatedArticles(
      [
        entry({ id: 'unknown', countryCodeAlpha3: 'USA', pubDateMs: 999 }),
        entry({
          id: 'fr',
          languageCode: 'fr',
          countryCodeAlpha3: 'USA',
          pubDateMs: 900,
        }),
        entry({
          id: 'de',
          languageCode: 'de-AT',
          countryCodeAlpha3: 'USA',
          pubDateMs: 800,
        }),
        entry({
          id: 'en-abroad',
          languageCode: 'EN',
          countryCodeAlpha3: 'NZL',
          pubDateMs: 1,
        }),
      ],
      CTX,
    );
    expect(ids(out)).toEqual(['en-abroad', 'de', 'fr', 'unknown']);
  });

  it('orders newest first within a tier, undated last, then id', () => {
    const out = orderRelatedArticles(
      [
        entry({ id: 'b-old', languageCode: 'en', pubDateMs: 100 }),
        entry({ id: 'undated', languageCode: 'en' }),
        entry({ id: 'z-new', languageCode: 'en', pubDateMs: 500 }),
        entry({ id: 'a-new', languageCode: 'en', pubDateMs: 500 }),
      ],
      CTX,
    );
    expect(ids(out)).toEqual(['a-new', 'z-new', 'b-old', 'undated']);
  });

  it('a preferred COUNTRY scope and the row country do not move anything', () => {
    const rows = [
      entry({
        id: 'ind',
        languageCode: 'en',
        countryCodeAlpha3: 'IND',
        pubDateMs: 1,
      }),
      entry({
        id: 'usa',
        languageCode: 'en',
        countryCodeAlpha3: 'USA',
        pubDateMs: 2,
      }),
    ];
    const scoped = { ...CTX, preferredCountriesAlpha3: new Set(['IND']) };
    expect(ids(orderRelatedArticles(rows, scoped))).toEqual(['usa', 'ind']);
  });

  it('a null context is newest first', () => {
    const out = orderRelatedArticles(
      [
        entry({
          id: 'en',
          languageCode: 'en',
          publicationName: 'Le Monde',
          pubDateMs: 1,
        }),
        entry({ id: 'fr', languageCode: 'fr', pubDateMs: 2 }),
      ],
      null,
    );
    expect(ids(out)).toEqual(['fr', 'en']);
  });
});

describe('orderRelatedArticles — mode selection', () => {
  const MODE_PREF_CTX: UserGeoLanguageContext = {
    ...CTX,
    preferredPublications: new Set(['times of india']),
    preferredCountriesAlpha3: new Set(['DEU']),
    subscribedPublications: new Set(['bbc']),
  };

  /** A fixture exercising every `relevance` key at once: a preferred
   *  publication, a preferred country scope, the current article's country,
   *  two rival country blocks, app-language vs other-language rows, a null
   *  publication, and a countryless/undated row. */
  const GOLDEN: RelatedSortable[] = [
    entry({
      id: 'g1',
      countryCodeAlpha3: 'FRA',
      languageCode: 'fr',
      publicationName: 'Le Monde',
      pubDateMs: 300,
    }),
    entry({
      id: 'g2',
      countryCodeAlpha3: 'USA',
      languageCode: 'en',
      publicationName: 'NYT',
      pubDateMs: 100,
    }),
    entry({
      id: 'g3',
      countryCodeAlpha3: 'IND',
      languageCode: 'hi',
      publicationName: 'Times of India',
      pubDateMs: 500,
    }),
    entry({
      id: 'g4',
      countryCodeAlpha3: 'DEU',
      languageCode: 'de',
      publicationName: 'Die Zeit',
      pubDateMs: 200,
    }),
    entry({
      id: 'g5',
      countryCodeAlpha3: null,
      languageCode: null,
      publicationName: null,
      pubDateMs: null,
    }),
    entry({
      id: 'g6',
      countryCodeAlpha3: 'FRA',
      languageCode: 'en',
      publicationName: 'AFP',
      pubDateMs: 400,
    }),
    entry({
      id: 'g7',
      countryCodeAlpha3: 'USA',
      languageCode: 'en',
      publicationName: 'NYT',
      pubDateMs: 900,
    }),
    entry({
      id: 'g8',
      countryCodeAlpha3: 'FRA',
      languageCode: 'fr',
      publicationName: null,
      pubDateMs: 700,
    }),
    entry({
      id: 'g9',
      countryCodeAlpha3: 'GBR',
      languageCode: 'en',
      publicationName: 'BBC',
      pubDateMs: 600,
    }),
    entry({
      id: 'g10',
      countryCodeAlpha3: 'DEU',
      languageCode: 'de',
      publicationName: 'FAZ',
      pubDateMs: 800,
    }),
  ];

  /**
   * GOLDEN ORDER for Best match: Subscribed (BBC), More from (Times of India),
   * then app language (en) newest first, then de, fr newest first, then the
   * unknown-language row. The preferred COUNTRY scope (DEU) and every row's
   * country play no part.
   */
  const GOLDEN_RELEVANCE_ORDER = ['g9', 'g3', 'g7', 'g6', 'g2', 'g10', 'g4', 'g8', 'g1', 'g5'];

  it("'relevance' is Subscribed, More from, language, newest", () => {
    expect(ids(orderRelatedArticles(GOLDEN, MODE_PREF_CTX, 'relevance'))).toEqual(
      GOLDEN_RELEVANCE_ORDER,
    );
  });

  it("'relevance' is the default — the omitted argument and the explicit value agree", () => {
    expect(ids(orderRelatedArticles(GOLDEN, MODE_PREF_CTX))).toEqual(GOLDEN_RELEVANCE_ORDER);
  });

  it("'oldest' sorts by publish date ascending, ignoring every tier", () => {
    expect(ids(orderRelatedArticles(GOLDEN, MODE_PREF_CTX, 'oldest'))).toEqual([
      'g2',
      'g4',
      'g1',
      'g6',
      'g3',
      'g9',
      'g8',
      'g10',
      'g7',
      'g5',
    ]);
  });

  it("'newest' sorts by publish date descending, ignoring every tier", () => {
    expect(ids(orderRelatedArticles(GOLDEN, MODE_PREF_CTX, 'newest'))).toEqual([
      'g7',
      'g10',
      'g8',
      'g9',
      'g3',
      'g6',
      'g1',
      'g4',
      'g2',
      'g5',
    ]);
  });

  it('undated rows trail in BOTH date modes — so oldest is not the exact reverse of newest', () => {
    const items = [
      entry({ id: 'undated-a', pubDateMs: null }),
      entry({ id: 'dated', pubDateMs: 500 }),
      entry({ id: 'undated-b', pubDateMs: NaN }),
    ];
    expect(ids(orderRelatedArticles(items, CTX, 'oldest'))).toEqual([
      'dated',
      'undated-a',
      'undated-b',
    ]);
    expect(ids(orderRelatedArticles(items, CTX, 'newest'))).toEqual([
      'dated',
      'undated-a',
      'undated-b',
    ]);
    const oldest = ids(orderRelatedArticles(GOLDEN, CTX, 'oldest'));
    const newest = ids(orderRelatedArticles(GOLDEN, CTX, 'newest'));
    expect(newest).not.toEqual([...oldest].reverse());
  });

  it('the date modes ignore the context and the current country entirely', () => {
    for (const mode of ['oldest', 'newest'] as const) {
      const withCtx = ids(orderRelatedArticles(GOLDEN, MODE_PREF_CTX, mode));
      expect(ids(orderRelatedArticles(GOLDEN, null, mode))).toEqual(withCtx);
      expect(ids(orderRelatedArticles(GOLDEN, CTX, mode))).toEqual(withCtx);
    }
  });

  it('equal dates fall to id ASC in both date modes', () => {
    const items = [entry({ id: 'z', pubDateMs: 100 }), entry({ id: 'a', pubDateMs: 100 })];
    expect(ids(orderRelatedArticles(items, CTX, 'oldest'))).toEqual(['a', 'z']);
    expect(ids(orderRelatedArticles(items, CTX, 'newest'))).toEqual(['a', 'z']);
  });

  it('every mode is non-mutating, deterministic and idempotent', () => {
    for (const mode of ['relevance', 'oldest', 'newest'] as const) {
      const input = [...GOLDEN];
      const snapshot = ids(input);
      const once = orderRelatedArticles(input, MODE_PREF_CTX, mode);
      expect(ids(input)).toEqual(snapshot);
      expect(once).not.toBe(input);
      expect(ids(orderRelatedArticles(once, MODE_PREF_CTX, mode))).toEqual(ids(once));
      expect(ids(orderRelatedArticles([...GOLDEN].reverse(), MODE_PREF_CTX, mode))).toEqual(
        ids(once),
      );
      expect(orderRelatedArticles([], MODE_PREF_CTX, mode)).toEqual([]);
    }
  });
});
