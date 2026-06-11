// Tests for version.ts when expoConfig has no version/gitCommit.

jest.mock('expo-constants', () => ({
  default: {
    expoConfig: null,
  },
}));

import { getGitCommit, getAppVersion, getAppVersionLabel } from '../version';

describe('version module — null expoConfig fallbacks', () => {
  it('getGitCommit returns "unknown" when expoConfig is null', () => {
    expect(getGitCommit()).toBe('unknown');
  });

  it('getAppVersion returns empty string when expoConfig is null', () => {
    expect(getAppVersion()).toBe('');
  });

  it('getAppVersionLabel returns only "unknown" (no version prefix) when version is empty', () => {
    // version is '' (falsy) → label = commit only = 'unknown'
    expect(getAppVersionLabel()).toBe('unknown');
  });
});
