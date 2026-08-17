// The `RowSink` port over WatermelonDB.
//
// Three things here are load-bearing and none of them are obvious.
//
// 1. **`sanitizedRaw` rather than `Object.assign(record._raw, row)`.** The rows
//    come out of a file, and a file is not a trusted type system. `sanitizedRaw`
//    coerces every column to the type `schema.ts` declares and fills a default
//    for anything absent, so a string where the schema wants a number becomes a
//    number instead of poisoning every later read of that column. Assigning
//    into `_raw` directly skips exactly that.
//
// 2. **`id` is carried, `_status` and `_changed` are not.** The row id is
//    load-bearing across tables — `article_suggestions` seeds it from the server
//    `_id` and `messages.conversation_id` points at `conversations.id` — so a
//    restore that regenerates ids silently severs every relationship. The sync
//    columns are reset to a fresh `created` state, which is correct for a device
//    that has never synced these rows.
//
// 3. **`settings` is upserted by key and never cleared.** Wiping the table
//    would take `cached_user_id`, `needs_reauth` and the PIN preference with it.
//    Those belong to the device the restore is landing ON.
//
// Importing `@/lib/database` constructs the SQLite adapter at module
// evaluation, so this file is native-coupled and the backup core never imports
// it.

import { Q } from '@nozbe/watermelondb';
import type Model from '@nozbe/watermelondb/Model';
import { sanitizedRaw } from '@nozbe/watermelondb/RawRecord';

import database from '@/lib/database';
import type Setting from '@/lib/database/models/Setting';
import { deleteSetting, setSetting } from '@/lib/database/services/setting-service';

import type { RowSink } from '../import';
import { RESTORE_IN_PROGRESS_KEY } from '../types';

function collection(table: string) {
  return database.get<Model>(table as Parameters<typeof database.get>[0]);
}

export const watermelonRowSink: RowSink = {
  async beginRestore(): Promise<void> {
    await setSetting(RESTORE_IN_PROGRESS_KEY, String(Date.now()));
  },

  async clearTables(tables: readonly string[]): Promise<void> {
    // One write block per table rather than one for all of them: a single
    // transaction spanning 20 `destroyAllPermanently` calls holds the write
    // lock for the whole sweep, and the restore is already non-atomic by
    // construction, so there is nothing to buy by making this half atomic.
    for (const table of tables) {
      await database.write(async () => {
        await collection(table).query().destroyAllPermanently();
      }, `backup-restore-clear-${table}`);
    }
  },

  async createRows(table: string, rows: readonly Record<string, unknown>[]): Promise<void> {
    const col = collection(table);
    await database.write(async () => {
      const prepared = rows.map((row) =>
        col.prepareCreate((record) => {
          record._raw = sanitizedRaw(
            { ...row, _status: 'created', _changed: '' },
            col.schema,
          );
        }),
      );
      await database.batch(...prepared);
    }, `backup-restore-write-${table}`);
  },

  async upsertSettings(entries: readonly { key: string; value: unknown }[]): Promise<void> {
    for (const entry of entries) {
      // A null or undefined value means "this preference was absent on the
      // source device", which is not the same as "set it to the string
      // 'null'" — a settings row's absence IS its default everywhere in this
      // app, so the faithful restore of an absent value is a delete.
      if (entry.value === null || entry.value === undefined) {
        await deleteSetting(entry.key);
      } else {
        await setSetting(entry.key, String(entry.value));
      }
    }
  },

  async finishRestore(): Promise<void> {
    await deleteSetting(RESTORE_IN_PROGRESS_KEY);
  },

  async abortRestore(): Promise<void> {
    // Deliberately does NOT clear the marker. A restore that failed part way
    // through HAS torn the local data, and the next launch has to be able to
    // tell — clearing it here would hide exactly the state the marker exists
    // to record.
  },
};

/** True when a previous restore never reached `finishRestore`. */
export async function restoreWasInterrupted(): Promise<boolean> {
  const rows = await database
    .get<Setting>('settings')
    .query(Q.where('key', RESTORE_IN_PROGRESS_KEY))
    .fetch();
  return rows.length > 0;
}
