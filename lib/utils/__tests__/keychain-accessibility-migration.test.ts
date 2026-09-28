// keychain-accessibility-migration — the one-time delete+re-add that moves the
// better-auth items to AFTER_FIRST_UNLOCK. The keychain is an in-memory map.

const mockStore = new Map<string, string>();
const mockOps: string[] = [];
let mockFailOn: string | null = null;
jest.mock('@/lib/utils/secure-store-adapter', () => ({
  secureStore: {
    getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      if (mockFailOn === `set:${k}`) throw new Error('keychain locked');
      mockOps.push(`set:${k}`);
      mockStore.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      mockOps.push(`del:${k}`);
      mockStore.delete(k);
    }),
  },
}));

let mockOS = 'ios';
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockOS;
    },
  },
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { slug: 'mera' } } }));

const mockSettings = new Map<string, string>();
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => {
    mockSettings.set(k, v);
  }),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));

import {
  runKeychainAccessibilityMigration,
  KEYCHAIN_AFU_MIGRATION_KEY,
} from '../keychain-accessibility-migration';

beforeEach(() => {
  mockStore.clear();
  mockSettings.clear();
  mockOps.length = 0;
  mockFailOn = null;
  mockOS = 'ios';
});

it('re-adds each stored item (delete then set) and writes the marker', async () => {
  mockStore.set('mera_cookie', 'c');
  mockStore.set('mera_session_data', 's');

  expect(await runKeychainAccessibilityMigration()).toBe('migrated');

  expect(mockStore.get('mera_cookie')).toBe('c');
  expect(mockStore.get('mera_session_data')).toBe('s');
  const cookieOps = mockOps.filter((o) => o.includes('mera_cookie'));
  expect(cookieOps).toEqual([
    'set:mera_cookie_afu_tmp',
    'del:mera_cookie',
    'set:mera_cookie',
    'del:mera_cookie_afu_tmp',
  ]);
  expect(mockSettings.has(KEYCHAIN_AFU_MIGRATION_KEY)).toBe(true);
});

it('does nothing once the marker is set', async () => {
  mockSettings.set(KEYCHAIN_AFU_MIGRATION_KEY, '1');
  mockStore.set('mera_cookie', 'c');
  expect(await runKeychainAccessibilityMigration()).toBe('already-done');
  expect(mockOps).toEqual([]);
});

it('is not needed on Android', async () => {
  mockOS = 'android';
  expect(await runKeychainAccessibilityMigration()).toBe('not-needed');
});

it('restores a value parked by a pass that died between delete and re-add', async () => {
  mockStore.set('mera_cookie_afu_tmp', 'parked');
  expect(await runKeychainAccessibilityMigration()).toBe('migrated');
  expect(mockStore.get('mera_cookie')).toBe('parked');
  expect(mockStore.has('mera_cookie_afu_tmp')).toBe(false);
});

it('fails without a marker and keeps the value parked when the re-add throws', async () => {
  mockStore.set('mera_cookie', 'c');
  mockFailOn = 'set:mera_cookie';
  expect(await runKeychainAccessibilityMigration()).toBe('failed');
  expect(mockSettings.has(KEYCHAIN_AFU_MIGRATION_KEY)).toBe(false);
  expect(mockStore.get('mera_cookie_afu_tmp')).toBe('c');

  // Next foreground: the parked value comes back.
  mockFailOn = null;
  expect(await runKeychainAccessibilityMigration()).toBe('migrated');
  expect(mockStore.get('mera_cookie')).toBe('c');
});
