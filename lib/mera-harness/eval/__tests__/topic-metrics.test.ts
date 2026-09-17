// Every check here carries a control. A detector that has only ever seen the
// healthy case cannot fail, and a suite of those reports green while measuring
// nothing.

import {
  EMPTY_CONTENT_GATE,
  S7_GATE,
  applyShippedFilter,
  filterCorrectness,
  integrityReport,
  s7Report,
  sharedRules,
  type TopicSetInput,
} from '../topic-metrics';
import { contentJaccard, isSubsetTopic } from '../../core/topic-similarity';

const BASE: Omit<TopicSetInput, 'topics'> = {
  factId: 'f1',
  factStatement: 'Lives in Gràcia, Barcelona, Catalonia, Spain',
  factKind: 'residence',
  placeChain: null,
  existingTopics: [],
  declinedTopics: [],
  rawOutput: '[]',
  finishReason: 'stop',
};

const BARCELONA = {
  neighbourhood: 'Gràcia',
  locality: 'Barcelona',
  admin1: 'Catalonia',
  countryCode: 'ES',
  countryName: 'Spain',
  bloc: 'EU' as const,
};

/** The residence skill's own worked example, copied from its body. If the
 *  scorer disagrees with the skill author about their own output, the scorer
 *  is wrong. */
const WORKED_EXAMPLE = [
  'Gràcia neighbourhood news',
  'Gràcia housing pressure',
  'Barcelona news',
  'Barcelona metro disruptions',
  'Barcelona school places',
  'Catalonia nursing pay dispute',
  'Catalonia regional politics',
  'Spain rail strikes',
  'Spain immigration policy',
  'Spain energy prices',
  'EU housing regulation',
  'Schengen entry rules',
];

describe('S7 gate liveness', () => {
  // THE POINT OF THIS TEST. A near-duplicate gate measured AFTER a
  // near-duplicate filter can be a check that cannot fail. It is live only
  // because the filter acts at 0.75 and never on subsets while the detector
  // flags at 0.6 or on a subset, so the 0.6-0.75 band and every subset case
  // survive. If this ever goes green in the other direction, the gate is
  // vacuous and must be redefined before it is trusted.
  it('CAN FAIL: a subset pair below the filter threshold survives and is flagged', () => {
    expect(contentJaccard('rail strikes', 'Spain rail strikes')).toBeCloseTo(0.667, 2);
    expect(isSubsetTopic('rail strikes', 'Spain rail strikes')).toBe(true);

    const topics = [
      'rail strikes',
      'Spain rail strikes',
      'Barcelona metro disruptions',
      'Catalonia school funding',
      'EU housing regulation',
      'Spain energy prices',
    ];
    const kept = applyShippedFilter(topics).kept;
    expect(kept).toHaveLength(topics.length); // the filter let the pair through
    expect(s7Report({ ...BASE, topics }).postFilterRate).toBeGreaterThan(S7_GATE);
  });

  it('passes a clean ladder, so the gate is not simply always red', () => {
    const r = s7Report({ ...BASE, topics: WORKED_EXAMPLE, placeChain: BARCELONA });
    expect(r.postFilterRate).toBeLessThanOrEqual(S7_GATE);
    expect(r.rawRate).toBeLessThanOrEqual(S7_GATE);
  });

  it('reports raw separately, so a set rescued by the filter is distinguishable', () => {
    // 0.75 exactly: the filter drops it, so post-filter is clean while raw is not.
    const topics = ['Spain rail strikes', 'Spain rail strikes coverage', 'EU housing regulation'];
    const r = s7Report({ ...BASE, topics });
    expect(r.rawFlagged).toBeGreaterThan(0);
    expect(r.postFilterFlagged).toBe(0);
  });
});

describe('filter correctness', () => {
  it('keeps two rungs that share only a place name (the OLD dedupe failure)', () => {
    const chain = { ...BARCELONA, locality: 'Alkmaar', admin1: null, countryName: 'Netherlands' };
    const topics = ['Alkmaar hospital news', 'Alkmaar school closures'];
    const r = filterCorrectness(topics, chain);
    expect(r.dropped).toBe(0);
    expect(r.droppedOnPlaceNameAlone).toHaveLength(0);
    expect(r.passed).toBe(true);
  });

  // THE BUG THIS ONCE CAUGHT IS FIXED, AND THE TEST NOW PINS THE FIX.
  // Excluding place names collapsed two topics that differ only by rung into
  // one token set: "Barcelona rail strikes" and "Spain rail strikes" both
  // became {rail, strikes}, Jaccard 1.000, and the country rung was dropped.
  // The exclusion was removed, so the pair scores 0.5 and both survive.
  it('KEEPS two rungs that differ only by their place name', () => {
    const topics = ['Barcelona rail strikes', 'Spain rail strikes'];
    expect(contentJaccard(topics[0], topics[1])).toBeCloseTo(0.5, 2);

    const kept = applyShippedFilter(topics).kept;
    expect(kept).toHaveLength(2);
    expect(filterCorrectness(topics, BARCELONA).passed).toBe(true);
  });

  // THE INVARIANT, stated so it survives any future change to the filter:
  // gate 2 passes exactly when the filter dropped nothing it should not have.
  // A silent ladder loss can never slip through as a pass.
  it('gate 2 passes if and only if nothing was wrongly dropped', () => {
    for (const topics of [
      ['Barcelona rail strikes', 'Spain rail strikes'],
      ['Alkmaar hospital news', 'Alkmaar school closures'],
      WORKED_EXAMPLE,
      ['Spain energy prices', 'Spain energy price rises'],
    ]) {
      const r = filterCorrectness(topics, BARCELONA);
      const wronglyDropped =
        r.droppedOnPlaceNameAlone.length + r.droppedDifferingOnlyByPlace.length;
      expect(r.passed).toBe(wronglyDropped === 0);
    }
  });

  // STILL REACHABLE, and still the failure worth catching: a pair whose only
  // shared content IS the place. Without an exclusion these share every token,
  // so the filter drops one and gate 2 says so.
  it('FLAGS a drop whose entire overlap is place words', () => {
    const topics = ['Barcelona Catalonia Spain', 'Barcelona Catalonia Spain news'];
    const r = filterCorrectness(topics, BARCELONA);
    expect(r.dropped).toBe(1);
    expect(r.droppedOnPlaceNameAlone).toHaveLength(1);
    expect(r.passed).toBe(false);
  });

  it('does not flag a genuine duplicate that shares real content words', () => {
    // Same rung, same subject, reworded: dropping this one is correct.
    const topics = ['Spain energy prices', 'Spain energy price rises'];
    const r = filterCorrectness(topics, BARCELONA);
    expect(r.droppedDifferingOnlyByPlace).toHaveLength(0);
  });

  it('leaves the skill’s own worked example completely intact', () => {
    const r = applyShippedFilter(WORKED_EXAMPLE);
    expect(r.kept).toHaveLength(WORKED_EXAMPLE.length);
    expect(r.dropped).toHaveLength(0);
  });
});

describe('output integrity gate', () => {
  const set = (rawOutput: string, finishReason = 'stop'): TopicSetInput => ({
    ...BASE,
    topics: [],
    rawOutput,
    finishReason,
  });

  it('fails above the empty-content threshold', () => {
    const sets = [set(''), set(''), set('["a"]'), set('["b"]')];
    const r = integrityReport(sets);
    expect(r.emptyRate).toBeGreaterThan(EMPTY_CONTENT_GATE);
    expect(r.passed).toBe(false);
  });

  it('passes when every call produced content', () => {
    const r = integrityReport([set('["a"]'), set('["b"]')]);
    expect(r.emptyRate).toBe(0);
    expect(r.passed).toBe(true);
  });

  it('SEPARATES prose-instead-of-JSON from empty content, and gates on both', () => {
    // The failure the pre-registered wording missed: bytes present, shape
    // wrong, no usable topic set. Measured at 42% on an arm whose
    // empty-content rate was 0.0%.
    const sets: TopicSetInput[] = [
      { ...BASE, topics: [], rawOutput: 'Here is my reasoning about the place chain...' },
      { ...BASE, topics: ['Spain rail strikes'], rawOutput: '["Spain rail strikes"]' },
    ];
    const r = integrityReport(sets);
    expect(r.emptyContent).toBe(0);
    expect(r.emptyRate).toBe(0);
    expect(r.passed).toBe(true);           // the gate AS AGREED still passes
    expect(r.unparsedOutput).toBe(1);
    expect(r.noUsableSetRate).toBe(0.5);
    expect(r.passedOnUsableSets).toBe(false); // the stricter reading does not
  });

  it('counts finish reasons, so a truncation is visible next to the empties', () => {
    const r = integrityReport([set('', 'length'), set('["a"]', 'stop')]);
    expect(r.finishReasons).toEqual({ length: 1, stop: 1 });
  });
});

describe('shared rules', () => {
  it('flags each violation and stays quiet on clean topics', () => {
    const r = sharedRules({
      ...BASE,
      topics: [
        'Spain rail strikes',
        'Barcelona news',
        'a topic that is far too many words long',
        'Spain energy — prices',
        'one',
      ],
      existingTopics: ['barcelona news'],
      declinedTopics: ['Spain rail strikes'],
    });
    expect(r.duplicatesOfExisting).toEqual(['Barcelona news']);
    expect(r.duplicatesOfDeclined).toEqual(['Spain rail strikes']);
    expect(r.wordCountViolations).toEqual([
      'a topic that is far too many words long',
      'one',
    ]);
    expect(r.bannedDash).toEqual(['Spain energy — prices']);
  });

  it('does not flag a date range as a banned dash', () => {
    const r = sharedRules({ ...BASE, topics: ['Spain budget 2019–2024'] });
    expect(r.bannedDash).toEqual([]);
  });
});
