import {
  DETECT_JACCARD,
  FILTER_DROP_JACCARD,
  contentJaccard,
  isSubsetTopic,
  placeExclusionSet,
} from '../topic-similarity';
import { filterNearDuplicates } from '../topic-dedupe';

const AMS = {
  neighbourhood: 'Nieuw-West',
  locality: 'Alkmaar',
  admin1: 'North Holland',
  countryName: 'Netherlands',
};

describe('thresholds', () => {
  it('the filter threshold is STRICTLY above the detector threshold', () => {
    // The gap is the measurable band. If these ever meet, the duplicate gate
    // measures its own filter and reads clean by construction.
    expect(FILTER_DROP_JACCARD).toBeGreaterThan(DETECT_JACCARD);
    expect(FILTER_DROP_JACCARD).toBe(0.75);
    expect(DETECT_JACCARD).toBe(0.6);
  });
});

describe('ladder rungs survive', () => {
  it('WITH a placeChain, two topics sharing only a place name score 0', () => {
    const ex = placeExclusionSet(AMS);
    expect(contentJaccard('Alkmaar hospital news', 'Alkmaar school closures', ex)).toBe(0);
    const { kept, dropped } = filterNearDuplicates(
      ['Alkmaar hospital news', 'Alkmaar school closures'],
      AMS,
    );
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });

  it('WITHOUT a placeChain the exclusion set is EMPTY, and 0.75 is what keeps that safe', () => {
    expect(placeExclusionSet(null).size).toBe(0);
    expect(placeExclusionSet(undefined).size).toBe(0);

    // Place names now count toward similarity. These are the worked worst
    // cases; both must stay UNDER the filter threshold.
    const loose = contentJaccard('Alkmaar hospital news', 'Alkmaar school closures');
    const tight = contentJaccard('Alkmaar hospital news', 'Alkmaar hospital policy');
    expect(loose).toBeCloseTo(0.25, 2);
    expect(tight).toBeCloseTo(0.667, 2);
    expect(tight).toBeLessThan(FILTER_DROP_JACCARD);

    // ...so both pairs are still kept with no place chain at all.
    expect(filterNearDuplicates(['Alkmaar hospital news', 'Alkmaar school closures']).kept)
      .toHaveLength(2);
    expect(filterNearDuplicates(['Alkmaar hospital news', 'Alkmaar hospital policy']).kept)
      .toHaveLength(2);

    // THE COUPLING, pinned: the tighter pair dies at the DETECTOR threshold.
    // Anyone lowering FILTER_DROP_JACCARD toward 0.6 must re-derive these
    // numbers first, and this assertion is what tells them so.
    expect(tight).toBeGreaterThan(DETECT_JACCARD);
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
  it('drops a near-identical restatement and reports what it collided on', () => {
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
