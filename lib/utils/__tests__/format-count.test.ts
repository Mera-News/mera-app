import { formatCount } from '@/lib/utils/format-count';

describe('formatCount', () => {
    it('groups a large count with the given locale', () => {
        expect(formatCount(149370, 'en')).toBe('149,370');
    });

    it('uses locale-specific grouping separators', () => {
        expect(formatCount(149370, 'de')).toBe('149.370');
        expect(formatCount(149370, 'hi')).toBe('1,49,370');
    });

    it('formats small counts too (same rule, no special-casing)', () => {
        expect(formatCount(5, 'en')).toBe('5');
        expect(formatCount(0, 'en')).toBe('0');
    });

    it('falls back to en grouping when locale is missing', () => {
        expect(formatCount(149370, null)).toBe('149,370');
        expect(formatCount(149370, undefined)).toBe('149,370');
        expect(formatCount(149370, '')).toBe('149,370');
    });

    it('falls back to en grouping when locale is a malformed BCP-47 tag', () => {
        // A too-long "language" subtag (Intl requires 2-3 or 4-8 alpha chars —
        // "bogus" fails that) throws a RangeError inside toLocaleString, which
        // is exactly the defensive path this fallback exists for.
        expect(formatCount(149370, 'bogus-locale-xyz')).toBe('149,370');
    });

    it('returns non-finite values via String() rather than throwing', () => {
        expect(formatCount(NaN, 'en')).toBe('NaN');
        expect(formatCount(Infinity, 'en')).toBe('Infinity');
    });
});
