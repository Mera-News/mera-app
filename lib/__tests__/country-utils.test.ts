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

  it('spells out the aliases that are abbreviations or carry "The"', () => {
    expect(getCountryName('GBR')).toBe('United Kingdom');
    expect(getCountryName('NLD')).toBe('Netherlands');
    expect(getCountryName('ARE')).toBe('United Arab Emirates');
    expect(getCountryName('GMB')).toBe('Gambia');
  });

  it('never names Taiwan a province', () => {
    expect(getCountryName('TWN')).toBe('Taiwan');
  });

  it('keeps every other alias', () => {
    expect(getCountryName('RUS')).toBe('Russia');
    expect(getCountryName('VNM')).toBe('Vietnam');
    expect(getCountryName('USA')).toBe('United States');
  });

  it('falls back to the raw code when unknown', () => {
    expect(getCountryName('ZZZ')).toBe('ZZZ');
  });
});
