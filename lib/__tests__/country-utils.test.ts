import { getFlagEmoji, getCountryName } from '../country-utils';

describe('getFlagEmoji', () => {
  it('returns a flag emoji for a valid alpha-3 code', () => {
    // USA -> US -> regional indicators 🇺🇸
    expect(getFlagEmoji('USA')).toBe('\u{1F1FA}\u{1F1F8}');
  });

  it('returns an empty string for null/undefined/empty input', () => {
    expect(getFlagEmoji(null)).toBe('');
    expect(getFlagEmoji(undefined)).toBe('');
    expect(getFlagEmoji('')).toBe('');
  });

  it('returns an empty string for an unknown alpha-3 code', () => {
    expect(getFlagEmoji('ZZZ')).toBe('');
  });
});

describe('getCountryName', () => {
  it('resolves a known alpha-3 code to its English name', () => {
    expect(getCountryName('FRA')).toBe('France');
  });

  it('falls back to the raw code when unknown', () => {
    expect(getCountryName('ZZZ')).toBe('ZZZ');
  });
});
