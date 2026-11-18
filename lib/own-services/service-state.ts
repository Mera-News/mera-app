import { create } from 'zustand';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { setReportSecrets } from './report-secrets';

type Secrets = { hosts: string[]; secrets: string[] };

export function createServiceState<T extends { on: boolean }>(opts: {
  key: string;
  kind: 'ownAi' | 'ownNews';
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

  const read = async () => {
    const started = generation;
    // A throw propagates: an error is never "no item", which would send requests to Mera.
    const raw = await secureStore.getItemAsync(opts.key);
    if (started !== generation) return;
    let value: T | null = null;
    if (raw != null) {
      try {
        value = opts.parse(JSON.parse(raw));
      } catch {
        value = null;
      }
    }
    apply(value, true);
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
