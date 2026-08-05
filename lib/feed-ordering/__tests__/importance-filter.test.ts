import {
  DEFAULT_DASHBOARD_IMPORTANCE_THRESHOLD,
  DEFAULT_FEED_IMPORTANCE_THRESHOLD,
  IMPORTANCE_THRESHOLDS,
  isCulledHeadlineRelevance,
  parseImportanceThreshold,
  passesImportanceThreshold,
} from '../importance-filter';

describe('passesImportanceThreshold', () => {
  // Band edges from relevanceBandRank: emergency >1.0, high ≥0.77,
  // medium ≥0.53, low >0.3.
  it("'low' reproduces the 0.3 render gate exactly", () => {
    expect(passesImportanceThreshold(0.3, 'low')).toBe(false);
    expect(passesImportanceThreshold(0.301, 'low')).toBe(true);
    expect(passesImportanceThreshold(0.52, 'low')).toBe(true);
    expect(passesImportanceThreshold(1.1, 'low')).toBe(true);
  });

  it("'medium' admits medium and above only", () => {
    expect(passesImportanceThreshold(0.529, 'medium')).toBe(false);
    expect(passesImportanceThreshold(0.53, 'medium')).toBe(true);
    expect(passesImportanceThreshold(0.77, 'medium')).toBe(true);
    expect(passesImportanceThreshold(0.4, 'medium')).toBe(false);
  });

  it("'high' admits high and emergency only", () => {
    expect(passesImportanceThreshold(0.769, 'high')).toBe(false);
    expect(passesImportanceThreshold(0.77, 'high')).toBe(true);
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
    expect(isCulledHeadlineRelevance(0.529)).toBe(true);
    expect(isCulledHeadlineRelevance(0.4)).toBe(true);
    expect(isCulledHeadlineRelevance(0.2)).toBe(true);
    expect(isCulledHeadlineRelevance(0)).toBe(true);
  });

  it('keeps medium and above', () => {
    expect(isCulledHeadlineRelevance(0.53)).toBe(false);
    expect(isCulledHeadlineRelevance(0.77)).toBe(false);
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
