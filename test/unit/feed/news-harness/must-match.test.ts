// normalizeMustMatch: pure; the server holds an identical copy, so these cases are the shared contract.
import { normalizeMustMatch } from '@/lib/news-harness';

describe('normalizeMustMatch', () => {
  it('accepts only an array of strings', () => {
    expect(normalizeMustMatch(undefined)).toEqual([]);
    expect(normalizeMustMatch('Web Summit')).toEqual([]);
    expect(normalizeMustMatch({ 0: 'Web Summit' })).toEqual([]);
    expect(normalizeMustMatch([42, null, { n: 'x' }, 'Web Summit'])).toEqual(['Web Summit']);
  });

  it('trims, and drops names under 3 or over 60 characters instead of cutting them', () => {
    const sixty = 'A'.repeat(60);
    const sixtyOne = 'B'.repeat(61);
    expect(normalizeMustMatch(['  Web Summit  ', 'AI', '  EU ', sixty, sixtyOne])).toEqual(['Web Summit', sixty]);
  });

  it('returns NFC for NFD input', () => {
    const nfd = 'Ciudad Me\u0301xico Expo';
    const out = normalizeMustMatch([nfd]);
    expect(out).toEqual(['Ciudad M\u00e9xico Expo']);
    expect(out[0]).toBe(out[0].normalize('NFC'));
  });

  it('dedupes case-insensitively keeping the first, and keeps at most 3', () => {
    expect(normalizeMustMatch(['Web Summit', 'web summit', 'WebSummit', 'Paddy Cosgrave', 'Cosgrave', 'Fourth'])).toEqual([
      'Web Summit',
      'WebSummit',
      'Paddy Cosgrave',
    ]);
  });
});
