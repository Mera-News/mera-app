// Shared by the runtime-store seam tests (feed-order, for-you, pin, pending-notification-route,
// opened-stories, floating-chat draft). Not a test file.
//
// Fault injection on the real `settings` collection (R26: scoped to one key, restored in
// afterEach), a call-through write counter (observation, R23b), and polls that work under the
// strict fake clock: the real clock is not available there, so they wait on setImmediate turns,
// which the fake clock leaves real.
import database from '@/lib/database';
import * as settingService from '@/lib/database/services/setting-service';
import { getSetting } from '@/lib/database/services/setting-service';

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

const isFaked = () => typeof (setTimeout as unknown as { clock?: unknown }).clock !== 'undefined';

/**
 * One event-loop turn: setImmediate under a fake clock (the clock leaves it real), a short real wait
 * under real timers. WatermelonDB runs a write queued behind another through a zero-delay timer, so
 * a wait that must outlast such a write under a fake clock also calls `runDueTimers`.
 */
async function turn(): Promise<void> {
  if (isFaked()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
}

/** Fires the timers that are due now on a fake clock, moving time by one millisecond. */
export async function runDueTimers(): Promise<void> {
  if (isFaked()) await jest.advanceTimersByTimeAsync(1);
}

/** Lets already-runnable promise chains and DB callbacks run. */
export async function settle(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await turn();
}

/** Polls until `condition` holds; fails with `what` after `maxTurns` event-loop turns. */
export async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  maxTurns = 1500,
): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (await condition()) return;
    await runDueTimers();
    await turn();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The `settings` row a fire-and-forget setter wrote: waits for `expected` to land. */
export async function rowIs(key: string, expected: string | null): Promise<void> {
  await until(async () => (await getSetting(key)) === expected, `settings row ${key} = ${expected}`);
}

/** The `settings` row once any value has landed. */
export async function rowAppears(key: string): Promise<string> {
  let value: string | null = null;
  await until(async () => (value = await getSetting(key)) !== null, `settings row ${key}`);
  return value as unknown as string;
}

/** A store back to its construction state, with no side effects (never reset(), which may write). */
export function resetStore(store: unknown): void {
  (store as { setState(s: unknown, replace: true): void }).setState(
    (store as { getInitialState(): unknown }).getInitialState(),
    true,
  );
}

/**
 * Resolves once every write already queued has finished. A fire-and-forget write still in flight
 * when a fake clock is swapped back would never finish and would block the next test's database
 * reset (a hook timeout), so a test that ends with unawaited writes drains them first.
 */
export async function drainWrites(): Promise<void> {
  const drained = database.write(async () => undefined) as Promise<void>;
  let done = false;
  void drained.then(() => (done = true));
  await until(async () => {
    await runDueTimers();
    return done;
  }, 'queued writes to finish');
}

// ---------------------------------------------------------------------------
// Fault injection on a real collection (R26)
// ---------------------------------------------------------------------------

type Rule = { match: (conditions: unknown[]) => boolean; error?: Error; onHit?: () => void };

const rules: Rule[] = [];
let querySpy: jest.SpyInstance | null = null;
let writeSpy: jest.SpyInstance | null = null;

type Where = { type?: string; left?: string; comparison?: { right?: { value?: unknown } } };
const isKey = (key: string) => (conditions: unknown[]) =>
  conditions.some((c) => {
    const w = c as Where;
    return w?.type === 'where' && w.left === 'key' && w.comparison?.right?.value === key;
  });

function install(): void {
  if (querySpy) return;
  const collection = database.get('settings') as any;
  const real = collection.query.bind(collection);
  querySpy = jest.spyOn(collection, 'query').mockImplementation(((...conditions: unknown[]) => {
    for (const rule of rules) {
      if (!rule.match(conditions)) continue;
      rule.onHit?.();
      if (rule.error) throw rule.error;
      break;
    }
    return real(...conditions);
  }) as never);
}

/** Every `settings` read for exactly `key` throws. Other keys are untouched. */
export function failSettingRead(key: string, error = new Error(`settings read failed for ${key} (injected)`)): void {
  install();
  rules.push({ match: isKey(key), error });
}

const tableSpies = new Map<string, jest.SpyInstance>();

/** Every query on `table` throws, whatever its conditions. */
export function failTableQuery(table: string, error = new Error(`${table} query failed (injected)`)): void {
  const collection = database.get(table) as any;
  tableSpies.get(table)?.mockRestore();
  tableSpies.set(table, jest.spyOn(collection, 'query').mockImplementation((() => {
    throw error;
  }) as never));
}

/** Counts `settings` reads for exactly `key`, passing them through. */
export function countSettingReads(key: string): () => number {
  let hits = 0;
  install();
  rules.push({ match: isKey(key), onHit: () => (hits += 1) });
  return () => hits;
}

/** The next `database.write` rejects with `error`, which fails the next setSetting / deleteSetting. */
export function failNextWrite(error: Error): void {
  writeSpy = jest.spyOn(database, 'write').mockRejectedValueOnce(error);
}

let setSettingSpy: jest.SpyInstance | null = null;
const writeCounts = new Map<string, number>();
const writeFailures = new Map<string, Error>();

function installSetSettingSpy(): void {
  if (setSettingSpy) return;
  const real = settingService.setSetting;
  setSettingSpy = jest.spyOn(settingService, 'setSetting').mockImplementation(async (key: string, value: string) => {
    writeCounts.set(key, (writeCounts.get(key) ?? 0) + 1);
    const failure = writeFailures.get(key);
    if (failure) {
      writeFailures.delete(key); // one call
      throw failure;
    }
    return real(key, value);
  });
}

/** Counts `setSetting` calls for `key` from now on, calling through to the real service. */
export function watchWrites(key: string): () => number {
  installSetSettingSpy();
  const baseline = writeCounts.get(key) ?? 0;
  return () => (writeCounts.get(key) ?? 0) - baseline;
}

/** The next `setSetting` for exactly `key` rejects with `error` (R26: one key, one call). */
export function failSettingWrite(key: string, error: Error): void {
  installSetSettingSpy();
  writeFailures.set(key, error);
}

/** Restores the collection, `database.write` and `setSetting`. Call from afterEach. */
export function restoreFaults(): void {
  querySpy?.mockRestore();
  writeSpy?.mockRestore();
  setSettingSpy?.mockRestore();
  setSettingSpy = null;
  writeCounts.clear();
  writeFailures.clear();
  for (const spy of tableSpies.values()) spy.mockRestore();
  tableSpies.clear();
  querySpy = writeSpy = null;
  rules.length = 0;
}
