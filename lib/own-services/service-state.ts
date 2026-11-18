import { create } from 'zustand';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { setReportSecrets } from './report-secrets';

type Secrets = { hosts: string[]; secrets: string[] };

export function createServiceState<T extends object>(opts: {
  key: string;
  kind: 'ownAi' | 'ownNews' | 'pod';
  parse(raw: unknown): T | null;
  secrets(value: T): Secrets;
}) {
  const useStore = create<{ value: T | null; hydrated: boolean }>(() => ({ value: null, hydrated: false }));
  let loading: Promise<void> | null = null;
  // Bumped by every write, so a read that started before it never lands over the newer value.
  let generation = 0;

  const apply = (value: T | null, hydrated: boolean) => {
    useStore.setState({ value, hydrated });
    setReportSecrets(opts.kind, value ? opts.secrets(value) : null);
  };

  const parseRaw = (raw: string | null): T | null => {
    if (raw == null) return null;
    try {
      return opts.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  const read = async () => {
    const started = generation;
    // A throw propagates: an error is never "no item", which would send requests to Mera.
    const raw = await secureStore.getItemAsync(opts.key);
    if (started !== generation) return;
    apply(parseRaw(raw), true);
  };

  return {
    useStore,
    hydrate(): Promise<void> {
      if (useStore.getState().hydrated) return Promise.resolve();
      if (!loading) {
        loading = read().catch((err) => {
          loading = null;
          throw err;
        });
      }
      return loading;
    },
    /**
     * Reads the item synchronously when it is not in memory yet, for a caller that must decide now.
     * True once the state is known. A keychain that throws (locked) leaves it unknown: never "no item".
     */
    hydrateSync(): boolean {
      if (useStore.getState().hydrated) return true;
      let raw: string | null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const SecureStore = require('expo-secure-store') as typeof import('expo-secure-store');
        raw = SecureStore.getItem(opts.key, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
      } catch {
        return false;
      }
      generation += 1;
      apply(parseRaw(raw), true);
      return true;
    },
    get: () => useStore.getState().value,
    isHydrated: () => useStore.getState().hydrated,
    async save(value: T): Promise<void> {
      await secureStore.setItemAsync(opts.key, JSON.stringify(value));
      generation += 1;
      // Memory now equals the stored item, so it counts as read.
      apply(value, true);
    },
    async clear(): Promise<void> {
      await secureStore.deleteItemAsync(opts.key);
      generation += 1;
      apply(null, true);
    },
    resetMemory(): void {
      generation += 1;
      loading = null;
      apply(null, false);
    },
  };
}
