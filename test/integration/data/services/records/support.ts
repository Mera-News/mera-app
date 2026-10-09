// Shared by the records seam tests (conversations, inference jobs, notifications, user persona,
// persona summaries). Not a test file.
//
// Everything runs on the in-memory DB with the real services and the real models. Seeding goes
// through the services. The few reads no service offers (one row by id, a row count) go to the
// collection read-only, and the one raw write (`corruptColumn`) stands in for a value an older
// build left on a device and no current service would write.
import database from '@/lib/database';
import logger from '@/lib/logger';
import { useStrictClock as strictClockAt } from '@/test/helpers'; // aliased: a use* name in a plain function trips rules-of-hooks

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** 2026-10-09T12:00:00Z, the "now" of every test in this folder. */
export const T0 = Date.parse('2026-10-09T12:00:00.000Z');

/** Strict clock: time moves only when a test says so. */
export const freezeClock = (now: number = T0): void => strictClockAt(now);

// ---------------------------------------------------------------------------
// Spies (R23, R26): table-scoped or logger-scoped, restored in afterEach
// ---------------------------------------------------------------------------

const spies: jest.SpyInstance[] = [];

function track<T extends jest.SpyInstance>(spy: T): T {
  spies.push(spy);
  return spy;
}

/** Call from `afterEach`. */
export function restoreFaults(): void {
  for (const spy of spies.splice(0)) spy.mockRestore();
}

/** The NEXT `query()` on `table` throws; later calls reach the real collection. */
export function failNextQuery(table: string, error = new Error(`${table} query failed (injected)`)): jest.SpyInstance {
  return track(
    jest.spyOn(database.get(table) as unknown as { query: (...c: unknown[]) => unknown }, 'query').mockImplementationOnce(() => {
      throw error;
    }),
  );
}

/** Silences the logger channels the services use and records their calls. */
export function quietLogger() {
  return {
    captureException: track(jest.spyOn(logger, 'captureException').mockImplementation(() => '')),
    captureMessage: track(jest.spyOn(logger, 'captureMessage').mockImplementation(() => '')),
    warn: track(jest.spyOn(logger, 'warn').mockImplementation(() => undefined)),
  };
}

/** A call-through count of `database.write` transactions. */
export function countWrites(): jest.SpyInstance {
  return track(jest.spyOn(database, 'write'));
}

// ---------------------------------------------------------------------------
// Reads no service offers
// ---------------------------------------------------------------------------

/** Row count of a table (read-only). */
export async function countRows(table: string): Promise<number> {
  return database.get(table).query().fetchCount();
}

/** One row by id (read-only), or null once it is gone. */
export async function rowById<T = any>(table: string, id: string): Promise<T | null> {
  try {
    return (await database.get(table).find(id)) as unknown as T;
  } catch {
    return null;
  }
}

/** Rewrites one column of one row. Only for a value no current service writes (a corrupt blob). */
export async function corruptColumn(table: string, id: string, field: string, value: unknown): Promise<void> {
  const row = (await database.get(table).find(id)) as any;
  await database.write(async () => {
    await row.update((r: any) => {
      r[field] = value;
    });
  });
}
