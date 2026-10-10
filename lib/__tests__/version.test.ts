// version.ts wraps expo-constants.
// jest.setup.js registers: expoConfig = { scheme:'exampleapp', slug:'exampleapp',
//   extra: { eas: { projectId: '...' } } }  — no `version`, no `gitCommit`.
//
// We test against the values the global mock provides, and additionally
// patch the live Constants object to cover the "version present" branch.

import Constants from 'expo-constants';
import { getGitCommit, getAppVersion, getAppVersionLabel } from '../version';

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
