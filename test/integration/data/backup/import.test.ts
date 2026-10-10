// Backup restore: a REAL export from a seeded device, then a REAL import into the in-memory DB
// through the production row sink, asserting the database state afterwards. Hand-made blobs stand
// in for a build that is not this one and for damaged files.
//
// Replaces lib/backup/__tests__/import.test.ts (all 22 `it`). Not carried over: none dropped.
// Changed shape: the legacy FakeSink recorded calls ("never asks the sink to clear settings"); the
// same facts are now read off the database (the settings rows are still there).
import { watermelonRowSink, restoreWasInterrupted } from '@/lib/backup/adapters/watermelon-row-sink';
import { BACKUP_TABLES, RESTORE_REPLACED_TABLES } from '@/lib/backup/allowlist';
import { BackupImportError, inspectBackup } from '@/lib/backup/import';
import { BACKUP_FORMAT_VERSION, RESTORE_IN_PROGRESS_KEY } from '@/lib/backup/types';
import { deleteFact, addFact } from '@/lib/database/services/fact-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { useStrictClock } from '@/test/helpers';

import {
  CARRIED_SETTINGS,
  KEY,
  OTHER_KEY,
  bulkCreate,
  exportDevice,
  highEntropyText,
  importInto,
  landSuggestion,
  rawRows,
  refusalOf,
  rowCounts,
  sealedByHand,
  section,
  seedDevice,
  settingsMap,
  stat,
} from './support';
import { saveSuggestion } from '@/lib/database/services/saved-article-suggestion-service';

/** The persona tables as a caller can compare them: no sync columns, no adapter bookkeeping. */
async function persona(): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of RESTORE_REPLACED_TABLES) {
    out[table] = (await rawRows(table)).map(({ _status, _changed, $loki, ...row }) => row);
  }
  return out;
}

const T0 = '2026-06-01T10:00:00.000Z';
const T1 = '2026-09-01T10:00:00.000Z';

describe('export -> import round trip on the real database', () => {
  it('puts the persona back exactly as it was, after the device changed in between', async () => {
    useStrictClock(T0);
    await seedDevice();
    const before = await persona();
    const { blob } = await exportDevice();

    // the device moves on: a new fact, a deleted fact, a new save, a changed preference
    jest.setSystemTime(new Date(T1));
    await addFact('I cycle to work');
    await deleteFact((before.facts[0] as { id: string }).id);
    await saveSuggestion(await landSuggestion('art-later'));
    await setSetting('app_language', 'fr');
    expect(await persona()).not.toEqual(before);

    const result = await importInto(blob);

    expect(await persona()).toEqual(before);
    expect((await settingsMap()).app_language).toBe('de');
    expect(result.rowsRestored).toBe(
      Object.values(before).reduce((n, rows) => n + rows.length, 0) + Object.keys(CARRIED_SETTINGS).length,
    );
    expect(result.perTable).toMatchObject({ facts: 2, topics: 3, saved_article_suggestions: 2, tracked_stories: 1 });
    expect(result.skippedTables).toEqual([]);
    expect(result.fromNewerSchema).toBe(false);
  });

  it('re-inserts rows with their historical timestamps and a fresh `created` status', async () => {
    useStrictClock(T0);
    const seeded = await seedDevice();
    const { blob } = await exportDevice();
    const factBefore = (await rawRows('facts')).find((r) => r.id === seeded.factIds[0])!;
    const savedBefore = (await rawRows('saved_article_suggestions')).find((r) => r.id === seeded.savedId)!;

    jest.setSystemTime(new Date(T1));
    await importInto(blob);

    const fact = (await rawRows('facts')).find((r) => r.id === seeded.factIds[0])!;
    const saved = (await rawRows('saved_article_suggestions')).find((r) => r.id === seeded.savedId)!;
    expect(fact.created_at).toBe(Date.parse(T0));
    expect(fact.created_at).toBe(factBefore.created_at);
    expect(saved.saved_at).toBe(Date.parse(T0));
    expect(saved.saved_at).toBe(savedBefore.saved_at);
    for (const row of [fact, saved]) {
      expect(row._status).toBe('created');
      expect(row._changed).toBe('');
    }
  });

  it('replaces every backed-up table with the blob, so rows the blob lacks are gone', async () => {
    await seedDevice();
    const { blob } = await exportDevice();
    const counts = await rowCounts();

    await bulkCreate('saved_article_suggestions', [
      { id: 'sv-intruder', article_id: 'sv-intruder', saved_at: 5, created_at: 5 },
    ]);
    await importInto(blob);

    expect((await rawRows('saved_article_suggestions')).map((r) => r.id)).not.toContain('sv-intruder');
    const after = await rowCounts();
    for (const table of RESTORE_REPLACED_TABLES) expect(after[table]).toBe(counts[table]);
  });

  it('round-trips an empty backup: the tables are cleared and nothing is written', async () => {
    const { blob } = await exportDevice();
    await seedDevice();
    expect((await rawRows('facts')).length).toBeGreaterThan(0);

    const result = await importInto(blob);

    expect(result.rowsRestored).toBe(0);
    for (const table of RESTORE_REPLACED_TABLES) expect(await rawRows(table)).toEqual([]);
    expect(await restoreWasInterrupted()).toBe(false);
  });

  it('spans many write batches without losing or duplicating a row', async () => {
    // WRITE_BATCH_ROWS is 500: 1,201 rows is two full batches and a tail
    const ids = Array.from({ length: 1201 }, (_, i) => `f${String(i).padStart(5, '0')}`);
    await bulkCreate('facts', ids.map((id, i) => ({ id, statement: `s${i}` })));
    const { blob } = await exportDevice();
    await bulkCreate('facts', [{ id: 'extra', statement: 'x' }]);

    const result = await importInto(blob);

    expect(result.perTable.facts).toBe(1201);
    expect((await rawRows('facts')).map((r) => r.id)).toEqual(ids);
  });

  it('survives a payload large enough to span many frames', async () => {
    // a line split across two frames is only exercised by a payload this size
    const content = highEntropyText(400_000);
    await bulkCreate('saved_article_suggestions', [
      { id: 's1', article_id: 'a1', description_en: content, saved_at: 1, created_at: 1 },
    ]);
    const { blob, result } = await exportDevice();
    expect(result.blobBytes).toBeGreaterThan(300_000);
    await bulkCreate('saved_article_suggestions', [{ id: 's2', article_id: 'a2', saved_at: 2, created_at: 2 }]);

    await importInto(blob);

    const rows = await rawRows('saved_article_suggestions');
    expect(rows.map((r) => r.id)).toEqual(['s1']);
    expect(rows[0].description_en).toBe(content);
  });

  it('reads a last row that has no trailing newline, which the exporter never writes but a hand-made blob can', async () => {
    const blob = await sealedByHand(
      section('facts', [{ id: 'f1', statement: 'a' }, { id: 'f2', statement: 'b' }]).trimEnd(),
      { tables: [stat('facts', 2)] },
    );
    const result = await importInto(blob);
    expect(result.perTable.facts).toBe(2);
    expect((await rawRows('facts')).map((r) => r.id)).toEqual(['f1', 'f2']);
  });

  it('clears the torn-restore marker when it finishes', async () => {
    await seedDevice();
    const { blob } = await exportDevice();
    await importInto(blob);
    expect(await getSetting(RESTORE_IN_PROGRESS_KEY)).toBeNull();
  });
});

describe('settings are upserted by key, never cleared, and re-filtered on the way in', () => {
  it('leaves this device\'s identity and session rows alone while the carried preferences come back', async () => {
    await seedDevice();
    const { blob } = await exportDevice();

    // the device the restore lands ON is a different install with its own identity
    await setSetting('cached_user_id', 'user-on-the-new-device');
    await setSetting('needs_reauth', '0');
    await setSetting('onboarding_done', '0');
    await setSetting('mera_button_corner', 'top-right');
    await setSetting('app_language', 'fr');
    await setSetting('for_you_recent_24h_only', '1');

    await importInto(blob);

    const settings = await settingsMap();
    expect(settings.cached_user_id).toBe('user-on-the-new-device');
    expect(settings.needs_reauth).toBe('0');
    expect(settings.onboarding_done).toBe('0');
    expect(settings.mera_button_corner).toBe('top-right');
    // carried keys take the blob's value ...
    for (const [key, value] of Object.entries(CARRIED_SETTINGS)) expect(settings[key]).toBe(value);
    // ... and a key the blob does not carry is not deleted
    expect(settings.for_you_recent_24h_only).toBe('1');
  });

  it('upserts in place: an existing key keeps its row id', async () => {
    await setSetting('app_language', 'de');
    const { blob } = await exportDevice();
    const before = (await rawRows('settings')).find((r) => r.key === 'app_language')!;
    await setSetting('app_language', 'fr');

    await importInto(blob);

    const rows = (await rawRows('settings')).filter((r) => r.key === 'app_language');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].value).toBe('de');
  });

  it('refuses a forbidden settings key even in a perfectly authenticated blob', async () => {
    // The AEAD proves nobody altered the blob after it was sealed. It proves nothing about the
    // build that sealed it. cached_user_id would make the identity gate wipe the restore.
    await setSetting('cached_user_id', 'user-on-this-device');
    await setSetting('last_known_subscription_tier', 'starter');
    const blob = await sealedByHand(
      section('settings', [
        { id: 's1', key: 'cached_user_id', value: 'someone-else' },
        { id: 's2', key: 'last_known_subscription_tier', value: 'professional' },
        { id: 's3', key: 'onboarding_done', value: '1' },
        { id: 's4', key: 'app_language', value: 'fr' },
      ]),
      { tables: [stat('settings', 4)] },
    );

    const result = await importInto(blob);

    const settings = await settingsMap();
    expect(settings.cached_user_id).toBe('user-on-this-device');
    expect(settings.last_known_subscription_tier).toBe('starter');
    expect(settings).not.toHaveProperty('onboarding_done');
    expect(settings.app_language).toBe('fr');
    expect([...result.refusedSettingKeys].sort()).toEqual([
      'cached_user_id',
      'last_known_subscription_tier',
      'onboarding_done',
    ]);
  });

  it('refuses a key nobody opted in, whatever its name looks like', async () => {
    const blob = await sealedByHand(
      section('settings', [{ id: 's1', key: 'some_future_key_nobody_opted_in', value: 'x' }]),
      { tables: [stat('settings', 1)] },
    );
    const result = await importInto(blob);
    expect(result.refusedSettingKeys).toEqual(['some_future_key_nobody_opted_in']);
    expect(await settingsMap()).not.toHaveProperty('some_future_key_nobody_opted_in');
  });

  it('turns an absent value into an absent row, not the string "null"', async () => {
    await setSetting('app_language', 'de');
    const blob = await sealedByHand(section('settings', [{ id: 's1', key: 'app_language', value: null }]), {
      tables: [stat('settings', 1)],
    });
    await importInto(blob);
    expect(await getSetting('app_language')).toBeNull();
  });

  it('writes the prefix family of a tuned country', async () => {
    const blob = await sealedByHand(section('settings', [{ id: 's1', key: 'headline_depth:FR', value: '2' }]), {
      tables: [stat('settings', 1)],
    });
    await importInto(blob);
    expect(await getSetting('headline_depth:FR')).toBe('2');
  });
});

describe('a restore replaces the persona, whatever the blob declares', () => {
  it('clears every replaced table even when the blob declares only some of them', async () => {
    // Deriving the clear list from header.tables[] would let a partial blob write itself on top of
    // the tables it did not declare, which is a mixed persona. Today's exporter always emits every
    // section, so only a hand-made blob reaches this.
    await seedDevice();
    await setSetting('app_language', 'fr');
    const blob = await sealedByHand(section('facts', [{ id: 'f-only', statement: 'only fact' }]), {
      tables: [stat('facts', 1)],
    });

    await importInto(blob);

    expect((await rawRows('facts')).map((r) => r.id)).toEqual(['f-only']);
    for (const table of RESTORE_REPLACED_TABLES.filter((t) => t !== 'facts')) {
      expect(await rawRows(table)).toEqual([]);
    }
    // settings is not in the replaced set
    expect((await settingsMap()).app_language).toBe('fr');
    expect(BACKUP_TABLES).toContain('settings');
    expect(RESTORE_REPLACED_TABLES).not.toContain('settings');
  });

  it('leaves the tables outside the backup alone', async () => {
    await seedDevice();
    await landSuggestion('art-feed-only');
    const before = (await rawRows('article_suggestions')).length;
    expect(before).toBeGreaterThan(0);

    await importInto((await exportDevice()).blob);

    expect((await rawRows('article_suggestions')).length).toBe(before);
  });
});

describe('schema drift', () => {
  it('drops a column this build does not have, keeps the row, and says so', async () => {
    const blob = await sealedByHand(
      section('facts', [{ id: 'f1', statement: 'a', a_column_from_the_future: 42 }]),
      { schemaVersion: 61 + 100, tables: [stat('facts', 1)] },
    );

    const result = await importInto(blob);

    const [row] = await rawRows('facts');
    expect(row.id).toBe('f1');
    expect(row.statement).toBe('a');
    expect(row).not.toHaveProperty('a_column_from_the_future');
    expect(result.droppedColumns).toEqual({ facts: ['a_column_from_the_future'] });
    expect(result.fromNewerSchema).toBe(true);
  });

  it('skips a table this build does not have rather than throwing', async () => {
    const blob = await sealedByHand(
      `${section('facts', [{ id: 'f1', statement: 'a' }])}${section('a_future_table', [{ id: 'x1' }])}`,
      { tables: [stat('facts', 1), stat('a_future_table', 1)] },
    );

    const result = await importInto(blob);

    expect(result.skippedTables).toEqual(['a_future_table']);
    expect(result.perTable).toEqual({ facts: 1 });
    expect((await rawRows('facts')).map((r) => r.id)).toEqual(['f1']);
  });

  it('needs nothing for an OLDER blob: a column it lacks takes the schema default', async () => {
    const blob = await sealedByHand(section('facts', [{ id: 'f1', statement: 'a' }]), {
      schemaVersion: 40,
      tables: [stat('facts', 1)],
    });

    const result = await importInto(blob);

    expect(result.fromNewerSchema).toBe(false);
    expect(result.droppedColumns).toEqual({});
    const [row] = await rawRows('facts');
    expect(row.statement).toBe('a');
    // every live column exists on the row, defaulted by sanitizedRaw
    expect(row).toHaveProperty('created_at');
    expect(row).toHaveProperty('topics_status');
  });
});

describe('the row sink', () => {
  it('writes the row id it was given and resets the sync columns', async () => {
    await watermelonRowSink.createRows('facts', [
      { id: 'f-given', statement: 'a', _status: 'synced', _changed: 'statement' },
    ]);
    const [row] = await rawRows('facts');
    expect(row.id).toBe('f-given');
    expect(row._status).toBe('created');
    expect(row._changed).toBe('');
  });

  it('coerces a column to the type the schema declares instead of poisoning later reads', async () => {
    await watermelonRowSink.createRows('facts', [{ id: 'f1', statement: 'a', created_at: 'not a number' }]);
    const [row] = await rawRows('facts');
    expect(typeof row.created_at).toBe('number');
  });

  it('marks a restore in progress until it finishes, and an abort leaves the mark', async () => {
    expect(await restoreWasInterrupted()).toBe(false);
    await watermelonRowSink.beginRestore();
    expect(await restoreWasInterrupted()).toBe(true);
    await watermelonRowSink.abortRestore();
    expect(await restoreWasInterrupted()).toBe(true);
    await watermelonRowSink.finishRestore();
    expect(await restoreWasInterrupted()).toBe(false);
  });

  it('clears only the tables it is asked to', async () => {
    await seedDevice();
    await watermelonRowSink.clearTables(['topics']);
    expect(await rawRows('topics')).toEqual([]);
    expect((await rawRows('facts')).length).toBeGreaterThan(0);
  });
});

describe('refusals before anything is touched', () => {
  it('refuses the wrong key and changes nothing', async () => {
    await seedDevice();
    const { blob } = await exportDevice();
    const before = await persona();
    const settings = await settingsMap();

    expect(await refusalOf(() => importInto(blob, { key: OTHER_KEY }))).toBe('wrong-key');

    // beginRestore has not run: nothing is torn
    expect(await persona()).toEqual(before);
    expect(await settingsMap()).toEqual(settings);
    expect(await restoreWasInterrupted()).toBe(false);
  });

  it('refuses a blob from a newer format and changes nothing', async () => {
    await seedDevice();
    const before = await persona();
    const blob = await sealedByHand(section('facts', [{ id: 'f1', statement: 'a' }]), {
      formatVersion: BACKUP_FORMAT_VERSION + 1,
      tables: [stat('facts', 1)],
    });

    expect(await refusalOf(() => importInto(blob))).toBe('format-too-new');

    expect(await persona()).toEqual(before);
    expect(await restoreWasInterrupted()).toBe(false);
  });

  it('refuses a blob whose header was altered after sealing and changes nothing', async () => {
    await seedDevice();
    const { blob } = await exportDevice();
    const before = await persona();
    // flip a byte inside the cleartext header: it is the AAD of every frame
    blob.bytes[4 + 10] ^= 0x01;

    expect(await refusalOf(() => importInto(blob))).toBe('tampered');

    expect(await persona()).toEqual(before);
    expect(await restoreWasInterrupted()).toBe(false);
  });

  it('refuses a file that is too small to hold a header', async () => {
    const blob = await sealedByHand('x');
    blob.bytes = blob.bytes.slice(0, 2);
    expect(await refusalOf(() => importInto(blob))).toBe('incomplete');
  });
});

describe('refusals after the restore began', () => {
  /** Each leaves the torn-restore marker set and never reaches finishRestore. */
  async function expectTornRefusal(blob: Awaited<ReturnType<typeof sealedByHand>>, reason: string) {
    expect(await refusalOf(() => importInto(blob))).toBe(reason);
    expect(await restoreWasInterrupted()).toBe(true);
  }

  it('refuses a row with no id, which would break every reference to it', async () => {
    await expectTornRefusal(
      await sealedByHand(section('facts', [{ statement: 'orphan' }]), { tables: [stat('facts', 1)] }),
      'tampered',
    );
  });

  it('refuses a section whose declared count disagrees with its rows', async () => {
    const body = `${JSON.stringify({ __t: 'facts', __n: 5 })}\n${JSON.stringify({ id: 'f1', statement: 'a' })}\n`;
    await expectTornRefusal(await sealedByHand(body, { tables: [stat('facts', 5)] }), 'tampered');
  });

  it('refuses a row that arrives before any section marker', async () => {
    await expectTornRefusal(await sealedByHand(`${JSON.stringify({ id: 'f1' })}\n`), 'tampered');
  });

  it('refuses a line that is not JSON', async () => {
    await expectTornRefusal(await sealedByHand('this is not json\n'), 'tampered');
  });

  it('refuses a deflate stream cut short, which authenticates perfectly', async () => {
    // Every byte present is genuine and the tag verifies, so the AEAD waves it through. pako reports
    // a truncated stream by producing LESS OUTPUT, so only header.plaintextBytes catches it.
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: `f${i}`, statement: `s${i}` }));
    await expectTornRefusal(
      await sealedByHand(section('facts', rows), {}, { truncateDeflate: true }),
      'incomplete',
    );
  });

  it('refuses a frame that authenticates but is not a deflate stream', async () => {
    await expectTornRefusal(
      await sealedByHand(section('facts', []), {}, { rawPayload: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]) }),
      'tampered',
    );
  });

  it('leaves the marker set when a write fails part way', async () => {
    await seedDevice();
    const { blob } = await exportDevice();
    const spy = jest.spyOn(watermelonRowSink, 'createRows').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(importInto(blob)).rejects.toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
    // abort, never finish: the restore HAS torn the data and the next launch has to be able to tell
    expect(await restoreWasInterrupted()).toBe(true);
  });

  it('DA38 today: a blob refused mid-stream has already cleared the persona it was meant to replace', async () => {
    // The clear runs before the first row is parsed, and nothing re-creates the old rows. The
    // torn-restore marker is set, but nothing reads it (lib/backup/lifecycle.ts has no caller and is
    // deleted in P4), so the reader opens the app to an empty persona.
    await seedDevice();
    expect((await rawRows('facts')).length).toBeGreaterThan(0);

    const blob = await sealedByHand('this is not json\n');
    await refusalOf(() => importInto(blob));

    expect(await rawRows('facts')).toEqual([]);
    expect(await rawRows('topics')).toEqual([]);
    expect(await restoreWasInterrupted()).toBe(true);
  });

  test.failing('DA38: a blob refused mid-stream leaves the persona it was meant to replace', async () => {
    // A restore that fails validation should change nothing; the clear must wait until the blob
    // has been read through, or the reader is left with neither persona.
    await seedDevice();
    const factsBefore = (await rawRows('facts')).length;
    const topicsBefore = (await rawRows('topics')).length;
    const blob = await sealedByHand('this is not json\n');

    await refusalOf(() => importInto(blob));

    expect((await rawRows('facts')).length).toBe(factsBefore);
    expect((await rawRows('topics')).length).toBe(topicsBefore);
  });
});

describe('a blob naming tables outside the backup set', () => {
  const jobRow = { id: 'job1', task_name: 'feed-sync', status: 'pending' };

  it('DA33: refuses the rows of a table the backup never carries, as it does for a forbidden setting', async () => {
    // allowlist.ts: EXCLUDED_TABLES are device-scoped or regenerable, and "a stale scheduler job
    // is actively harmful on the receiving device". The settings table is re-filtered on import
    // for exactly this reason; the other tables are not.
    const blob = await sealedByHand(
      `${section('facts', [{ id: 'f1', statement: 'a' }])}${section('scheduler_jobs', [jobRow])}`,
      { tables: [stat('facts', 1), stat('scheduler_jobs', 1)] },
    );

    await importInto(blob);

    expect(await rawRows('scheduler_jobs')).toEqual([]);
  });
});

describe('inspectBackup', () => {
  it('returns the header for a restore preview', async () => {
    await seedDevice();
    const { blob } = await exportDevice({ now: 1_755_000_000_000 });
    const header = await inspectBackup(KEY, blob);
    expect(header.createdAt).toBe(1_755_000_000_000);
    expect(header.tables.find((t) => t.table === 'facts')?.rows).toBe(2);
  });

  it('returns a header under any key, because the header is cleartext: it is a preview, never an authorisation', async () => {
    const { blob } = await exportDevice();
    const header = await inspectBackup(OTHER_KEY, blob);
    expect(header.formatVersion).toBe(BACKUP_FORMAT_VERSION);
  });
});

describe('BackupImportError', () => {
  it('exposes a reason on every refusal it raises itself', () => {
    const err = new BackupImportError('incomplete', 'x');
    expect(err.reason).toBe('incomplete');
    expect(err.name).toBe('BackupImportError');
  });
});
