import { getRelevanceLabel, getRelevanceColors } from '../relevance-utils';

describe('getRelevanceLabel', () => {
  it('labels scores above 1.0 as Emergency Priority', () => {
    expect(getRelevanceLabel(1.5)).toBe('Emergency Priority Articles');
  });

  it('labels the high boundary (0.77) as High Priority', () => {
    expect(getRelevanceLabel(0.77)).toBe('High Priority Articles');
    expect(getRelevanceLabel(1.0)).toBe('High Priority Articles');
  });

  it('labels the medium boundary (0.53) as Medium Priority', () => {
    expect(getRelevanceLabel(0.53)).toBe('Medium Priority Articles');
    expect(getRelevanceLabel(0.76)).toBe('Medium Priority Articles');
  });

  it('labels scores just above 0.3 as Low Priority', () => {
    expect(getRelevanceLabel(0.31)).toBe('Low Priority Articles');
    expect(getRelevanceLabel(0.52)).toBe('Low Priority Articles');
  });

  it('labels the 0.3 boundary itself as Irrelevant (strict >)', () => {
    expect(getRelevanceLabel(0.3)).toBe('Irrelevant Articles');
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

  it('returns High at the 0.77 boundary up to 1.0 inclusive', () => {
    expect(getRelevanceColors(0.77).label).toBe('relevance.high');
    expect(getRelevanceColors(1.0).label).toBe('relevance.high');
  });

  it('returns Med at the 0.53 boundary', () => {
    expect(getRelevanceColors(0.53).label).toBe('relevance.medium');
    expect(getRelevanceColors(0.76).label).toBe('relevance.medium');
  });

  it('returns Low just above 0.3', () => {
    expect(getRelevanceColors(0.31).label).toBe('relevance.low');
    expect(getRelevanceColors(0.52).label).toBe('relevance.low');
  });

  it('returns Irrelevant at and below 0.3 (but non-negative)', () => {
    expect(getRelevanceColors(0.3).label).toBe('relevance.irrelevant');
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
});
