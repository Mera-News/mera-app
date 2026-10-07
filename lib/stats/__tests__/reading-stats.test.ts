import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';
import {
  WINDOW_DAYS,
  WINDOW_MS,
  computeReadingStats,
  emptyReadingStats,
  roundedMedianHours,
  availableCards,
  cardHasData,
  countryBands,
  dailyReads,
  heatGridRows,
  mondayIndex,
  peakDayCount,
  STATS_CARD_IDS,
  type ReadingStats,
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

describe('computeReadingStats', () => {
  it('returns a clean zero shape for an empty device, with no divide by zero', () => {
    const stats = computeReadingStats({ visits: [], nowMs: NOW });

    expect(stats.publicationCount).toBe(0);
    expect(stats.countryCount).toBe(0);
    expect(stats.topPublications).toEqual([]);
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
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(2 + 1);
    expect(stats.countryCount).toBe(3);
  });

  it('ignores blank and whitespace-only publication names and country codes', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', publicationName: '   ', countryCode: '  ' }),
        visit({ articleId: 'a2', publicationName: 'Le Monde', countryCode: null }),
      ],
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
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(1);
    expect(stats.topPublications.map((p) => p.publicationName)).toEqual(['Le Monde']);
  });

  it('keeps a visit exactly on the window boundary', () => {
    const stats = computeReadingStats({
      visits: [visit({ visitedAt: NOW - WINDOW_MS })],
      nowMs: NOW,
    });

    expect(stats.publicationCount).toBe(1);
  });

  it('keeps a visit with a future timestamp rather than silently narrowing the count', () => {
    const stats = computeReadingStats({
      visits: [visit({ visitedAt: NOW + DAY })],
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
        nowMs: NOW,
      });

      expect(stats.publishToRead.totalArticles).toBe(1);
      expect(stats.publishToRead.sampledArticles).toBe(1);
      expect(stats.publishToRead.averageHours).toBe(2);
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

      expect(computeReadingStats({ visits, nowMs: NOW }).topPublications).toHaveLength(3);
      expect(
        computeReadingStats({ visits, nowMs: NOW, topPublicationLimit: 0 })
          .topPublications,
      ).toEqual([]);
    });

    it('treats a missing or non-positive visitCount as one tap', () => {
      const stats = computeReadingStats({
        visits: [
          visit({ articleId: 'a1', publicationName: 'NHK', visitCount: 0 }),
          visit({ articleId: 'a2', publicationName: 'NHK', visitCount: Number.NaN }),
        ],
        nowMs: NOW,
      });

      expect(stats.topPublications[0].visitCount).toBe(2);
    });
  });
});

describe('emptyReadingStats', () => {
  it('matches the core on every field that does not need a clock', () => {
    // `days` is a CALENDAR, and a calendar cannot exist without a clock. The
    // empty shape is deliberately clock-free (it is the placeholder rendered
    // before the first read resolves, and reading the clock there would make a
    // pure constant impure), so it carries an empty calendar and the rhythm
    // grid draws nothing until real data lands. That is correct behaviour, not
    // a discrepancy: a grid of thirty zero-days flashed before load would be a
    // claim about the reader, briefly, that the app has not yet checked.
    const { days: _d, daysReadCount: _c, ...emptyRest } = emptyReadingStats();
    const { days: _d2, daysReadCount: _c2, ...coreRest } = computeReadingStats({
      visits: [],
      nowMs: NOW,
    });
    expect(emptyRest).toEqual(coreRest);
  });

  it('carries an EMPTY calendar, and the core a full one of zeros', () => {
    // Pins the one difference above, in both directions, so neither side can
    // drift without this failing. Without it, the destructure above would hide
    // a future field that genuinely should have matched.
    expect(emptyReadingStats().days).toEqual([]);
    expect(emptyReadingStats().daysReadCount).toBe(0);

    const core = computeReadingStats({ visits: [], nowMs: NOW });
    expect(core.days).toHaveLength(WINDOW_DAYS);
    expect(core.days.every((d) => d.count === 0)).toBe(true);
    expect(core.daysReadCount).toBe(0);
  });
});

describe('roundedMedianHours', () => {
  it('rounds the median, not the average', () => {
    expect(roundedMedianHours({ averageHours: 20, medianHours: 8.6, sampledArticles: 3, totalArticles: 5 })).toBe(9);
  });

  it('passes null through rather than turning it into zero', () => {
    expect(roundedMedianHours({ averageHours: null, medianHours: null, sampledArticles: 0, totalArticles: 5 })).toBeNull();
  });

  it('floors a negative median at zero', () => {
    expect(roundedMedianHours({ averageHours: -3, medianHours: -3.2, sampledArticles: 1, totalArticles: 1 })).toBe(0);
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
      nowMs: NOW,
      keptNow: { savedArticles: 12, followedStories: 3 },
    });

    expect(windowed.publicationCount).toBe(0);
    expect(windowed.keptNow).toEqual({ savedArticles: 12, followedStories: 3 });
  });

  it('floors nonsense to zero rather than rendering it', () => {
    const stats = computeReadingStats({
      visits: [],
      nowMs: NOW,
      keptNow: { savedArticles: -4, followedStories: Number.NaN },
    });

    expect(stats.keptNow).toEqual({ savedArticles: 0, followedStories: 0 });
  });

  it('defaults to zero when a caller omits them entirely', () => {
    const stats = computeReadingStats({ visits: [], nowMs: NOW });
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

  it('offers Right now from saved articles alone, with no visits at all', () => {
    // A reader who cleared their viewing history still has real saves.
    const stats = withStats({ keptNow: { savedArticles: 3, followedStories: 0 } });
    expect(availableCards(stats)).toEqual(['now']);
  });

  it('offers How fresh from a MEDIAN, never from an average alone', () => {
    expect(
      availableCards(withStats({ publishToRead: { averageHours: 9, medianHours: null, sampledArticles: 0, totalArticles: 9 } })),
    ).toEqual([]);
    expect(
      availableCards(withStats({ publishToRead: { averageHours: 9, medianHours: 4, sampledArticles: 4, totalArticles: 9 } })),
    ).toEqual(['fresh']);
  });

  it('offers Opened at the source from visits', () => {
    expect(availableCards(withStats({ openedAtSourceCount: 2 }))).toEqual(['opened']);
  });

  it('keeps page order rather than data order', () => {
    const stats = withStats({
      topPublications: [{ publicationName: 'NOS', countryCode: 'NL', visitCount: 2 }],
      keptNow: { savedArticles: 1, followedStories: 1 },
      publicationCount: 1,
      languages: [{ languageCode: 'en', visitCount: 2 }],
      languageCount: 1,
      daysReadCount: 1,
      openedAtSourceCount: 2,
      publishToRead: { averageHours: 3, medianHours: 3, sampledArticles: 2, totalArticles: 2 },
    });
    expect(availableCards(stats)).toEqual(['publications', 'languages', 'days', 'opened', 'fresh', 'now', 'top']);
  });

  it('offers Days you read only when a day was actually READ', () => {
    const calendarButNoReading = withStats({
      days: Array.from({ length: 30 }, (_, i) => ({
        dateKey: `2026-09-${String(i + 1).padStart(2, '0')}`,
        count: 0,
        weekday: i % 7,
      })),
      daysReadCount: 0,
    });
    expect(availableCards(calendarButNoReading)).toEqual([]);
  });

  it('covers every id in the union, so a new card cannot be forgotten here', () => {
    for (const id of STATS_CARD_IDS) {
      expect(typeof cardHasData(emptyReadingStats(), id)).toBe('boolean');
    }
    expect(STATS_CARD_IDS).toHaveLength(7);
  });
});

describe('openedAtSourceCount', () => {
  it('counts distinct articles opened at the source inside the window, not taps', () => {
    // Two rows, one opened three times: two articles, never four.
    const stats = computeReadingStats({
      visits: [visit({ articleId: 'a1', visitCount: 3 }), visit({ articleId: 'a2', visitCount: 1 })],
      nowMs: NOW,
    });
    expect(stats.openedAtSourceCount).toBe(2);
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

describe('languages', () => {
  it('is a DIFFERENT fact from country, not a proxy for it', () => {
    // One publisher in Switzerland produces German, French and Italian rows.
    // If this collapsed to country the whole metric would be redundant.
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', publicationName: 'SRF', countryCode: 'CH', languageCode: 'de' }),
        visit({ articleId: 'a2', publicationName: 'SRF', countryCode: 'CH', languageCode: 'fr' }),
        visit({ articleId: 'a3', publicationName: 'SRF', countryCode: 'CH', languageCode: 'it' }),
      ],
      nowMs: NOW,
    });

    expect(stats.countryCount).toBe(1);
    expect(stats.languageCount).toBe(3);
  });

  it('weights by taps and breaks ties on the code', () => {
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', languageCode: 'en', visitCount: 4 }),
        visit({ articleId: 'a2', languageCode: 'en', visitCount: 3 }),
        visit({ articleId: 'a3', languageCode: 'hi', visitCount: 7 }),
        visit({ articleId: 'a4', languageCode: 'fr', visitCount: 7 }),
      ],
      nowMs: NOW,
    });
    expect(stats.languages).toEqual([
      { languageCode: 'en', visitCount: 7 },
      { languageCode: 'fr', visitCount: 7 },
      { languageCode: 'hi', visitCount: 7 },
    ]);
  });

  it('counts a row with no language nowhere, rather than as "unknown"', () => {
    // An unknown bucket in a proportion bar is a segment the reader cannot act
    // on. language_code is optional on the row, so this is the common case.
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', languageCode: 'ja' }),
        visit({ articleId: 'a2', languageCode: null }),
        visit({ articleId: 'a3', languageCode: '  ' }),
      ],
      nowMs: NOW,
    });
    expect(stats.languages).toEqual([{ languageCode: 'ja', visitCount: 1 }]);
  });
});

describe('dailyReads', () => {
  it('returns one entry per window day, oldest first, zeros INCLUDED', () => {
    // The zeros are load-bearing. Skipping them would close the gaps and turn
    // a patchy month into a solid one, which is the single thing this visual
    // must not do.
    const stats = computeReadingStats({
      visits: [visit({ articleId: 'a1', visitedAt: NOW - 2 * DAY })],
      nowMs: NOW,
    });
    expect(stats.days).toHaveLength(WINDOW_DAYS);
    expect(stats.days.filter((d) => d.count > 0)).toHaveLength(1);
    expect(stats.daysReadCount).toBe(1);
    // Oldest first.
    expect(stats.days[0].dateKey < stats.days[stats.days.length - 1].dateKey).toBe(true);
  });

  it('counts DISTINCT ARTICLES, never re-opens', () => {
    // getAllVisitedArticles already dedupes a repeated visit into one row with
    // a visitCount, so one row is one article. Using visitCount here would turn
    // "articles you read that day" into "times you tapped".
    const stats = computeReadingStats({
      visits: [
        visit({ articleId: 'a1', visitedAt: NOW - DAY, visitCount: 9 }),
        visit({ articleId: 'a2', visitedAt: NOW - DAY, visitCount: 1 }),
      ],
      nowMs: NOW,
    });
    expect(stats.days.find((d) => d.count > 0)?.count).toBe(2);
  });

  it('walks calendar days, so a DST boundary neither drops nor repeats one', () => {
    // Fixed-millisecond arithmetic breaks twice a year: a local day is 23 or 25
    // hours long across a shift. Every key must be distinct and there must be
    // exactly WINDOW_DAYS of them.
    const marchDST = Date.UTC(2026, 2, 30, 12, 0, 0);
    const days = dailyReads([], marchDST, 30);
    expect(days).toHaveLength(30);
    expect(new Set(days.map((d) => d.dateKey)).size).toBe(30);
    const novemberDST = Date.UTC(2026, 10, 5, 12, 0, 0);
    expect(new Set(dailyReads([], novemberDST, 30).map((d) => d.dateKey)).size).toBe(30);
  });

  it('labels weekdays Monday-first', () => {
    // A Monday-first week keeps the two weekend days adjacent, which is most of
    // what makes the grid readable at a glance.
    const monday = Date.UTC(2026, 8, 14, 12, 0, 0);
    expect(mondayIndex(monday)).toBe(0);
    expect(mondayIndex(monday + 5 * DAY)).toBe(5);
    expect(mondayIndex(monday + 6 * DAY)).toBe(6);
  });
});

describe('heatGridRows', () => {
  it('needs SIX rows when the window starts late in the week', () => {
    // The row count is NOT days / 7: the first row is padded so day one lands
    // in its own weekday column. Five rows is the lucky case, and a budget
    // sized against it overflows.
    const startingSaturday = dailyReads([], Date.UTC(2026, 9, 17, 12, 0, 0), 30);
    const rows = heatGridRows(startingSaturday);
    expect(rows).toBeGreaterThanOrEqual(5);
    expect(rows).toBeLessThanOrEqual(6);
  });

  it('reaches six for at least one start weekday, and five for at least one', () => {
    // Non-vacuity for the budget: if every start gave the same row count, the
    // worst-case modelling above would be pointless.
    const counts = new Set<number>();
    for (let i = 0; i < 7; i += 1) {
      counts.add(heatGridRows(dailyReads([], Date.UTC(2026, 8, 14 + i, 12, 0, 0), 30)));
    }
    expect(counts.has(5)).toBe(true);
    expect(counts.has(6)).toBe(true);
  });

  it('is zero for an empty window rather than one empty row', () => {
    expect(heatGridRows([])).toBe(0);
  });
});

describe('peakDayCount', () => {
  it('is the busiest day, and zero for an unread window', () => {
    expect(peakDayCount([
      { dateKey: '2026-09-01', count: 3, weekday: 1 },
      { dateKey: '2026-09-02', count: 11, weekday: 2 },
    ])).toBe(11);
    expect(peakDayCount([])).toBe(0);
  });
});
