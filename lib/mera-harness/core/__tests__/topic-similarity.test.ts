import {
  DETECT_JACCARD,
  FILTER_DROP_JACCARD,
  contentJaccard,
  isSubsetTopic,
} from '../topic-similarity';
import { filterNearDuplicates } from '../topic-dedupe';

describe('thresholds', () => {
  it('the filter threshold is STRICTLY above the detector threshold', () => {
    // The gap is the measurable band. If these ever meet, the duplicate gate
    // measures its own filter and reads clean by construction.
    expect(FILTER_DROP_JACCARD).toBeGreaterThan(DETECT_JACCARD);
    expect(FILTER_DROP_JACCARD).toBe(0.75);
    expect(DETECT_JACCARD).toBe(0.6);
  });
});

describe('the three ladder shapes the guidelines actually produce', () => {
  // MEASURED by the eval scout against topics/residence, which asks for a city
  // transport topic AND a country transport topic. An earlier place-name
  // exclusion reduced the first pair to {rail, strikes} on both sides, scored
  // 1.0 and dropped one -- it ate the ladder it was meant to protect. These
  // three pairs are the regression.
  it('city and country flavours of one subject BOTH survive', () => {
    expect(contentJaccard('Barcelona rail strikes', 'Spain rail strikes')).toBeCloseTo(0.5, 3);
    const { kept, dropped } = filterNearDuplicates(['Barcelona rail strikes', 'Spain rail strikes']);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });

  it('two desks in one city BOTH survive', () => {
    expect(contentJaccard('Alkmaar hospital news', 'Alkmaar school closures')).toBeCloseTo(0.2, 3);
    expect(filterNearDuplicates(['Alkmaar hospital news', 'Alkmaar school closures']).kept)
      .toHaveLength(2);
  });

  it('a bare topic and its "news" flavour BOTH survive', () => {
    // This is why `news` is NOT a stopword: stopping it collapses these two to
    // the same token set and one is dropped.
    expect(contentJaccard('Amsterdam safety', 'Amsterdam safety news')).toBeCloseTo(0.667, 2);
    expect(filterNearDuplicates(['Amsterdam safety', 'Amsterdam safety news']).kept)
      .toHaveLength(2);
  });

  it('all three sit UNDER the filter threshold, which is what keeps 0.75 honest', () => {
    for (const [a, b] of [
      ['Barcelona rail strikes', 'Spain rail strikes'],
      ['Alkmaar hospital news', 'Alkmaar school closures'],
      ['Amsterdam safety', 'Amsterdam safety news'],
    ]) {
      expect(contentJaccard(a, b)).toBeLessThan(FILTER_DROP_JACCARD);
    }
  });

  it('a subset never drives the FILTER, though the scorer flags it', () => {
    const a = 'hospital policy';
    const b = 'Netherlands hospital policy reform';
    expect(isSubsetTopic(a, b)).toBe(true);
    expect(contentJaccard(a, b)).toBeLessThan(FILTER_DROP_JACCARD);
    expect(filterNearDuplicates([b, a]).kept).toEqual([b, a]);
  });
});

describe('filterNearDuplicates', () => {
  it('still drops a genuine restatement, so the filter is not inert', () => {
    const { kept, dropped } = filterNearDuplicates([
      'Rotterdam port logistics',
      'Rotterdam logistics port',
    ]);
    expect(kept).toEqual(['Rotterdam port logistics']);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].duplicateOf).toBe('Rotterdam port logistics');
    expect(dropped[0].overlap.sort()).toEqual(['logistics', 'port', 'rotterdam']);
  });

  it('keeps the FIRST occurrence, so the output is order-deterministic', () => {
    const a = filterNearDuplicates(['Rotterdam port logistics', 'Rotterdam logistics port']).kept;
    const b = filterNearDuplicates(['Rotterdam logistics port', 'Rotterdam port logistics']).kept;
    expect(a).toEqual(['Rotterdam port logistics']);
    expect(b).toEqual(['Rotterdam logistics port']);
  });

  it('fails OPEN: empty and unjudgeable input comes back whole', () => {
    expect(filterNearDuplicates([]).kept).toEqual([]);
    // All-stopword topics tokenize to nothing; they must not collapse together.
    const { kept } = filterNearDuplicates(['the news', 'the updates']);
    expect(kept).toHaveLength(2);
  });

  it('drops blank entries without counting them as duplicates', () => {
    const { kept, dropped } = filterNearDuplicates(['Alkmaar hospital news', '   ']);
    expect(kept).toEqual(['Alkmaar hospital news']);
    expect(dropped).toHaveLength(0);
  });
});

describe('namesFact (ux2 F6 fix 4)', () => {
  const { namesFact } = require('../topic-similarity') as typeof import('../topic-similarity');
  it('a shared content word names the fact', () => {
    expect(namesFact('Feyenoord stadium plans', 'Follows Dutch football, especially Feyenoord')).toBe(true);
  });
  it('a shared 5-letter stem names the fact', () => {
    expect(namesFact('vegetarian school meals', 'Vegetarian since 2019')).toBe(true);
    expect(namesFact('cycling lane funding', 'Commutes by bicycle year round')).toBe(false);
    expect(namesFact('commuter rail strikes', 'Commutes by bicycle year round')).toBe(true);
  });
  it('a topic about another fact does not', () => {
    expect(namesFact('Rotterdam port strikes', 'Married with one child')).toBe(false);
  });
  it('function words never count', () => {
    expect(namesFact('lives of dock workers', 'Lives in Rotterdam')).toBe(false);
  });
});
