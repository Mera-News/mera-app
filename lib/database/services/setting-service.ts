import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type Setting from '../models/Setting';

const settings = database.get<Setting>('settings');

export async function getSetting(key: string): Promise<string | null> {
  const results = await settings.query(Q.where('key', key)).fetch();
  return results.length > 0 ? results[0].value : null;
}

/**
 * Every setting whose key starts with `prefix`, as a `{ key: value }` map.
 *
 * Exists so a family of per-instance settings (one row per headline scope, say)
 * can be read in ONE query instead of N `getSetting` calls whose key set the
 * caller would first have to know. Callers that need "all overrides" cannot
 * enumerate keys up front — absence is the default, so the rows that exist ARE
 * the answer.
 */
export async function getSettingsByPrefix(
  prefix: string,
): Promise<Record<string, string>> {
  const results = await settings
    .query(Q.where('key', Q.like(`${Q.sanitizeLikeString(prefix)}%`)))
    .fetch();
  const out: Record<string, string> = {};
  for (const record of results) out[record.key] = record.value;
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  // Read-modify-write must happen inside a single write() so the query and the
  // mutation share one transaction. WatermelonDB serializes writes, so this
  // makes the check-then-update atomic — a concurrent deleteSetting() for the
  // same key (common during feed-sync) can no longer tombstone the row between
  // the fetch and the update, which previously threw "Not allowed to change
  // deleted record settings#…".
  await database.write(async () => {
    const existing = await settings.query(Q.where('key', key)).fetch();

    if (existing.length > 0) {
      try {
        await existing[0].update((record) => {
          record.value = value;
        });
      } catch (err) {
        // The fetched record was tombstoned by a concurrent delete (or a
        // migration's direct `DELETE FROM settings`) — WatermelonDB throws
        // "Not allowed to change deleted record settings#…". Self-heal by
        // writing a fresh row instead of surfacing the error. Recoverable, so
        // no Sentry report.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('deleted record')) throw err;
        await settings.create((record) => {
          record.key = key;
          record.value = value;
        });
      }
    } else {
      await settings.create((record) => {
        record.key = key;
        record.value = value;
      });
    }
  });
}

export async function deleteSetting(key: string): Promise<void> {
  try {
    await database.write(async () => {
      // Query inside the write() so the fetch + destroy share one transaction —
      // a concurrent writer can't tombstone the row between the two steps.
      const existing = await settings.query(Q.where('key', key)).fetch();
      if (existing.length === 0) return;
      await existing[0].destroyPermanently();
    });
  } catch (err) {
    // Final safety net: if the row was still concurrently deleted, the goal
    // (row absent) is already achieved — treat as success.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('deleted record')) throw err;
  }
}
