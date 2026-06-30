// version.ts wraps expo-constants.
// jest.setup.js registers: expoConfig = { scheme:'exampleapp', slug:'exampleapp',
//   extra: { eas: { projectId: '...' } } }  — no `version`, no `gitCommit`.
//
// We test against the values the global mock provides, and additionally
// patch the live Constants object to cover the "version present" branch.

import Constants from 'expo-constants';
import { getGitCommit, getAppVersion, getAppVersionLabel, isVersionOlder } from '../version';

describe('getGitCommit', () => {
  it('returns a string', () => {
    expect(typeof getGitCommit()).toBe('string');
  });

  it('returns "unknown" when extra.gitCommit is absent', () => {
    // jest.setup.js mock: extra = { eas: { projectId: '...' } } — no gitCommit
    expect(getGitCommit()).toBe('unknown');
  });

  it('returns the gitCommit when it is set on the Constants mock', () => {
    const origExtra = (Constants as any).expoConfig?.extra;
    (Constants as any).expoConfig = { extra: { gitCommit: 'aabbcc' } };
    expect(getGitCommit()).toBe('aabbcc');
    (Constants as any).expoConfig = { extra: origExtra };
  });
});

describe('getAppVersion', () => {
  it('returns a string', () => {
    expect(typeof getAppVersion()).toBe('string');
  });

  it('returns empty string when expoConfig has no version', () => {
    // jest.setup.js mock has no `version` field
    expect(getAppVersion()).toBe('');
  });

  it('returns the version when it is set', () => {
    const orig = (Constants as any).expoConfig;
    (Constants as any).expoConfig = { version: '3.1.4', extra: {} };
    expect(getAppVersion()).toBe('3.1.4');
    (Constants as any).expoConfig = orig;
  });
});

describe('getAppVersionLabel', () => {
  it('returns a string', () => {
    expect(typeof getAppVersionLabel()).toBe('string');
  });

  it('returns just the commit (no "v" prefix) when version is empty', () => {
    // version = '' is falsy → label = commit = 'unknown'
    const label = getAppVersionLabel();
    expect(label).toBe('unknown');
  });

  it('formats "vX.Y.Z · commit" when both version and commit are set', () => {
    const orig = (Constants as any).expoConfig;
    (Constants as any).expoConfig = { version: '2.0.0', extra: { gitCommit: 'abc123' } };
    expect(getAppVersionLabel()).toBe('v2.0.0 · abc123');
    (Constants as any).expoConfig = orig;
  });
});

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
