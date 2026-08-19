// The `RowSource` port over WatermelonDB.
//
// `unsafeFetchRaw()` returns the raw column objects rather than hydrated Model
// instances, which is what the exporter wants: it is about to JSON-serialise
// them, and hydrating 70k models to read their fields back out would be pure
// cost. "Unsafe" here means "you get untyped raws", not "this bypasses the
// database".
//
// Importing `@/lib/database` CONSTRUCTS the SQLite adapter at module evaluation
// (`lib/database/index.ts:32`), so this file is native-coupled and the backup
// core never imports it.

import { Q } from '@nozbe/watermelondb';
import type Model from '@nozbe/watermelondb/Model';

import database from '@/lib/database';

import type { RowPageQuery, RowSource } from '../export';

function collection(table: string) {
  return database.get<Model>(table as Parameters<typeof database.get>[0]);
}

export const watermelonRowSource: RowSource = {
  /**
   * `database.read()` guarantees no Writer runs for the duration, which is what
   * makes the whole export one consistent snapshot. Reads from other callers
   * still proceed; only writes queue behind it.
   */
  snapshot<T>(work: () => Promise<T>): Promise<T> {
    return database.read(() => work(), 'backup-export-snapshot');
  },

  async page(query: RowPageQuery): Promise<readonly Record<string, unknown>[]> {
    const clauses = [
      ...query.orderBy.map((o) => Q.sortBy(o.column, o.desc ? Q.desc : Q.asc)),
      Q.skip(query.offset),
      Q.take(query.limit),
    ];
    const raws = await collection(query.table).query(...clauses).unsafeFetchRaw();
    return raws as Record<string, unknown>[];
  },

  count(table: string): Promise<number> {
    return collection(table).query().fetchCount();
  },
};
