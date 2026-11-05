// readLocalDataSizes on a real SQLite file, through the real SQLiteAdapter, Query and encodeQuery.
// Only the driver differs from a phone: WatermelonDB's node driver wants better-sqlite3, which the
// app does not install, so node:sqlite stands in. Everything from `unsafeFetchRaw` down to the
// SQLite pager is real, in WAL mode as on a phone.
//
// shortcut: node:sqlite needs Node 22.5 and CI runs 20, so this suite skips there. Add better-sqlite3 as a dev dependency if CI should run it.
import { Q } from '@nozbe/watermelondb';
import fs from 'node:fs';
import path from 'node:path';

import database from '@/lib/database';
import { readLocalDataSizes } from '@/lib/database/local-data-size';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('expo-file-system/legacy', () => ({ getFreeDiskStorageAsync: async () => 1 }));

// Mock factories run before this file's consts: the live handle travels on globalThis.
type Handle = { exec: (sql: string) => void; prepare: (sql: string) => { get: () => unknown } };
const scope = globalThis as unknown as { mockSqliteHandle: Handle };

/** What the node driver calls on a better-sqlite3 handle. */
jest.mock(
  'better-sqlite3',
  () =>
    class {
      open = true;
      memory = false;
      private readonly db: InstanceType<typeof import('node:sqlite').DatabaseSync>;
      constructor(file: string) {
        const { DatabaseSync } = jest.requireActual('node:sqlite') as typeof import('node:sqlite');
        this.db = new DatabaseSync(file);
        this.db.exec('pragma journal_mode = WAL');
        (globalThis as unknown as { mockSqliteHandle: unknown }).mockSqliteHandle = this.db;
      }
      prepare(sql: string) {
        const statement = this.db.prepare(sql);
        return {
          run: (args: never[] = []) => statement.run(...args),
          get: (args: never[] = []) => statement.get(...args),
          all: (args: never[] = []) => statement.all(...args),
        };
      }
      exec(sql: string) {
        this.db.exec(sql);
      }
      transaction(block: () => void) {
        return () => {
          this.db.exec('begin');
          try {
            block();
            this.db.exec('commit');
          } catch (error) {
            this.db.exec('rollback');
            throw error;
          }
        };
      }
      close() {
        this.db.close();
        this.open = false;
      }
      pragma(sql: string, options?: { simple?: boolean }) {
        const row = this.db.prepare(`pragma ${sql}`).get() as Record<string, unknown> | undefined;
        return options?.simple && row ? Object.values(row)[0] : row;
      }
    },
  { virtual: true },
);

jest.mock('@nozbe/watermelondb/adapters/sqlite/makeDispatcher', () =>
  jest.requireActual(require.resolve('@nozbe/watermelondb/adapters/sqlite/makeDispatcher/index.js')),
);

jest.mock('@/lib/database/index', () => {
  const { Database } = jest.requireActual('@nozbe/watermelondb') as typeof import('@nozbe/watermelondb');
  const SQLiteAdapter = jest.requireActual('@nozbe/watermelondb/adapters/sqlite').default;
  const { default: schema } = require('@/lib/database/schema');
  const { default: Setting } = require('@/lib/database/models/Setting');
  const nodeFs = jest.requireActual('node:fs') as typeof import('node:fs');
  const nodeOs = jest.requireActual('node:os') as typeof import('node:os');
  const nodePath = jest.requireActual('node:path') as typeof import('node:path');
  const dbPath = nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mera-size-')), 'watermelon.db');
  return {
    __esModule: true,
    dbPath,
    default: new Database({ adapter: new SQLiteAdapter({ schema, dbName: dbPath, jsi: false }), modelClasses: [Setting] }),
  };
});

const hasNodeSqlite = (() => {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const ROWS = 2_000;
const ROW_BYTES = 4_000;
const settings = () => database.get('settings');

const insertRows = () =>
  database.write(async () => {
    await database.batch(
      Array.from({ length: ROWS }, (_, i) =>
        settings().prepareCreate((row) => {
          Object.assign(row, { key: `k${i}`, value: 'x'.repeat(ROW_BYTES) });
        }),
      ),
    );
  });

const deleteRows = () =>
  database.write(async () => {
    const rows = await settings().query().fetch();
    await database.batch(rows.map((row) => row.prepareDestroyPermanently()));
  });

const raw = async (name: string): Promise<number> => {
  const rows = (await settings().query(Q.unsafeSqlQuery(`pragma ${name}`)).unsafeFetchRaw()) as Record<string, number>[];
  return rows[0][name];
};
const bytes = async () => (await readLocalDataSizes())?.databaseBytes as number;
const { dbPath } = jest.requireMock('@/lib/database/index') as { dbPath: string };
const fileBytes = () => fs.statSync(dbPath).size;
const checkpoint = () => scope.mockSqliteHandle.prepare('pragma wal_checkpoint(TRUNCATE)').get();

(hasNodeSqlite ? describe : describe.skip)('readLocalDataSizes on real SQLite', () => {
  afterAll(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));

  it('every pragma returns one numeric row through unsafeFetchRaw, with no table in the SQL', async () => {
    for (const name of ['page_count', 'freelist_count', 'page_size']) {
      expect(await raw(name)).toEqual(expect.any(Number));
    }
    expect(await raw('page_size')).toBeGreaterThan(0);
  });

  it('page_count times page_size is the file once checkpointed, so the sum is the real size', async () => {
    await insertRows();
    checkpoint();

    const sizes = await readLocalDataSizes();
    expect((await raw('page_count')) * (await raw('page_size'))).toBe(fileBytes());
    expect(sizes?.databaseBytes).toBe(((await raw('page_count')) - (await raw('freelist_count'))) * (await raw('page_size')));
  });

  it('falls when rows are deleted, while the file does not shrink', async () => {
    await insertRows();
    checkpoint();
    const before = await bytes();
    const fileBefore = fileBytes();

    await deleteRows();
    checkpoint();

    const after = await bytes();
    expect(await raw('freelist_count')).toBeGreaterThan(0);
    expect(before - after).toBeGreaterThanOrEqual(ROWS * ROW_BYTES);
    expect(fileBytes()).toBe(fileBefore);
    expect(after).toBeLessThan(fileBytes());
  });

  it('counts rows still only in the WAL', async () => {
    checkpoint();
    scope.mockSqliteHandle.exec('pragma wal_autocheckpoint = 0');
    const fileBefore = fileBytes();
    const before = await bytes();

    await insertRows();

    expect(fileBytes()).toBe(fileBefore);
    expect((await bytes()) - before).toBeGreaterThanOrEqual(ROWS * ROW_BYTES);
  });
});
