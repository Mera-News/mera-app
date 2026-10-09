// Stateful in-memory expo-secure-store and AsyncStorage for the integration
// project. One Map per store, cleared by resetStorage() before each test.
const secure = new Map<string, string>();
const asyncStore = new Map<string, string>();
const failures = new Map<string, Error>();

type Op = 'get' | 'set' | 'delete';
const failKey = (key: string, op: Op) => `${op}:${key}`;

/** Makes `op` reject for `key` until resetStorage(). */
export function failSecureStore(key: string, op: Op, error = new Error('keychain failure (injected)')): void {
  failures.set(failKey(key, op), error);
}

export function secureStoreDump(): Record<string, string> {
  return Object.fromEntries(secure);
}

export function resetStorage(): void {
  secure.clear();
  asyncStore.clear();
  failures.clear();
}

const check = (key: string, op: Op) => {
  const err = failures.get(failKey(key, op));
  if (err) throw err;
};

// Values copied from expo-secure-store's native constants.
export const secureStoreModule = {
  AFTER_FIRST_UNLOCK: 0,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  ALWAYS: 2,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 3,
  ALWAYS_THIS_DEVICE_ONLY: 4,
  WHEN_UNLOCKED: 5,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  isAvailableAsync: async () => true,
  canUseBiometricAuthentication: () => false,
  getItemAsync: async (key: string) => {
    check(key, 'get');
    return secure.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    check(key, 'set');
    secure.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    check(key, 'delete');
    secure.delete(key);
  },
  getItem: (key: string) => {
    check(key, 'get');
    return secure.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    check(key, 'set');
    secure.set(key, value);
  },
};

export const asyncStorageModule = {
  __esModule: true,
  default: {
    getItem: async (k: string) => asyncStore.get(k) ?? null,
    setItem: async (k: string, v: string) => void asyncStore.set(k, v),
    removeItem: async (k: string) => void asyncStore.delete(k),
    mergeItem: async (k: string, v: string) => {
      const prev = asyncStore.get(k);
      asyncStore.set(k, prev ? JSON.stringify({ ...JSON.parse(prev), ...JSON.parse(v) }) : v);
    },
    clear: async () => asyncStore.clear(),
    getAllKeys: async () => [...asyncStore.keys()],
    multiGet: async (keys: string[]) => keys.map((k) => [k, asyncStore.get(k) ?? null] as const),
    multiSet: async (pairs: [string, string][]) => void pairs.forEach(([k, v]) => asyncStore.set(k, v)),
    multiRemove: async (keys: string[]) => void keys.forEach((k) => asyncStore.delete(k)),
  },
};
