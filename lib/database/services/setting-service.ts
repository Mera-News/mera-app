import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type Setting from '../models/Setting';

const settings = database.get<Setting>('settings');

export async function getSetting(key: string): Promise<string | null> {
  const results = await settings.query(Q.where('key', key)).fetch();
  return results.length > 0 ? results[0].value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const existing = await settings.query(Q.where('key', key)).fetch();

  if (existing.length > 0) {
    await existing[0].updateValue(value);
  } else {
    await database.write(async () => {
      await settings.create((record) => {
        record.key = key;
        record.value = value;
      });
    });
  }
}

export async function deleteSetting(key: string): Promise<void> {
  const existing = await settings.query(Q.where('key', key)).fetch();
  if (existing.length === 0) return;
  try {
    await database.write(async () => {
      await existing[0].destroyPermanently();
    });
  } catch (err) {
    // Row was concurrently deleted between the query and this write — the goal
    // (row absent) is already achieved, so treat as success.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('deleted record')) throw err;
  }
}
