// Shared by the local-records seam tests (visits, impressions, translation cache, publisher
// names, subscriptions, settings). Not a test file.
//
// Everything runs on the in-memory DB with the real services. Seeding goes through the services.
// The few reads no service offers (a table-wide row count, a raw row list) query the collection
// read-only and say so. The one raw write is `seedLegacyImpression`: no service writes an
// `opened = false` story impression any more, yet devices still hold them.
import database from '@/lib/database';
import logger from '@/lib/logger';
import { __clearPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { __resetTranslationCacheBufferForTests } from '@/lib/database/services/translation-cache-service';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 2026-10-09T12:00:00Z, the "now" of every test in this folder. */
export const T0 = Date.parse('2026-10-09T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Module memory (T-reset)
// ---------------------------------------------------------------------------

/** Memory the per-test DB reset does not touch. Call from `beforeEach`. */
export function resetLocalRecordsMemory(): void {
  __clearPublisherSourceNames();
  __resetTranslationCacheBufferForTests();
}

// ---------------------------------------------------------------------------
// Spies (R23, R26): table-scoped, one call, restored in afterEach
// ---------------------------------------------------------------------------

const spies: jest.SpyInstance[] = [];

/** Tracks a spy so `restoreFaults()` removes it. */
export function track<T extends jest.SpyInstance>(spy: T): T {
  spies.push(spy);
  return spy;
}

/** The NEXT `query()` on `table` throws; later calls reach the real collection. */
export function failNextQuery(table: string, error = new Error(`${table} query failed (injected)`)): jest.SpyInstance {
  return track(
    jest.spyOn(database.get(table) as unknown as { query: (...c: unknown[]) => unknown }, 'query').mockImplementationOnce(() => {
      throw error;
    }),
  );
}

/** Silences and records the logger calls the services make. */
export function quietLogger() {
  return {
    captureException: track(jest.spyOn(logger, 'captureException').mockImplementation(() => '')),
    warn: track(jest.spyOn(logger, 'warn').mockImplementation(() => undefined)),
    debug: track(jest.spyOn(logger, 'debug').mockImplementation(() => undefined)),
  };
}

/** A call-through count of `database.write` transactions. */
export function countWrites(): jest.SpyInstance {
  return track(jest.spyOn(database, 'write'));
}

/** Call from `afterEach`. */
export function restoreFaults(): void {
  for (const spy of spies.splice(0)) spy.mockRestore();
}

// ---------------------------------------------------------------------------
// Reads no service offers
// ---------------------------------------------------------------------------

/** Row count of a table (read-only). */
export async function countRows(table: string): Promise<number> {
  return database.get(table).query().fetchCount();
}

/** `opened = false` impressions are what an older build wrote on every scroll-past. */
export async function seedLegacyImpression(
  articleId: string,
  over: { stableClusterId?: string | null; titleNorm?: string | null; firstSeenAt?: number } = {},
): Promise<void> {
  const seen = new Date(over.firstSeenAt ?? Date.now());
  await database.write(async () => {
    await database.get('story_impressions').create((r: any) => {
      r.articleId = articleId;
      r.stableClusterId = over.stableClusterId ?? null;
      r.suggestionId = null;
      r.titleNorm = over.titleNorm ?? null;
      r.surface = 'feed';
      r.opened = false;
      r.firstSeenAt = seen;
      r.lastSeenAt = seen;
      r.seenCount = 1;
    });
  });
}

// ---------------------------------------------------------------------------
// Polling (real timers)
// ---------------------------------------------------------------------------

/** Real-timer poll; fails with `what` after `timeoutMs`. */
export async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
