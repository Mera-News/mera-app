// The R26 fault-injection helpers every data seam suite shares. Not a test file.
// Faults sit on the REAL WatermelonDB collection or adapter (a key-scoped query rule, a gate that
// holds a read, an atomic batch refusal) and are all put back by `restoreFaults()` in afterEach.
import database from '@/lib/database';

export type Rule = {
  match: (conditions: unknown[]) => boolean;
  error?: Error;
  gate?: Promise<void>;
  /** Fetch first, then wait for the gate: the caller gets a stale snapshot. */
  late?: boolean;
  /** Applies to the first matching read only. */
  once?: boolean;
  onHit?: () => void;
};

/** One operation of a batch, as the adapter receives it. `raw` is the row for create / update, the id for a destroy. */
export interface BatchOp {
  table: string;
  state: 'create' | 'update' | 'markAsDeleted' | 'destroyPermanently';
  raw: Record<string, any>;
}

const rulesByTable = new Map<string, Rule[]>();
const spiesByTable = new Map<string, jest.SpyInstance>();
const openGates: (() => void)[] = [];
let batchSpy: jest.SpyInstance | undefined;

function install(table: string): Rule[] {
  const existing = rulesByTable.get(table);
  if (existing) return existing;
  const rules: Rule[] = [];
  rulesByTable.set(table, rules);
  const collection = database.get(table) as any;
  const real = collection.query.bind(collection);
  const spy = jest.spyOn(collection, 'query').mockImplementation(((...conditions: unknown[]) => {
    for (const rule of [...rules]) {
      if (!rule.match(conditions)) continue;
      rule.onHit?.();
      if (rule.once) rules.splice(rules.indexOf(rule), 1);
      if (rule.error) throw rule.error;
      const query = real(...conditions);
      if (!rule.gate) return query;
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
  spiesByTable.set(table, spy);
  return rules;
}

/** Adds a rule to `table`'s query spy, for the faults only one suite needs (prefix reads, read counters, late holds). */
export function addRule(table: string, rule: Rule): void {
  install(table).push(rule);
}

/** A gate `restoreFaults()` opens. */
export function newGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  openGates.push(release);
  return { gate, release };
}

type Where = { type?: string; left?: string; comparison?: { operator?: string; right?: { value?: unknown } } };
export const whereKey = (conditions: unknown[]) =>
  conditions.filter((c): c is Where => (c as Where)?.type === 'where' && (c as Where).left === 'key');
export const isKey = (key: string) => (conditions: unknown[]) =>
  whereKey(conditions).some((w) => w.comparison?.right?.value === key);

/** Every `settings` read for exactly `key` throws. Other keys are untouched. */
export function failSettingRead(key: string, error = new Error(`settings read failed for ${key} (injected)`)): void {
  addRule('settings', { match: isKey(key), error });
}

/** Every `settings` read for exactly `key` waits until `release()`. `hits()` counts how many arrived. */
export function holdSettingRead(key: string): { release(): void; hits(): number } {
  let hits = 0;
  const { gate, release } = newGate();
  addRule('settings', { match: isKey(key), gate, onHit: () => (hits += 1) });
  return { release, hits: () => hits };
}

/** Every query on `table` throws, whatever its conditions. */
export function failTableQuery(table: string, error = new Error(`${table} query failed (injected)`)): void {
  addRule(table, { match: () => true, error });
}

/** Every query on `table` waits until `release()`. */
export function holdTableQuery(table: string): { release(): void; hits(): number } {
  let hits = 0;
  const { gate, release } = newGate();
  addRule(table, { match: () => true, gate, onHit: () => (hits += 1) });
  return { release, hits: () => hits };
}

/**
 * Every batch that includes an operation matching `match` is refused by the ADAPTER: Database.batch
 * has already validated its records and cleared their prepared state, and nothing in the batch is
 * applied. That is what a failed disk write looks like, and it is atomic by construction, so a
 * service that splits the batch in two lands the half that does not match, which an adapter-level
 * count then shows. (Refusing in front of Database.batch instead leaves records "prepared but never
 * batched", which WatermelonDB's own diagnostic rejects.) A second call replaces the first.
 */
export function failBatchWhere(match: (op: BatchOp) => boolean, error = new Error('batch failed (injected)')): void {
  batchSpy?.mockRestore();
  const adapter = database.adapter as unknown as { batch: (ops: unknown[][]) => Promise<void> };
  const real = adapter.batch.bind(adapter);
  batchSpy = jest.spyOn(adapter, 'batch').mockImplementation(((operations: [BatchOp['state'], string, unknown][]) => {
    const ops = operations.map(([state, table, raw]) => ({ state, table, raw }) as BatchOp);
    if (ops.some(match)) return Promise.reject(error);
    return real(operations);
  }) as never);
}

/** Releases held reads and restores every spied collection and the adapter. Call from afterEach. */
export function restoreFaults(): void {
  for (const release of openGates.splice(0)) release();
  for (const spy of spiesByTable.values()) spy.mockRestore();
  spiesByTable.clear();
  rulesByTable.clear();
  batchSpy?.mockRestore();
  batchSpy = undefined;
}

/** Real-timer poll; fails with `what` after `timeoutMs`. */
export async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
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
