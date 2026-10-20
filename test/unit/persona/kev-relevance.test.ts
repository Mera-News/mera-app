import { KEV_CUT, KEV_FACT_CHARS, KEV_QUESTIONS, kevState, kevToRelevance } from '@/lib/mera-protocol/kev-relevance';

// The pure half of kev-relevance; the toolkit (llama.rn) and the logger are never reached here.
jest.mock('@/lib/mera-protocol-toolkit', () => ({ decide: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));

const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'a',
  titleEn: 'A title',
  descriptionEn: 'A description',
  countryCode: 'NLD' as string | null,
  userTopicIds: [],
  relatedFacts: [{ id: 'f1', statement: 'Lives in Hoorn' }],
  ...over,
});

describe('kevToRelevance', () => {
  it('pins the ends and the cut: 0 -> 0, KEV_CUT -> 0.4, 1 -> 1', () => {
    expect(kevToRelevance(0)).toBe(0);
    expect(kevToRelevance(KEV_CUT)).toBeCloseTo(0.4, 10);
    expect(kevToRelevance(1)).toBeCloseTo(1, 10);
  });

  it('is monotone across the cut', () => {
    const xs = Array.from({ length: 101 }, (_, i) => i / 100);
    const ys = xs.map(kevToRelevance);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
  });

  it('clamps out-of-range input into 0..1', () => {
    expect(kevToRelevance(-0.5)).toBe(0);
    expect(kevToRelevance(1.5)).toBe(1);
  });

  it('uses the on-device cut: the phone sample top-28% point (k 0.29) is the 0.4 gate', () => {
    // On the phone a pure "Low" answer (k 1/3) is already above the gate: the on-device scores
    // are compressed, so the cut sits below level 1. Level 0 stays below, level 3 at the top.
    expect(KEV_CUT).toBeCloseTo(0.29, 10);
    const levels = [0, 1, 2, 3].map((l) => kevToRelevance(l / (KEV_QUESTIONS.rel.criteria.length - 1)));
    expect(levels[0]).toBeLessThan(0.4);
    expect(levels[3]).toBe(1);
  });
});

describe('kevState', () => {
  it('carries the whole fact bank, the matched facts and the article', () => {
    expect(kevState(candidate(), ['Lives in Hoorn', 'Follows F1'])).toEqual({
      reader: ['Lives in Hoorn', 'Follows F1'],
      reader_facts_this_article_matched: ['Lives in Hoorn'],
      article: { title: 'A title', description: 'A description', country: 'The Netherlands' },
    });
  });

  it('caps the description at 500 characters', () => {
    const state = kevState(candidate({ descriptionEn: 'x'.repeat(900) }), []);
    expect(state.article.description).toHaveLength(500);
  });

  it('keeps the newest facts that fit the budget, so a big fact bank never overflows Kev\'s 4096-token context', () => {
    // 120 facts of 200 characters is about 7,000 tokens; Kev's context holds 4096.
    const facts = Array.from({ length: 120 }, (_, i) => `${String(i).padStart(3, '0')} ${'f'.repeat(196)}`);
    const relatedFacts = facts.map((statement, i) => ({ id: `f${i}`, statement }));
    const state = kevState(candidate({ relatedFacts }), facts);
    for (const kept of [state.reader, state.reader_facts_this_article_matched]) {
      expect(kept.length).toBeGreaterThan(0);
      expect(kept).toEqual(facts.slice(0, kept.length));
      expect(kept.join('').length).toBeLessThanOrEqual(KEV_FACT_CHARS);
    }
  });

  it.each([[null], ['GLOBAL']])('omits the country for %s', (countryCode) => {
    expect(kevState(candidate({ countryCode }), []).article).not.toHaveProperty('country');
  });
});
