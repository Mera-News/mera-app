// Shared by the settings-backed store seam tests. Not a test file.
// Fault injection on the real `settings` collection (R26: scoped to one key or
// one query shape, restored in afterEach), a poll for fire-and-forget writes,
// and a logger mock that exposes captureException.
import database from '@/lib/database';
import { getSetting } from '@/lib/database/services/setting-service';

type Rule = {
  match: (conditions: unknown[]) => boolean;
  error?: Error;
  gate?: Promise<void>;
  /** Fetch first, then wait for the gate: the caller gets a stale snapshot. */
  late?: boolean;
  /** Applies to the first matching read only. */
  once?: boolean;
  onHit?: () => void;
};

const rules: Rule[] = [];
const openGates: (() => void)[] = [];
let spy: jest.SpyInstance | null = null;
let writeSpy: jest.SpyInstance | null = null;

type Where = { type?: string; left?: string; comparison?: { operator?: string; right?: { value?: unknown } } };
const whereKey = (conditions: unknown[]) =>
  conditions.filter((c): c is Where => (c as Where)?.type === 'where' && (c as Where).left === 'key');

const isKey = (key: string) => (conditions: unknown[]) =>
  whereKey(conditions).some((w) => w.comparison?.right?.value === key);

const isPrefixQuery = (conditions: unknown[]) =>
  whereKey(conditions).some((w) => w.comparison?.operator === 'like');

function install(): void {
  if (spy) return;
  const collection = database.get('settings') as any;
  const real = collection.query.bind(collection);
  spy = jest.spyOn(collection, 'query').mockImplementation(((...conditions: unknown[]) => {
    for (const rule of rules) {
      if (!rule.match(conditions)) continue;
      rule.onHit?.();
      if (rule.once) rules.splice(rules.indexOf(rule), 1);
      if (rule.error) throw rule.error;
      const query = real(...conditions);
      const realFetch = query.fetch.bind(query);
      query.fetch = async () => {
        if (rule.late) {
          const result = await realFetch();
          await rule.gate;
          return result;
        }
        await rule.gate;
        return realFetch();
      };
      return query;
    }
    return real(...conditions);
  }) as never);
}

/** Every `settings` read for exactly `key` throws. Other keys are untouched. */
export function failSettingRead(key: string, error = new Error(`settings read failed for ${key} (injected)`)): void {
  install();
  rules.push({ match: isKey(key), error });
}

/** Every prefix (`Q.like`) read on `settings` throws. Plain key reads are untouched. */
export function failPrefixRead(error = new Error('settings prefix read failed (injected)')): void {
  install();
  rules.push({ match: isPrefixQuery, error });
}

/** Counts reads for exactly `key`, passing them through. */
export function countSettingReads(key: string): () => number {
  let hits = 0;
  install();
  rules.push({ match: isKey(key), onHit: () => (hits += 1) });
  return () => hits;
}

/** Every `settings` read for exactly `key` waits until `release()`. */
export function holdSettingRead(key: string): { release(): void; hits(): number } {
  let hits = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  openGates.push(release);
  install();
  rules.push({ match: isKey(key), gate, onHit: () => (hits += 1) });
  return { release, hits: () => hits };
}

/**
 * The first `settings` read for `key` fetches at once but hands its result over only at
 * `release()`: a read in flight while the row changes underneath it (R23b: delays a real
 * collaborator, replaces nothing).
 */
export function holdNextSettingResult(key: string): { release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  openGates.push(release);
  install();
  rules.push({ match: isKey(key), gate, late: true, once: true });
  return { release };
}

/** The next `database.write` rejects with `error`, which fails the next setSetting. */
export function failNextWrite(error: Error): void {
  writeSpy = jest.spyOn(database, 'write').mockRejectedValueOnce(error);
}

/** Releases held reads and restores the collection and `database.write`. Call from afterEach. */
export function restoreFaults(): void {
  for (const release of openGates.splice(0)) release();
  spy?.mockRestore();
  writeSpy?.mockRestore();
  spy = null;
  writeSpy = null;
  rules.length = 0;
}

/** Real-timer poll; fails with `what` after `timeoutMs`. */
export async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets already-runnable promise chains and DB callbacks run. */
export async function flush(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
