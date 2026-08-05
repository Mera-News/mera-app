import {
  DEFAULT_DASHBOARD_IMPORTANCE_THRESHOLD,
  DEFAULT_FEED_IMPORTANCE_THRESHOLD,
  IMPORTANCE_THRESHOLDS,
  isCulledHeadlineRelevance,
  parseImportanceThreshold,
  passesImportanceThreshold,
} from '../importance-filter';

// relevance v3 (2026-08-05) band-ladder unification: `relevanceBandRank` (which
// this module is built on) moved off its own 0.53/0.77 cutoffs onto the unified
// `bandOf` cutoffs — 0.4 (RENDER_GATE, also the LOW floor) / 0.6 / 0.8.
describe('passesImportanceThreshold', () => {
  // Band edges from relevanceBandRank: emergency >1.0, high ≥0.8, medium ≥0.6,
  // low ≥0.4 (RENDER_GATE, inclusive).
  it("'low' reproduces the 0.4 render gate exactly", () => {
    expect(passesImportanceThreshold(0.39, 'low')).toBe(false);
    expect(passesImportanceThreshold(0.4, 'low')).toBe(true);
    expect(passesImportanceThreshold(0.59, 'low')).toBe(true);
    expect(passesImportanceThreshold(1.1, 'low')).toBe(true);
  });

  it("'medium' admits medium and above only", () => {
    expect(passesImportanceThreshold(0.59, 'medium')).toBe(false);
    expect(passesImportanceThreshold(0.6, 'medium')).toBe(true);
    expect(passesImportanceThreshold(0.79, 'medium')).toBe(true);
    expect(passesImportanceThreshold(0.4, 'medium')).toBe(false);
  });

  it("'high' admits high and emergency only", () => {
    expect(passesImportanceThreshold(0.79, 'high')).toBe(false);
    expect(passesImportanceThreshold(0.8, 'high')).toBe(true);
    expect(passesImportanceThreshold(0.6, 'high')).toBe(false);
  });

  it('emergency (>1.0) passes every setting', () => {
    for (const t of IMPORTANCE_THRESHOLDS) {
      expect(passesImportanceThreshold(1.01, t)).toBe(true);
      expect(passesImportanceThreshold(1.1, t)).toBe(true);
    }
  });

  it('sub-render-gate relevance passes nothing', () => {
    for (const t of IMPORTANCE_THRESHOLDS) {
      expect(passesImportanceThreshold(0.2, t)).toBe(false);
      expect(passesImportanceThreshold(0, t)).toBe(false);
    }
  });
});

describe('isCulledHeadlineRelevance', () => {
  it('culls the LOW band and below', () => {
    expect(isCulledHeadlineRelevance(0.59)).toBe(true);
    expect(isCulledHeadlineRelevance(0.4)).toBe(true);
    expect(isCulledHeadlineRelevance(0.2)).toBe(true);
    expect(isCulledHeadlineRelevance(0)).toBe(true);
  });

  it('keeps medium and above', () => {
    expect(isCulledHeadlineRelevance(0.6)).toBe(false);
    expect(isCulledHeadlineRelevance(0.8)).toBe(false);
    expect(isCulledHeadlineRelevance(1.1)).toBe(false);
  });

  it('culls the headline floor ceiling (0.5 < medium band)', () => {
    // HEADLINE_BASE_FLOOR 0.35 + HEADLINE_POP_LIFT 0.15 · popComp(1) = 0.5
    expect(isCulledHeadlineRelevance(0.5)).toBe(true);
  });
});

describe('parseImportanceThreshold', () => {
  it('parses the three literals regardless of fallback', () => {
    expect(parseImportanceThreshold('high', 'low')).toBe('high');
    expect(parseImportanceThreshold('medium', 'low')).toBe('medium');
    expect(parseImportanceThreshold('low', 'high')).toBe('low');
  });

  it('falls back to the given surface default for null and garbage', () => {
    expect(parseImportanceThreshold(null, DEFAULT_FEED_IMPORTANCE_THRESHOLD)).toBe('medium');
    expect(
      parseImportanceThreshold(null, DEFAULT_DASHBOARD_IMPORTANCE_THRESHOLD),
    ).toBe('low');
    expect(parseImportanceThreshold('', 'medium')).toBe('medium');
    expect(parseImportanceThreshold('HIGH', 'low')).toBe('low');
    expect(parseImportanceThreshold('0.6', 'high')).toBe('high');
  });
});
