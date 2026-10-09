// Shared by the hydrate-and-wipe seam tests: fault injection on the real
// WatermelonDB collections, a reset of the module memory a per-test DB reset
// does not touch, and a few polling helpers. Not a test file.
import database from '@/lib/database';
import { resetBackupSettingsMirror } from '@/lib/backup/backup-settings';
import { __clearPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { resetPageOrders } from '@/lib/navigation/page-order';
import { resetMeraButtonCorner } from '@/components/custom/mera-button/corner';
import { resetFeedViewPrefs } from '@/components/custom/feed/feed-view-prefs';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useAppStateStore } from '@/lib/stores/app-state-store';
import { useBlurImagesStore } from '@/lib/stores/blur-images-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useForYouPrefsStore } from '@/lib/stores/for-you-prefs-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useOnboardingStore } from '@/lib/stores/onboarding-store';
import { useRelatedSortStore } from '@/lib/stores/related-sort-store';
import { useStartupTabStore } from '@/lib/stores/startup-tab-store';
import { useTextScaleStore } from '@/lib/stores/text-scale-store';
import { useTutorialsStore } from '@/lib/stores/tutorials-store';
import { useUserStore } from '@/lib/stores/user-store';

// ---------------------------------------------------------------------------
// Module memory
// ---------------------------------------------------------------------------

const hydratedStores = [
  useForYouStore,
  useUserStore,
  useMeraProtocolStore,
  useOnboardingStore,
  useAppLanguageStore,
  useAppStateStore,
  useForYouPrefsStore,
  useBlurImagesStore,
  useDisplayPrefsStore,
  useRelatedSortStore,
  useTextScaleStore,
  useTutorialsStore,
  useStartupTabStore,
  useDatabaseStore,
];

/**
 * Back to a cold start: the per-test setup resets storage and the DB but not the
 * memory that mirrors them. setState(initial, true) rather than each store's
 * reset()/clearUser(), because several of those also fire DB deletes that would
 * land in the next test.
 */
export function resetHydrationMemory(): void {
  resetPageOrders();
  __clearPublisherSourceNames();
  resetBackupSettingsMirror();
  resetFeedViewPrefs();
  resetMeraButtonCorner();
  for (const store of hydratedStores) {
    (store as unknown as { setState(s: unknown, replace: true): void }).setState(
      (store as unknown as { getInitialState(): unknown }).getInitialState(),
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Fault injection on a real collection
// ---------------------------------------------------------------------------

type Rule = {
  match: (conditions: unknown[]) => boolean;
  error?: Error;
  gate?: Promise<void>;
  onHit?: () => void;
};

const rulesByTable = new Map<string, Rule[]>();
const spiesByTable = new Map<string, jest.SpyInstance>();
const openGates: (() => void)[] = [];

function install(table: string): Rule[] {
  let rules = rulesByTable.get(table);
  if (rules) return rules;
  rules = [];
  rulesByTable.set(table, rules);
  const collection = database.get(table) as any;
  const real = collection.query.bind(collection);
  const spy = jest.spyOn(collection, 'query').mockImplementation(((...conditions: unknown[]) => {
    for (const rule of rulesByTable.get(table) ?? []) {
      if (!rule.match(conditions)) continue;
      rule.onHit?.();
      if (rule.error) throw rule.error;
      const query = real(...conditions);
      const realFetch = query.fetch.bind(query);
      query.fetch = async () => {
        await rule.gate;
        return realFetch();
      };
      return query;
    }
    return real(...conditions);
  }) as never);
  spiesByTable.set(table, spy);
  return rules;
}

const isKey = (key: string) => (conditions: unknown[]) =>
  conditions.some((c) => {
    const w = c as { type?: string; left?: string; comparison?: { right?: { value?: unknown } } };
    return w?.type === 'where' && w.left === 'key' && w.comparison?.right?.value === key;
  });

/** Every `settings` read for exactly `key` throws. Other keys are untouched. */
export function failSettingRead(key: string, error = new Error(`settings read failed for ${key} (injected)`)): void {
  install('settings').push({ match: isKey(key), error });
}

/** Every `settings` read for exactly `key` waits until `release()`. `hits()` counts how many arrived. */
export function holdSettingRead(key: string): { release(): void; hits(): number } {
  let hits = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  openGates.push(release);
  install('settings').push({ match: isKey(key), gate, onHit: () => (hits += 1) });
  return { release, hits: () => hits };
}

/** Every query on `table` throws, whatever its conditions. */
export function failTableQuery(table: string, error = new Error(`${table} query failed (injected)`)): void {
  install(table).push({ match: () => true, error });
}

/** Every query on `table` waits until `release()`. */
export function holdTableQuery(table: string): { release(): void; hits(): number } {
  let hits = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  openGates.push(release);
  install(table).push({ match: () => true, gate, onHit: () => (hits += 1) });
  return { release, hits: () => hits };
}

/** Releases held reads and restores every spied collection. Call from afterEach. */
export function restoreFaults(): void {
  for (const release of openGates.splice(0)) release();
  for (const spy of spiesByTable.values()) spy.mockRestore();
  spiesByTable.clear();
  rulesByTable.clear();
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** Real-timer poll; fails with `what` after `timeoutMs`. */
export async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets already-runnable promise chains and DB callbacks run. */
export async function flush(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
