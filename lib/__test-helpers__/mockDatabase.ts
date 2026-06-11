/**
 * Shared test helpers for unit-testing the WatermelonDB service + model layer
 * WITHOUT a real database (plan Cookbook §1).
 *
 * Every DB service does `import database from '../index'` (the native singleton)
 * and captures collection handles at module load:
 *   const settings = database.get<Setting>('settings');
 * The only seam is that singleton. Mock it with `makeDatabaseMock()`:
 *
 *   jest.mock('@/lib/database/index', () => {
 *     const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
 *     return makeDatabaseMock();
 *   });
 *   import database from '@/lib/database/index';
 *   const db = database as unknown as MockDatabase;
 *
 *   beforeEach(() => {
 *     db._setRows('settings', [makeRecord({ id: '1', key: 'k', value: 'v' })]);
 *   });
 *
 * Notes:
 *  - The collection captured by the service at import time is STABLE; mutate its
 *    rows via `db._setRows(table, rows)` rather than replacing the collection.
 *  - The fake `query()` ignores the `Q.where(...)` predicate and returns every
 *    row you set — give a test only the rows it expects to match, and/or assert
 *    on `collection.query` call args. Import the real `Q` from
 *    `@nozbe/watermelondb` (it is pure data and safe).
 *  - `database.write(fn)` invokes `fn()` synchronously so writer-body mutations
 *    are observable. `database.batch(...ops)` returns the flattened ops so you
 *    can assert what was prepared.
 *  - Records carry generic writer stubs (`update`, `prepareUpdate`,
 *    `destroyPermanently`, ...). Add model-specific writers (e.g. `updateValue`,
 *    `destroyCascade`) via the `initial` arg: `makeRecord({ updateValue: jest.fn() })`.
 */

export interface FakeQuery {
  fetch: jest.Mock;
  fetchCount: jest.Mock;
}

export interface FakeCollection {
  /** Returns a FakeQuery; ignores the predicate and returns the current rows. */
  query: jest.Mock;
  /** Resolves the row whose `id` matches, else rejects (mirrors WMDB). */
  find: jest.Mock;
  /** Runs the writer, pushes a new record into rows, resolves it. */
  create: jest.Mock;
  /** Runs the writer, returns a prepared record (not pushed). */
  prepareCreate: jest.Mock;
  /** Current rows backing this collection. */
  _rows: any[];
  /** Replace the rows this collection returns. */
  _setRows: (rows: any[]) => void;
}

export interface MockDatabase {
  get: jest.Mock;
  collections: { get: jest.Mock };
  write: jest.Mock;
  batch: jest.Mock;
  _collections: Record<string, FakeCollection>;
  _setRows: (table: string, rows: any[]) => void;
}

/** A fake WatermelonDB record with generic writer stubs. */
export function makeRecord(initial: Record<string, any> = {}): any {
  const rec: any = { ...initial };
  if (!rec.update) {
    rec.update = jest.fn(async (fn?: (r: any) => void) => {
      fn?.(rec);
      return rec;
    });
  }
  if (!rec.prepareUpdate) {
    rec.prepareUpdate = jest.fn((fn?: (r: any) => void) => {
      fn?.(rec);
      return rec;
    });
  }
  if (!rec.destroyPermanently) rec.destroyPermanently = jest.fn(async () => {});
  if (!rec.prepareDestroyPermanently) {
    rec.prepareDestroyPermanently = jest.fn(() => rec);
  }
  if (!rec.markAsDeleted) rec.markAsDeleted = jest.fn(async () => {});
  return rec;
}

export function makeCollection(rows: any[] = []): FakeCollection {
  const state = { rows };
  const col: any = {
    query: jest.fn(() => ({
      fetch: jest.fn(async () => state.rows),
      fetchCount: jest.fn(async () => state.rows.length),
    })),
    find: jest.fn(async (id: string) => {
      const found = state.rows.find((r) => r.id === id);
      if (!found) throw new Error(`record not found: ${id}`);
      return found;
    }),
    create: jest.fn(async (fn?: (r: any) => void) => {
      const rec = makeRecord();
      fn?.(rec);
      state.rows.push(rec);
      return rec;
    }),
    prepareCreate: jest.fn((fn?: (r: any) => void) => {
      const rec = makeRecord();
      fn?.(rec);
      return rec;
    }),
    get _rows() {
      return state.rows;
    },
    _setRows: (next: any[]) => {
      state.rows = next;
    },
  };
  return col as FakeCollection;
}

/**
 * Build the `{ __esModule, default }` shape to return from
 * `jest.mock('@/lib/database/index', ...)`. Collections are created lazily on
 * first `get(table)` and remembered, so a service's import-time
 * `database.get('x')` and a test's later `db._setRows('x', ...)` share one
 * stable collection.
 */
export function makeDatabaseMock(): { __esModule: true; default: MockDatabase } {
  const collections: Record<string, FakeCollection> = {};
  const get = jest.fn((table: string) => {
    if (!collections[table]) collections[table] = makeCollection([]);
    return collections[table];
  });
  const db: MockDatabase = {
    get,
    collections: { get },
    write: jest.fn(async (fn: () => any) => fn()),
    batch: jest.fn(async (...ops: any[]) => ops.flat()),
    _collections: collections,
    _setRows(table: string, rows: any[]) {
      if (!collections[table]) collections[table] = makeCollection(rows);
      else collections[table]._setRows(rows);
    },
  };
  return { __esModule: true, default: db };
}
