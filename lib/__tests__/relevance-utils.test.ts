import { getRelevanceLabel, getRelevanceColors } from '../relevance-utils';
import { bandOf } from '@/lib/news-harness/feed-select/ownership';

// relevance v3 (2026-08-05) band-ladder unification: both functions now read
// their band off `bandOf` (feed-select/ownership.ts) instead of a private
// hardcoded copy of the cutoffs — 0.4/0.6/0.8/1.0, not the old 0.3/0.53/0.77.
describe('getRelevanceLabel', () => {
  it('labels scores above 1.0 as Emergency Priority', () => {
    expect(getRelevanceLabel(1.5)).toBe('Emergency Priority Articles');
  });

  it('labels the high boundary (0.8, inclusive) as High Priority', () => {
    expect(getRelevanceLabel(0.8)).toBe('High Priority Articles');
    expect(getRelevanceLabel(1.0)).toBe('High Priority Articles');
  });

  it('labels the medium boundary (0.6, inclusive) as Medium Priority', () => {
    expect(getRelevanceLabel(0.6)).toBe('Medium Priority Articles');
    expect(getRelevanceLabel(0.79)).toBe('Medium Priority Articles');
  });

  it('labels scores at/above 0.4 (RENDER_GATE, inclusive) as Low Priority', () => {
    expect(getRelevanceLabel(0.4)).toBe('Low Priority Articles');
    expect(getRelevanceLabel(0.59)).toBe('Low Priority Articles');
  });

  it('labels just below the 0.4 boundary as Irrelevant', () => {
    expect(getRelevanceLabel(0.39)).toBe('Irrelevant Articles');
    expect(getRelevanceLabel(0)).toBe('Irrelevant Articles');
  });

  it('labels negative scores as Irrelevant', () => {
    expect(getRelevanceLabel(-1)).toBe('Irrelevant Articles');
  });
});

describe('getRelevanceColors', () => {
  // getRelevanceColors returns i18n KEYS for the label (resolved to display
  // text by the caller via i18n), unlike getRelevanceLabel which returns the
  // English section heading.
  it('returns the Unprocessed style for negative scores', () => {
    expect(getRelevanceColors(-0.1).label).toBe('relevance.unprocessed');
  });

  it('returns Emergency for scores above 1.0', () => {
    const colors = getRelevanceColors(1.1);
    expect(colors.label).toBe('relevance.emergency');
    expect(colors.borderColor).toBe('#6A1B9A');
  });

  it('returns High at the 0.8 boundary up to 1.0 inclusive', () => {
    expect(getRelevanceColors(0.8).label).toBe('relevance.high');
    expect(getRelevanceColors(1.0).label).toBe('relevance.high');
  });

  it('returns Med at the 0.6 boundary', () => {
    expect(getRelevanceColors(0.6).label).toBe('relevance.medium');
    expect(getRelevanceColors(0.79).label).toBe('relevance.medium');
  });

  it('returns Low at/above 0.4 (RENDER_GATE, inclusive)', () => {
    expect(getRelevanceColors(0.4).label).toBe('relevance.low');
    expect(getRelevanceColors(0.59).label).toBe('relevance.low');
  });

  it('returns Irrelevant just below 0.4 (but non-negative)', () => {
    expect(getRelevanceColors(0.39).label).toBe('relevance.irrelevant');
    expect(getRelevanceColors(0).label).toBe('relevance.irrelevant');
  });

  it('always returns all four color fields', () => {
    const colors = getRelevanceColors(0.9);
    expect(colors).toEqual(
      expect.objectContaining({
        backgroundColor: expect.any(String),
        borderColor: expect.any(String),
        textColor: expect.any(String),
        label: expect.any(String),
      }),
    );
  });

  // Band-purity: getRelevanceColors' band (once past the negative-sentinel
  // guard) must always agree with `bandOf` itself, for every boundary score the
  // ladder-unification wave cares about.
  it.each([0.4, 0.55, 0.6, 0.79, 0.8, 1.05])(
    'agrees with bandOf(%s) on which band a score belongs to',
    (relevance) => {
      const band = bandOf(relevance);
      const label = getRelevanceColors(relevance).label;
      const expected: Record<string, string> = {
        EMERGENCY: 'relevance.emergency',
        HIGH: 'relevance.high',
        MEDIUM: 'relevance.medium',
        LOW: 'relevance.low',
        SUB_GATE: 'relevance.irrelevant',
      };
      expect(label).toBe(expected[band]);
    },
  );
});
