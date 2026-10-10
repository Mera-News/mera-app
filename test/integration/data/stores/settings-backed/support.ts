// Shared by the settings-backed store seam tests. Not a test file.
// Fault injection on the real `settings` collection (R26: scoped to one key or
// one query shape, restored in afterEach), a poll for fire-and-forget writes,
// and a logger mock that exposes captureException.
import database from '@/lib/database';
import { getSetting } from '@/lib/database/services/setting-service';
import { addRule, isKey, newGate, restoreFaults as restoreSharedFaults, until, whereKey } from '../../support/faults';

export { failSettingRead, holdSettingRead, until, flush } from '../../support/faults';

let writeSpy: jest.SpyInstance | null = null;

const isPrefixQuery = (conditions: unknown[]) =>
  whereKey(conditions).some((w) => w.comparison?.operator === 'like');

/** Every prefix (`Q.like`) read on `settings` throws. Plain key reads are untouched. */
export function failPrefixRead(error = new Error('settings prefix read failed (injected)')): void {
  addRule('settings', { match: isPrefixQuery, error });
}

/** Counts reads for exactly `key`, passing them through. */
export function countSettingReads(key: string): () => number {
  let hits = 0;
  addRule('settings', { match: isKey(key), onHit: () => (hits += 1) });
  return () => hits;
}

/**
 * The first `settings` read for `key` fetches at once but hands its result over only at
 * `release()`: a read in flight while the row changes underneath it (R23b: delays a real
 * collaborator, replaces nothing).
 */
export function holdNextSettingResult(key: string): { release(): void } {
  const { gate, release } = newGate();
  addRule('settings', { match: isKey(key), gate, late: true, once: true });
  return { release };
}

/** The next `database.write` rejects with `error`, which fails the next setSetting. */
export function failNextWrite(error: Error): void {
  writeSpy = jest.spyOn(database, 'write').mockRejectedValueOnce(error);
}

/** Releases held reads and restores the collection and `database.write`. Call from afterEach. */
export function restoreFaults(): void {
  restoreSharedFaults();
  writeSpy?.mockRestore();
  writeSpy = null;
}

/** The `settings` row a fire-and-forget setter wrote: waits for `expected` (or any value) to land, then returns it. */
export async function persisted(key: string, expected?: string): Promise<string> {
  let value: string | null = null;
  await until(
    async () => (value = await getSetting(key)) !== null && (expected === undefined || value === expected),
    `settings row ${key}${expected === undefined ? '' : ` = ${expected}`}`,
  );
  return value as unknown as string;
}

/** A store back to its construction state, with no side effects (never reset(), which may write). */
export function resetStore(store: unknown): void {
  (store as { setState(s: unknown, replace: true): void }).setState(
    (store as { getInitialState(): unknown }).getInitialState(),
    true,
  );
}
