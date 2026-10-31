// 1.3.6 ships with EXPO_PUBLIC_USE_RN_FETCH=1 so the global fetch stays React
// Native's. SDK 58's native runtime installs expo/fetch as the global unless the
// flag reads '1' or 'true'. Jest never runs that native runtime, so a global
// fetch assertion here cannot fail; these pin the two things that can drift:
// the flag in this test run, and the name the installed runtime reads.
import fs from 'fs';

describe('EXPO_PUBLIC_USE_RN_FETCH', () => {
  it('is set for the test run, as it is for every build and OTA', () => {
    expect(process.env.EXPO_PUBLIC_USE_RN_FETCH).toBe('1');
  });

  it('is the flag the installed expo runtime gates the global fetch on', () => {
    const src = fs.readFileSync(require.resolve('expo/src/winter/runtime.native.ts'), 'utf8');
    const gate = /const useRnFetch =([^;]+);/.exec(src);
    expect(gate?.[1]).toContain("process.env.EXPO_PUBLIC_USE_RN_FETCH === '1'");
    expect(src).toMatch(/if \(!useRnFetch\) \{[\s\S]*install\('fetch'/);
  });
});
