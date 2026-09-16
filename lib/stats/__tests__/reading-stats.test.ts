import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';
import {
  WINDOW_DAYS,
  WINDOW_MS,
  computeReadingStats,
  emptyReadingStats,
  roundedAverageHours,
  availableCards,
  cardHasData,
  countryBands,
  resolveStatsCardParam,
  DEFAULT_STATS_CARD,
  STATS_CARD_IDS,
  type ReadingStats,
  type StatsImpression,
} from '../reading-stats';

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function visit(overrides: Partial<VisitedArticle> = {}): VisitedArticle {
  return {
    articleId: 'a1',
    articleSuggestionId: null,
    articleUrl: 'https://example.test/a1',
    publicationName: 'The Hindu',
    countryCode: 'IN',
    titleEn: null,
    titleOriginal: null,
    languageCode: 'en',
    imageUrl: null,
    pubDate: null,
    visitedAt: NOW - HOUR,
    visitCount: 1,
    ...overrides,
  };
}

function impression(overrides: Partial<StatsImpression> = {}): StatsImpression {
  return { articleId: 'a1', opened: true, firstSeenAtMs: NOW - HOUR, ...overrides };
}

describe('computeReadingStats', () => {
  it('returns a clean zero shape for an empty device, with no divide by zero', () => {
    const stats = computeReadingStats({ visits: [], impressions: [], nowMs: NOW });

    expect(stats.publicationCount).toBe(0);
    expect(stats.countryCount).toBe(0);
    expect(stats.articlesOpened).toBe(0);
    expect(stats.topPublications).toEqual([]);
    expect(stats.hasAnyData).toBe(false);
    // null, never 0: zero would read as "published and read in the same
    // instant" rather than "we have no publish times".
    expect(stats.publishToRead.averageHours).toBeNull();
    expect(stats.publishToRead.sampledArticles).toBe(0);
    expect(stats.publishToRead.totalArticles).toBe(0);
    expect(stats.windowDays).toBe(WINDOW_DAYS);
  });

  it('counts distinct publications and distinct countries, not rows', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', publicationName: 'The Hindu', countryCode: 'IN' }),
        visit({ articleId: 'a2', publicationName: 'The Hindu', countryCode: 'IN' }),
        visit({ articleId: 'a3', publicationName: 'Le Monde', countryCode: 'FR' }),
        visit({ articleId: 'a4', publicationName: 'NHK', countryCode: 'JP' }),
      ],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(2 + 1);
    expect(stats.countryCount).toBe(3);
    expect(stats.hasAnyData).toBe(true);
  });

  it('ignores blank and whitespace-only publication names and country codes', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', publicationName: '   ', countryCode: '  ' }),
        visit({ articleId: 'a2', publicationName: 'Le Monde', countryCode: null }),
      ],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(1);
    expect(stats.countryCount).toBe(0);
    expect(stats.topPublications).toEqual([
      { publicationName: 'Le Monde', countryCode: null, visitCount: 1 },
    ]);
  });

  it('drops visits older than the 30-day window', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'fresh', publicationName: 'Le Monde', visitedAt: NOW - DAY }),
        visit({ articleId: 'stale', publicationName: 'NHK', visitedAt: NOW - WINDOW_MS - 1 }),
      ],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(1);
    expect(stats.topPublications.map((p) => p.publicationName)).toEqual(['Le Monde']);
  });

  it('keeps a visit exactly on the window boundary', () => {
    const stats = computeReadingStats({
      visits: [visit({ visitedAt: NOW - WINDOW_MS })],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(1);
  });

  it('keeps a visit with a future timestamp rather than silently narrowing the count', () => {
    const stats = computeReadingStats({
      visits: [visit({ visitedAt: NOW + DAY })],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(1);
  });

  describe('publish-to-read coverage', () => {
    it('reports the average alongside BOTH halves of its denominator', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'a1', visitedAt: NOW, pubDate: NOW - 4 * HOUR }),
          visit({ articleId: 'a2', visitedAt: NOW, pubDate: NOW - 8 * HOUR }),
          visit({ articleId: 'a3', visitedAt: NOW, pubDate: null }),
          visit({ articleId: 'a4', visitedAt: NOW, pubDate: null }),
        ],
        impressions: [],
        nowMs: NOW,
      });

      expect(stats.publishToRead.averageHours).toBe(6);
      // The average is over 2 rows; the card must say "2 of 4", never imply 4.
      expect(stats.publishToRead.sampledArticles).toBe(2);
      expect(stats.publishToRead.totalArticles).toBe(4);
    });

    it('returns a null average when no row has a known publish time', () => {
      const stats = computeReadingStats({
        visits: [visit({ pubDate: null }), visit({ articleId: 'a2', pubDate: null })],
        impressions: [],
        nowMs: NOW,
      });

      expect(stats.publishToRead.averageHours).toBeNull();
      expect(stats.publishToRead.sampledArticles).toBe(0);
      expect(stats.publishToRead.totalArticles).toBe(2);
    });

    it('computes coverage over the WINDOWED rows, not the raw input', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'fresh', visitedAt: NOW, pubDate: NOW - 2 * HOUR }),
          visit({ articleId: 'stale', visitedAt: NOW - WINDOW_MS - 1, pubDate: NOW - 5 * HOUR }),
        ],
        impressions: [],
        nowMs: NOW,
      });

      expect(stats.publishToRead.totalArticles).toBe(1);
      expect(stats.publishToRead.sampledArticles).toBe(1);
      expect(stats.publishToRead.averageHours).toBe(2);
    });
  });

  describe('articlesOpened', () => {
    it('counts opened impressions only', () => {
      const stats = computeReadingStats({
        visits: [],
        impressions: [
          impression({ articleId: 'a1', opened: true }),
          impression({ articleId: 'a2', opened: false }),
        ],
        nowMs: NOW,
      });

      expect(stats.articlesOpened).toBe(1);
      // Impressions alone do NOT make a shareable card: three of the four
      // figures come from visits, so this device has one number and three
      // blanks. It is also what makes "Clear viewing history" visibly work,
      // since that action wipes visits and deliberately leaves impressions
      // alone (they run feed dedup and the read-story filter).
      expect(stats.hasAnyData).toBe(false);
    });

    it('applies the 30-day window itself, because the impressions table does not', () => {
      // story_impressions is pruned by a SWEEP (deleteOlderThan from
      // data-cleanup-task), not at query level, so getAll() can hand back rows
      // older than the window whenever that sweep is behind. Counting them would
      // put a false "last 30 days" label on the figure.
      const stats = computeReadingStats({
        visits: [],
        impressions: [
          impression({ articleId: 'fresh', firstSeenAtMs: NOW - DAY }),
          impression({ articleId: 'unswept', firstSeenAtMs: NOW - WINDOW_MS - 1 }),
        ],
        nowMs: NOW,
      });

      expect(stats.articlesOpened).toBe(1);
    });

    it('drops a row whose first_seen_at cannot be placed in the window', () => {
      const stats = computeReadingStats({
        visits: [],
        impressions: [
          impression({ articleId: 'a1', firstSeenAtMs: null }),
          impression({ articleId: 'a2', firstSeenAtMs: Number.NaN }),
        ],
        nowMs: NOW,
      });

      expect(stats.articlesOpened).toBe(0);
      expect(stats.hasAnyData).toBe(false);
    });

    it('stays empty after a visit clear, even with impressions left behind', () => {
      // The exact state the simulator hit: Manage Data cleared publication_visits
      // and story_impressions survived, so the screen kept showing a numeric
      // card after a dialog that promised to empty it.
      const stats = computeReadingStats({
        visits: [],
        impressions: [impression({ articleId: 'survivor' })],
        nowMs: NOW,
      });

      expect(stats.articlesOpened).toBe(1);
      expect(stats.publicationCount).toBe(0);
      expect(stats.hasAnyData).toBe(false);
    });

    it('dedupes by article id and ignores blank ids', () => {
      const stats = computeReadingStats({
        visits: [],
        impressions: [
          impression({ articleId: 'a1' }),
          impression({ articleId: 'a1' }),
          impression({ articleId: '  ' }),
        ],
        nowMs: NOW,
      });

      expect(stats.articlesOpened).toBe(1);
    });
  });

  describe('topPublications', () => {
    it('sums taps per publication and orders by count, then name', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'a1', publicationName: 'NHK', countryCode: 'JP', visitCount: 2 }),
          visit({ articleId: 'a2', publicationName: 'NHK', countryCode: 'JP', visitCount: 3 }),
          visit({ articleId: 'a3', publicationName: 'Le Monde', countryCode: 'FR', visitCount: 5 }),
          visit({ articleId: 'a4', publicationName: 'The Hindu', countryCode: 'IN', visitCount: 1 }),
        ],
        impressions: [],
        nowMs: NOW,
        topPublicationLimit: 3,
      });

      expect(stats.topPublications).toEqual([
        { publicationName: 'Le Monde', countryCode: 'FR', visitCount: 5 },
        { publicationName: 'NHK', countryCode: 'JP', visitCount: 5 },
        { publicationName: 'The Hindu', countryCode: 'IN', visitCount: 1 },
      ]);
    });

    it('keeps same-name publications in different countries apart', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'a1', publicationName: 'The Times', countryCode: 'GB', visitCount: 2 }),
          visit({ articleId: 'a2', publicationName: 'The Times', countryCode: 'IN', visitCount: 1 }),
        ],
        impressions: [],
        nowMs: NOW,
      });

      expect(stats.topPublications).toEqual([
        { publicationName: 'The Times', countryCode: 'GB', visitCount: 2 },
        { publicationName: 'The Times', countryCode: 'IN', visitCount: 1 },
      ]);
      // Distinct NAMES, so the headline figure still says one publication.
      expect(stats.publicationCount).toBe(1);
    });

    it('honours the limit and a zero limit', () => {
      const visits = ['a', 'b', 'c', 'd'].map((id, i) =>
        visit({ articleId: id, publicationName: `Pub ${id}`, visitCount: 10 - i }),
      );

      expect(computeReadingStats({ visits, impressions: [], nowMs: NOW }).topPublications).toHaveLength(3);
      expect(
        computeReadingStats({ visits, impressions: [], nowMs: NOW, topPublicationLimit: 0 })
          .topPublications,
      ).toEqual([]);
    });

    it('treats a missing or non-positive visitCount as one tap', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'a1', publicationName: 'NHK', visitCount: 0 }),
          visit({ articleId: 'a2', publicationName: 'NHK', visitCount: Number.NaN }),
        ],
        impressions: [],
        nowMs: NOW,
      });

      expect(stats.topPublications[0].visitCount).toBe(2);
    });
  });
});

describe('emptyReadingStats', () => {
  it('matches what the core returns for empty input', () => {
    expect(emptyReadingStats()).toEqual(
      computeReadingStats({ visits: [], impressions: [], nowMs: NOW }),
    );
  });
});

describe('roundedAverageHours', () => {
  it('rounds a real average', () => {
    expect(roundedAverageHours({ averageHours: 8.6, sampledArticles: 3, totalArticles: 5 })).toBe(9);
  });

  it('passes null through rather than turning it into zero', () => {
    expect(roundedAverageHours({ averageHours: null, sampledArticles: 0, totalArticles: 5 })).toBeNull();
  });

  it('floors a negative average at zero', () => {
    // A publish date in the future (a feed with a bad pubDate) would otherwise
    // render "minus 3 hours", which reads as a bug rather than as bad data.
    expect(roundedAverageHours({ averageHours: -3.2, sampledArticles: 1, totalArticles: 1 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The analytics-wave additions: the country list, the present-tense figures,
// per-card availability and the proportion bands.
// ---------------------------------------------------------------------------

describe('the country list', () => {
  it('weights countries by TAPS, not by how many publications they have', () => {
    // The whole reason `countries` carries a count rather than being a Set.
    // Two French publications read once each must NOT outrank one Indian
    // publication read six times; a bar built off publication counts inverts
    // them.
    //
    // Every country here is aggregated from MORE THAN ONE ROW, at counts above
    // one. That is load-bearing and was got wrong first time: with one row per
    // country, or with every visitCount at 1, `seen.visitCount += 1` passes
    // this test identically to `+= taps` and the assertion proves nothing.
    // FR's 4+3 is the pair that actually discriminates the two.
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', publicationName: 'The Hindu', countryCode: 'IN', visitCount: 6 }),
        visit({ articleId: 'a2', publicationName: 'The Hindu', countryCode: 'IN', visitCount: 2 }),
        visit({ articleId: 'a3', publicationName: 'Le Monde', countryCode: 'FR', visitCount: 4 }),
        visit({ articleId: 'a4', publicationName: 'Le Figaro', countryCode: 'FR', visitCount: 3 }),
      ],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.countries).toEqual([
      { countryCode: 'IN', visitCount: 8 },
      { countryCode: 'FR', visitCount: 7 },
    ]);
    expect(stats.countryCount).toBe(2);
    // Publication counts are EQUAL here, so this pair can only have been
    // ordered by taps.
    expect(stats.publicationCount).toBe(3);
  });

  it('floors a malformed tap count at one instead of dropping the row', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', countryCode: 'IN', visitCount: 0 }),
        visit({ articleId: 'a2', countryCode: 'IN', visitCount: Number.NaN }),
      ],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.countries).toEqual([{ countryCode: 'IN', visitCount: 2 }]);
  });

  it('counts a country even when the visit has no publication name', () => {
    // Counted before the name guard on purpose: a nameless visit is still a
    // country the reader saw news from, and dropping it would make the flag
    // grid disagree with the Sources tab.
    //
    // Blank rather than null: `VisitedArticle.publicationName` is typed
    // non-nullable, so an empty string is the shape this actually arrives in
    // and the one `cleaned()` exists to catch.
    const stats = computeReadingStats({
      visits: [visit({ publicationName: '  ', countryCode: 'JP' })],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.countries).toEqual([{ countryCode: 'JP', visitCount: 1 }]);
    expect(stats.publicationCount).toBe(0);
  });

  it('honours the 30-day window and drops blank codes', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', countryCode: 'IN' }),
        visit({ articleId: 'a2', countryCode: 'BR', visitedAt: NOW - WINDOW_MS - DAY }),
        visit({ articleId: 'a3', countryCode: '   ' }),
        visit({ articleId: 'a4', countryCode: null }),
      ],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.countries.map((c) => c.countryCode)).toEqual(['IN']);
  });

  it('breaks a tie on the code so two shares never reorder between renders', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', countryCode: 'ZA', publicationName: 'P1' }),
        visit({ articleId: 'a2', countryCode: 'AU', publicationName: 'P2' }),
      ],
      impressions: [],
      nowMs: NOW,
    });

    expect(stats.countries.map((c) => c.countryCode)).toEqual(['AU', 'ZA']);
  });

  it('agrees with countryCount on an empty device', () => {
    const empty = emptyReadingStats();
    expect(empty.countries).toEqual([]);
    expect(empty.countryCount).toBe(0);
    expect(empty.keptNow).toEqual({ savedArticles: 0, followedStories: 0 });
  });
});

describe('the present-tense figures', () => {
  it('passes the injected counts straight through', () => {
    const stats = computeReadingStats({
      visits: [],
      impressions: [],
      nowMs: NOW,
      keptNow: { savedArticles: 28, followedStories: 6 },
    });

    expect(stats.keptNow).toEqual({ savedArticles: 28, followedStories: 6 });
  });

  it('is NOT windowed, unlike everything beside it', () => {
    // The point of the separate object. A caller that windowed these would be
    // answering "saved in the last 30 days and not since removed", which is an
    // artefact of two unrelated rules rather than a fact about reading.
    const windowed = computeReadingStats({
      visits: [visit({ visitedAt: NOW - WINDOW_MS - DAY })],
      impressions: [],
      nowMs: NOW,
      keptNow: { savedArticles: 12, followedStories: 3 },
    });

    expect(windowed.publicationCount).toBe(0);
    expect(windowed.keptNow).toEqual({ savedArticles: 12, followedStories: 3 });
  });

  it('floors nonsense to zero rather than rendering it', () => {
    const stats = computeReadingStats({
      visits: [],
      impressions: [],
      nowMs: NOW,
      keptNow: { savedArticles: -4, followedStories: Number.NaN },
    });

    expect(stats.keptNow).toEqual({ savedArticles: 0, followedStories: 0 });
  });

  it('defaults to zero when a caller omits them entirely', () => {
    const stats = computeReadingStats({ visits: [], impressions: [], nowMs: NOW });
    expect(stats.keptNow).toEqual({ savedArticles: 0, followedStories: 0 });
  });
});

describe('cardHasData', () => {
  function withStats(overrides: Partial<ReadingStats>): ReadingStats {
    return { ...emptyReadingStats(), ...overrides };
  }

  it('offers nothing on an empty device', () => {
    expect(availableCards(emptyReadingStats())).toEqual([]);
  });

  it('offers keep from saved articles alone, with no visits at all', () => {
    // The case hasAnyData cannot answer: a reader who cleared their viewing
    // history still has a real keep card, and three of the other figures are
    // genuinely gone.
    const stats = withStats({ keptNow: { savedArticles: 3, followedStories: 0 } });

    expect(availableCards(stats)).toEqual(['keep']);
    expect(stats.hasAnyData).toBe(false);
  });

  it('offers pace from a latency average even when nothing was opened', () => {
    const stats = withStats({
      publishToRead: { averageHours: 9, sampledArticles: 4, totalArticles: 9 },
    });
    expect(availableCards(stats)).toEqual(['pace']);
  });

  it('keeps theme order rather than data order', () => {
    const stats = withStats({
      countries: [{ countryCode: 'IN', visitCount: 2 }],
      publicationCount: 1,
      articlesOpened: 5,
      keptNow: { savedArticles: 1, followedStories: 1 },
    });
    expect(availableCards(stats)).toEqual(['reach', 'keep', 'pace']);
  });

  it('covers every id in the union, so a new card cannot be forgotten here', () => {
    // Non-vacuity: if STATS_CARD_IDS grows and cardHasData does not, this fails
    // rather than silently returning undefined for the new one.
    for (const id of STATS_CARD_IDS) {
      expect(typeof cardHasData(emptyReadingStats(), id)).toBe('boolean');
    }
    expect(STATS_CARD_IDS).toHaveLength(3);
    expect(STATS_CARD_IDS).toContain(DEFAULT_STATS_CARD);
  });
});

describe('countryBands', () => {
  function reach(counts: [string, number][]): ReadingStats {
    return {
      ...emptyReadingStats(),
      countries: counts.map(([countryCode, visitCount]) => ({ countryCode, visitCount })),
      countryCount: counts.length,
    };
  }

  it('returns fractions that sum to exactly one', () => {
    const bands = countryBands(reach([['IN', 38], ['US', 22], ['GB', 14], ['DE', 16], ['FR', 10]]));

    expect(bands.map((b) => b.countryCode)).toEqual(['IN', 'US', 'GB', null]);
    const total = bands.reduce((sum, b) => sum + b.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('omits the remainder band when the top N is everything', () => {
    // Strictly greater than zero, so the bar never draws a band the reader
    // cannot see and the legend never names an empty "rest".
    const bands = countryBands(reach([['IN', 5], ['US', 3]]));
    expect(bands.map((b) => b.countryCode)).toEqual(['IN', 'US']);
  });

  it('returns nothing rather than dividing by zero', () => {
    expect(countryBands(emptyReadingStats())).toEqual([]);
    expect(countryBands(reach([['IN', 0]]))).toEqual([]);
  });

  it('is a fraction of TAPS, not of countries', () => {
    const bands = countryBands(reach([['IN', 9], ['FR', 1]]));
    expect(bands[0].share).toBeCloseTo(0.9, 10);
    expect(bands[1].share).toBeCloseTo(0.1, 10);
  });
});

describe('resolveStatsCardParam', () => {
  const full: ReadingStats = {
    ...emptyReadingStats(),
    countries: [{ countryCode: 'IN', visitCount: 3 }],
    countryCount: 1,
    publicationCount: 2,
    articlesOpened: 9,
    keptNow: { savedArticles: 4, followedStories: 1 },
  };

  it('honours a named card', () => {
    expect(resolveStatsCardParam('pace', full)).toBe('pace');
    expect(resolveStatsCardParam('keep', full)).toBe('keep');
  });

  it('lands the shipped no-param deep link on the default', () => {
    // com.mera.news://logged-in/share-stats carries no param and must keep
    // working exactly as it did.
    expect(resolveStatsCardParam(undefined, full)).toBe(DEFAULT_STATS_CARD);
  });

  it('treats garbage as "no card named" rather than trusting the URL', () => {
    // A URL param's TypeScript type is a claim about nothing.
    for (const raw of ['foo', '', '../reach', 42, null, {}, ['reach']]) {
      expect(resolveStatsCardParam(raw, full)).toBe(DEFAULT_STATS_CARD);
    }
  });

  it('falls through a valid id whose card is empty', () => {
    // Landing a share link on a card of zeroes is the same dead end as landing
    // on a crash, only quieter.
    const keepOnly: ReadingStats = {
      ...emptyReadingStats(),
      keptNow: { savedArticles: 2, followedStories: 0 },
    };
    expect(resolveStatsCardParam('reach', keepOnly)).toBe('keep');
    expect(resolveStatsCardParam('pace', keepOnly)).toBe('keep');
  });

  it('returns null only when the device has no card at all', () => {
    expect(resolveStatsCardParam('reach', emptyReadingStats())).toBeNull();
    expect(resolveStatsCardParam(undefined, emptyReadingStats())).toBeNull();
  });
});
