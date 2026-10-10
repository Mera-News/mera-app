import { isVersionOlder } from '../version-compare';

describe('isVersionOlder', () => {
  it('returns true when current is an older release', () => {
    expect(isVersionOlder('1.1.10', '1.2.0')).toBe(true);
    expect(isVersionOlder('1.2.0', '2.0.0')).toBe(true);
    expect(isVersionOlder('1.0.0', '1.0.1')).toBe(true);
  });

  it('compares segments numerically, not lexically', () => {
    // "10" > "9" numerically even though "10" < "9" as strings
    expect(isVersionOlder('1.1.9', '1.1.10')).toBe(true);
    expect(isVersionOlder('1.1.10', '1.1.9')).toBe(false);
  });

  it('returns false for equal versions', () => {
    expect(isVersionOlder('1.2.0', '1.2.0')).toBe(false);
  });

  it('treats missing trailing segments as zero', () => {
    expect(isVersionOlder('1.2', '1.2.0')).toBe(false);
    expect(isVersionOlder('1.2', '1.2.1')).toBe(true);
    expect(isVersionOlder('1.2.0', '1.2')).toBe(false);
  });

  it('returns false when current is newer', () => {
    expect(isVersionOlder('2.0.0', '1.9.9')).toBe(false);
  });

  it('never reports older for empty or non-numeric versions (no false force-update)', () => {
    expect(isVersionOlder('', '1.2.0')).toBe(false);
    expect(isVersionOlder('1.2.0', '')).toBe(false);
    expect(isVersionOlder('1.2.0-beta', '1.3.0')).toBe(false);
    expect(isVersionOlder('abc', '1.0.0')).toBe(false);
  });
});
