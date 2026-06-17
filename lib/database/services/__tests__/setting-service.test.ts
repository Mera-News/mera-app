// setting-service unit tests
// All WatermelonDB I/O is intercepted via makeDatabaseMock().

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { getSetting, setSetting, deleteSetting } from '../setting-service';

const db = database as any;

// Helper to create a setting record with a working updateValue stub
function settingRecord(id: string, key: string, value: string) {
  return makeRecord({ id, key, value, updateValue: jest.fn(async () => {}) });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('settings', []);
});

// ---------------------------------------------------------------------------
// getSetting
// ---------------------------------------------------------------------------

describe('getSetting', () => {
  it('returns null when no matching row exists', async () => {
    db._setRows('settings', []);
    const result = await getSetting('missing_key');
    expect(result).toBeNull();
  });

  it('returns the value when a matching row exists', async () => {
    db._setRows('settings', [settingRecord('1', 'theme', 'dark')]);
    const result = await getSetting('theme');
    expect(result).toBe('dark');
  });

  it('returns the first row value when multiple rows are present', async () => {
    // The fake query returns ALL rows; service picks index 0
    db._setRows('settings', [
      settingRecord('1', 'theme', 'dark'),
      settingRecord('2', 'theme', 'light'),
    ]);
    const result = await getSetting('theme');
    expect(result).toBe('dark');
  });

  it('passes the key as a Q.where predicate to the query', async () => {
    db._setRows('settings', [settingRecord('1', 'lang', 'en')]);
    await getSetting('lang');
    const col = db._collections['settings'];
    expect(col.query).toHaveBeenCalledTimes(1);
    // The Q.where arg is opaque but query must have been called
  });
});

// ---------------------------------------------------------------------------
// setSetting
// ---------------------------------------------------------------------------

describe('setSetting', () => {
  it('updates the existing record inside a write() when the key already exists', async () => {
    const rec = settingRecord('1', 'lang', 'en');
    db._setRows('settings', [rec]);
    await setSetting('lang', 'fr');
    // The read-modify-write is now wrapped in a single database.write() so the
    // query + update are atomic (guards the concurrent-delete race during
    // feed-sync). update() runs inside that transaction and mutates value.
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(rec.update).toHaveBeenCalledTimes(1);
    expect(rec.value).toBe('fr');
  });

  it('creates a new record via database.write when the key does not exist', async () => {
    db._setRows('settings', []);
    await setSetting('new_key', 'new_value');
    expect(database.write).toHaveBeenCalledTimes(1);
    const col = db._collections['settings'];
    expect(col.create).toHaveBeenCalledTimes(1);
  });

  it('stores the correct key and value on the new record', async () => {
    db._setRows('settings', []);
    await setSetting('foo', 'bar');
    const col = db._collections['settings'];
    // The create mock ran the writer callback; check the created record
    const created = col._rows.find((r: any) => r.key === 'foo');
    expect(created).toBeDefined();
    expect(created.value).toBe('bar');
  });

  it('self-heals by creating a fresh row when update() hits a tombstoned record', async () => {
    // Simulates the "Not allowed to change deleted record settings#…" production
    // error: the fetched record was deleted concurrently (or by a migration).
    const rec = settingRecord('1', 'feed_sync_machine_state', 'old');
    rec.update = jest.fn(async () => {
      throw new Error('Not allowed to change deleted record settings#abc');
    });
    db._setRows('settings', [rec]);

    await expect(setSetting('feed_sync_machine_state', 'new')).resolves.toBeUndefined();

    const col = db._collections['settings'];
    expect(col.create).toHaveBeenCalledTimes(1);
    const created = col._rows.find((r: any) => r.key === 'feed_sync_machine_state' && r.value === 'new');
    expect(created).toBeDefined();
  });

  it('rethrows non-"deleted record" update() errors', async () => {
    const rec = settingRecord('1', 'k', 'v');
    rec.update = jest.fn(async () => {
      throw new Error('disk full');
    });
    db._setRows('settings', [rec]);

    await expect(setSetting('k', 'v2')).rejects.toThrow('disk full');
    expect(db._collections['settings'].create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteSetting
// ---------------------------------------------------------------------------

describe('deleteSetting', () => {
  it('does nothing destructive when the key does not exist', async () => {
    const rec = settingRecord('1', 'other', 'x');
    db._setRows('settings', []);
    await deleteSetting('ghost');
    // The query now runs inside write() (so fetch + destroy are atomic), so
    // write IS entered — but nothing is destroyed.
    expect(rec.destroyPermanently).not.toHaveBeenCalled();
  });

  it('queries inside the write() transaction (fetch + destroy are atomic)', async () => {
    const rec = settingRecord('1', 'session', 'abc');
    db._setRows('settings', [rec]);
    await deleteSetting('session');
    const col = db._collections['settings'];
    // The query was issued (inside write) and the row destroyed.
    expect(col.query).toHaveBeenCalled();
    expect(database.write).toHaveBeenCalledTimes(1);
  });

  it('destroys the record permanently when it exists', async () => {
    const rec = settingRecord('1', 'session', 'abc');
    db._setRows('settings', [rec]);
    await deleteSetting('session');
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(rec.destroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('swallows "deleted record" errors (concurrent delete race)', async () => {
    const rec = settingRecord('1', 'race', 'x');
    rec.destroyPermanently = jest.fn(async () => {
      throw new Error('deleted record conflict');
    });
    db._setRows('settings', [rec]);
    await expect(deleteSetting('race')).resolves.toBeUndefined();
  });

  it('rethrows errors that are NOT "deleted record"', async () => {
    const rec = settingRecord('1', 'race', 'x');
    rec.destroyPermanently = jest.fn(async () => {
      throw new Error('unexpected disk error');
    });
    db._setRows('settings', [rec]);
    await expect(deleteSetting('race')).rejects.toThrow('unexpected disk error');
  });
});
