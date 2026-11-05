// lib/auth-client.ts reads the scheme and slug at load, so each case loads its own copy.
import Constants from 'expo-constants';

const realConfig = Constants.expoConfig;

afterEach(() => {
  (Constants as { expoConfig: unknown }).expoConfig = realConfig;
});

function cookieKeyFor(expoConfig: unknown): string {
  (Constants as { expoConfig: unknown }).expoConfig = expoConfig;
  let key = '';
  jest.isolateModules(() => {
    key = require('@/lib/auth-client').AUTH_COOKIE_KEY;
  });
  return key;
}

it('names the storage keys after the configured slug', () => {
  expect(cookieKeyFor({ scheme: ['fork', 'other'], slug: 'fork' })).toBe('fork_cookie');
});

it('falls back to a neutral name when the config is missing', () => {
  expect(cookieKeyFor(null)).toBe('app_cookie');
});
