import { KEV_CUT, KEV_QUESTIONS, kevState, kevToRelevance } from '@/lib/mera-protocol/kev-relevance';

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
  it('pins the ends and the cut: 0 -> 0, 0.62 -> 0.4, 1 -> 1', () => {
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

  it('puts the four levels on the right side of the 0.4 gate: levels 0 and 1 below, 2 and 3 above', () => {
    const levels = [0, 1, 2, 3].map((l) => kevToRelevance(l / (KEV_QUESTIONS.rel.criteria.length - 1)));
    expect(levels[1]).toBeLessThan(0.4);
    expect(levels[2]).toBeGreaterThan(0.4);
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

  it.each([[null], ['GLOBAL']])('omits the country for %s', (countryCode) => {
    expect(kevState(candidate({ countryCode }), []).article).not.toHaveProperty('country');
  });
});
