// Backup export: a REAL export from the in-memory DB (production row source, real codec, real
// deflate), decoded again independently so the assertions are about what the blob contains.
//
// Replaces lib/backup/__tests__/export.test.ts (all 22 `it`). Not carried over: none dropped. Two
// cases changed shape because the real source is not a double: "reads every table inside exactly
// one reader" is now a write racing the export, and the caps are pinned on the real tables.
import database from '@/lib/database';
import { watermelonRowSource } from '@/lib/backup/adapters/watermelon-row-source';
import { knownColumns } from '@/lib/backup/backup-service';
import {
  BACKUP_SETTING_KEYS,
  BACKUP_TABLES,
  EXCLUDED_TABLES,
  FORBIDDEN_SETTING_KEYS,
  TABLE_ROW_CAPS,
} from '@/lib/backup/allowlist';
import {
  BACKUP_MAX_PLAINTEXT_BYTES,
  BackupExportError,
  SECTION_ROWS_KEY,
  SECTION_TABLE_KEY,
  orderForTable,
} from '@/lib/backup/export';
import { BACKUP_MAX_BYTES } from '@/lib/backup/types';
import appSchema from '@/lib/database/schema';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

import {
  CARRIED_SETTINGS,
  DEVICE_SETTINGS,
  bulkCreate,
  decode,
  exportDevice,
  highEntropyText,
  importInto,
  landSuggestion,
  rawRows,
  seedDevice,
  sectionRows,
} from './support';

const SAVED_CAP = TABLE_ROW_CAPS.saved_article_suggestions;
const VISITS_CAP = TABLE_ROW_CAPS.publication_visits;

/** A raw `saved_article_suggestions` row. */
function savedRow(id: string, savedAt: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    article_id: id,
    cluster_memberships_json: '[]',
    relevance: 0.5,
    title_en: `Headline ${id}`,
    article_url: `https://example.com/${id}`,
    origin: null,
    created_at: savedAt,
    saved_at: savedAt,
    ...over,
  };
}

describe('what a seeded device exports', () => {
  it('writes every backed-up table as a section in allowlist order, parents first', async () => {
    await seedDevice();
    const { blob } = await exportDevice();
    const { sections } = await decode(blob);

    expect(sections.map((s) => s.table)).toEqual([...BACKUP_TABLES]);
    const at = (t: string) => sections.findIndex((s) => s.table === t);
    // The importer seeds _raw.id, so a child written before its parent is a dangling read.
    expect(at('facts')).toBeLessThan(at('topics'));
    expect(at('topics')).toBeLessThan(at('tracked_stories'));
  });

  it('carries the persona the services wrote and none of the tables that regenerate', async () => {
    await seedDevice();
    await landSuggestion('art-feed-only');
    const decoded = await decode((await exportDevice()).blob);
    const count = (t: string) => sectionRows(decoded, t).length;

    expect(count('facts')).toBe(2);
    expect(count('topics')).toBe(3);
    expect(count('locations')).toBe(1);
    expect(count('publication_preferences')).toBe(1);
    // the save and the fact-check retention row share one table
    expect(count('saved_article_suggestions')).toBe(2);
    expect(count('tracked_stories')).toBe(1);
    expect(count('publication_visits')).toBe(1);

    // article_suggestions has a row (the feed landed it) and is still not in the blob
    expect((await rawRows('article_suggestions')).length).toBeGreaterThan(0);
    const names = decoded.sections.map((s) => s.table);
    for (const excluded of Object.keys(EXCLUDED_TABLES)) expect(names).not.toContain(excluded);
  });

  it('round-trips row values exactly and keeps `id` while dropping the sync columns', async () => {
    await seedDevice();
    const written = sectionRows(await decode((await exportDevice()).blob), 'facts');
    const stored = await rawRows('facts');

    expect(written).toHaveLength(stored.length);
    for (const row of stored) {
      const { _status, _changed, ...expected } = row;
      expect(written.find((w) => w.id === row.id)).toEqual(expected);
    }
    for (const row of written) {
      expect(row.id).toEqual(expect.any(String));
      expect(row).not.toHaveProperty('_status');
      expect(row).not.toHaveProperty('_changed');
    }
  });

  it('derives its columns from the live schema, so a column added to a table needs no backup change', async () => {
    await seedDevice();
    const decoded = await decode((await exportDevice()).blob);
    const columns = knownColumns();

    for (const section of decoded.sections) {
      for (const row of section.rows) {
        // every exported key is a live schema column or the id; none is invented.
        // `$loki` is the in-memory adapter's own bookkeeping key, which SQLite rows do not have.
        expect(
          Object.keys(row).filter((k) => k !== 'id' && k !== '$loki' && !columns[section.table].includes(k)),
        ).toEqual([]);
      }
    }
    // and nothing the live schema has is left out of a row
    for (const row of sectionRows(decoded, 'facts')) {
      expect(Object.keys(row).filter((k) => k !== '$loki').sort()).toEqual(['id', ...columns.facts].sort());
    }
  });

  it('produces a readable blob from a completely empty database', async () => {
    const { blob } = await exportDevice();
    const { sections, header } = await decode(blob);
    expect(sections).toHaveLength(BACKUP_TABLES.length);
    expect(sections.every((s) => s.rows.length === 0)).toBe(true);
    expect(header.tables.every((t) => t.rows === 0)).toBe(true);
  });

  it('declares a row count per section that matches the rows that follow', async () => {
    await seedDevice();
    for (const s of (await decode((await exportDevice()).blob)).sections) {
      expect(s.declared).toBe(s.rows.length);
    }
  });
});

describe('settings are allowlisted, never denylisted', () => {
  it('carries allowed keys and the prefix family, and drops forbidden and unknown ones', async () => {
    await seedDevice();
    await setSetting('some_future_key_nobody_opted_in', 'x');
    const { blob, result } = await exportDevice();

    const keys = sectionRows(await decode(blob), 'settings').map((r) => r.key as string);
    expect(keys.sort()).toEqual(Object.keys(CARRIED_SETTINGS).sort());
    for (const forbidden of Object.keys(DEVICE_SETTINGS)) expect(keys).not.toContain(forbidden);
    expect(keys).not.toContain('some_future_key_nobody_opted_in');

    // the filtered total, or the restore UI reports a complete table as partial
    const stat = result.header.tables.find((t) => t.table === 'settings');
    expect(stat).toEqual({ table: 'settings', rows: keys.length, rowsAvailable: keys.length });
  });

  it('never exports an identity or entitlement key, whatever the device holds', async () => {
    for (const key of Object.keys(FORBIDDEN_SETTING_KEYS)) await setSetting(key, 'sentinel');
    for (const key of BACKUP_SETTING_KEYS) await setSetting(key, 'sentinel');

    const keys = sectionRows(await decode((await exportDevice()).blob), 'settings').map((r) => r.key);
    expect(keys).toContain('app_language');
    expect(keys).not.toContain('cached_user_id');
    expect(keys.filter((k) => k in FORBIDDEN_SETTING_KEYS)).toEqual([]);
    expect([...keys].sort()).toEqual([...BACKUP_SETTING_KEYS].sort());
  });
});

describe('the multi-chunk seal (what the codec suite cannot reach)', () => {
  it('flags exactly the last frame across many deflate output chunks, and the importer reads them back', async () => {
    // ~600 KB of text deflate cannot squash, so pako emits well over its 16 KB chunk several times
    const big = highEntropyText(100_000);
    await bulkCreate(
      'saved_article_suggestions',
      Array.from({ length: 6 }, (_, i) => savedRow(`sv${i}`, 1_000 + i, { description_en: `${i}${big}` })),
    );

    const { blob } = await exportDevice();
    const decoded = await decode(blob);
    expect(decoded.frameCount).toBeGreaterThanOrEqual(3);
    expect(sectionRows(decoded, 'saved_article_suggestions')).toHaveLength(6);

    // a missing or early last-frame flag is silent here and fatal on restore
    const restored = await importInto(blob);
    expect(restored.perTable.saved_article_suggestions).toBe(6);
  });

  it('spans more than one scratch read, so paging the plaintext is exercised', async () => {
    const description = highEntropyText(700_000);
    await bulkCreate('saved_article_suggestions', [savedRow('sv1', 1, { description_en: description })]);

    const { blob, result } = await exportDevice();
    // SEAL_READ_BYTES is 256 KB: three passes round the read loop, enough for a bad offset to
    // show up as a corrupt inflate
    expect(Math.ceil(result.header.plaintextBytes / (256 * 1024))).toBeGreaterThanOrEqual(3);
    expect(sectionRows(await decode(blob), 'saved_article_suggestions')[0].description_en).toBe(description);
  });
});

describe('the header describes what was actually written', () => {
  it('reports rows and rowsAvailable per table, the live schema version and the build', async () => {
    await seedDevice();
    const { result } = await exportDevice({ now: 1_755_000_000_000 });

    expect(result.header.tables.find((t) => t.table === 'facts')).toEqual({ table: 'facts', rows: 2, rowsAvailable: 2 });
    expect(result.header.schemaVersion).toBe(appSchema.version);
    expect(result.header.appVersion).toBe('1.3.0');
    expect(result.header.algo).toBe('recovery-code-v1');
    expect(result.header.createdAt).toBe(1_755_000_000_000);
  });

  it('reports plaintextBytes equal to the bytes the sections occupy', async () => {
    await seedDevice();
    const { blob, result } = await exportDevice();
    const { sections } = await decode(blob);
    const rebuilt = sections
      .map((s) =>
        [JSON.stringify({ [SECTION_TABLE_KEY]: s.table, [SECTION_ROWS_KEY]: s.declared })]
          .concat(s.rows.map((r) => JSON.stringify(r)))
          .map((l) => `${l}\n`)
          .join(''),
      )
      .join('');
    expect(result.header.plaintextBytes).toBe(new TextEncoder().encode(rebuilt).length);
  });

  it('carries no identity: no user id, no email, no device name', async () => {
    await seedDevice();
    const { result } = await exportDevice();
    expect(Object.keys(result.header).sort()).toEqual(
      ['algo', 'appVersion', 'createdAt', 'formatVersion', 'plaintextBytes', 'schemaVersion', 'tables'],
    );
    expect(JSON.stringify(result.header)).not.toContain(DEVICE_SETTINGS.cached_user_id);
  });
});

describe('caps keep the newest rows', () => {
  it('orders a capped table by its timestamp descending, id ascending', () => {
    expect(orderForTable('saved_article_suggestions')).toEqual([{ column: 'saved_at', desc: true }, { column: 'id' }]);
    expect(orderForTable('publication_visits')).toEqual([{ column: 'visited_at', desc: true }, { column: 'id' }]);
    expect(orderForTable('facts')).toEqual([{ column: 'id' }]);
  });

  it('truncates saved_article_suggestions to its cap and keeps the newest, not an arbitrary N', async () => {
    // ids ascend while timestamps DESCEND, so an id-ordered export would keep the OLDEST rows
    const extra = 25;
    await bulkCreate(
      'saved_article_suggestions',
      Array.from({ length: SAVED_CAP + extra }, (_, i) =>
        savedRow(`sv${String(i).padStart(6, '0')}`, SAVED_CAP + extra - i),
      ),
    );

    const { blob, result } = await exportDevice();
    expect(result.header.tables.find((t) => t.table === 'saved_article_suggestions')).toEqual({
      table: 'saved_article_suggestions',
      rows: SAVED_CAP,
      rowsAvailable: SAVED_CAP + extra,
    });

    const written = sectionRows(await decode(blob), 'saved_article_suggestions');
    expect(written).toHaveLength(SAVED_CAP);
    const savedAts = written.map((r) => r.saved_at as number);
    expect(Math.max(...savedAts)).toBe(SAVED_CAP + extra);
    expect(Math.min(...savedAts)).toBe(extra + 1);
    expect(new Set(written.map((r) => r.id)).size).toBe(SAVED_CAP);
  }, 120_000);

  it('truncates publication_visits to its cap and keeps the newest', async () => {
    const extra = 30;
    await bulkCreate(
      'publication_visits',
      Array.from({ length: VISITS_CAP + extra }, (_, i) => ({
        id: `pv${String(i).padStart(6, '0')}`,
        publication_name: `Pub ${i % 7}`,
        visited_at: VISITS_CAP + extra - i,
      })),
    );

    const { blob, result } = await exportDevice();
    expect(result.header.tables.find((t) => t.table === 'publication_visits')).toEqual({
      table: 'publication_visits',
      rows: VISITS_CAP,
      rowsAvailable: VISITS_CAP + extra,
    });
    const written = sectionRows(await decode(blob), 'publication_visits');
    expect(Math.min(...written.map((r) => r.visited_at as number))).toBe(extra + 1);
    expect(new Set(written.map((r) => r.id)).size).toBe(VISITS_CAP);
  }, 120_000);

  it('leaves an uncapped table whole, across several pages', async () => {
    await bulkCreate(
      'facts',
      Array.from({ length: 1200 }, (_, i) => ({ id: `f${String(i).padStart(5, '0')}`, statement: `s${i}` })),
    );
    const { blob, result } = await exportDevice();
    expect(result.header.tables.find((t) => t.table === 'facts')).toEqual({ table: 'facts', rows: 1200, rowsAvailable: 1200 });
    expect(new Set(sectionRows(await decode(blob), 'facts').map((r) => r.id)).size).toBe(1200);
  });
});

describe('the snapshot boundary', () => {
  it('reads every table inside one reader, so a write during the export lands after it', async () => {
    await seedDevice();
    await setSetting('app_language', 'de');

    // settings is the last table read. A write issued while the first page is being read must wait
    // for the reader, or the blob would carry the new value.
    const realPage = watermelonRowSource.page.bind(watermelonRowSource);
    let write: Promise<void> | null = null;
    let writeDone = false;
    const spy = jest.spyOn(watermelonRowSource, 'page').mockImplementation(async (query) => {
      if (!write) {
        write = setSetting('app_language', 'fr').then(() => {
          writeDone = true;
        });
        // give the write every chance to run ahead of the reader
        for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
        expect(writeDone).toBe(false);
      }
      return realPage(query);
    });
    try {
      const { blob } = await exportDevice();
      const settings = sectionRows(await decode(blob), 'settings');
      expect(settings.find((r) => r.key === 'app_language')?.value).toBe('de');
    } finally {
      spy.mockRestore();
    }
    await write;
    expect(await getSetting('app_language')).toBe('fr');
  });

  it('takes the snapshot with database.read exactly once', async () => {
    const read = jest.spyOn(database, 'read');
    try {
      await exportDevice();
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(expect.any(Function), 'backup-export-snapshot');
    } finally {
      read.mockRestore();
    }
  });
});

describe('refusals', () => {
  it('refuses rather than truncating when the finished blob exceeds the size cap', async () => {
    // Base64-alphabet text still deflates ~25%, so 40 MB of payload is what clears a 25 MB
    // ciphertext ceiling (30 MB sealed to 22.7 MB, measured).
    // One 1 MB text reused: deflate's window is 32 KB, so repeats a megabyte apart do not shrink.
    const text = highEntropyText(1_000_000);
    await bulkCreate(
      'saved_article_suggestions',
      Array.from({ length: 40 }, (_, i) => savedRow(`s${i}`, i, { description_en: `${i}${text}` })),
    );
    await expect(exportDevice()).rejects.toMatchObject({ name: 'BackupExportError', reason: 'too-large' });
    expect(BACKUP_MAX_BYTES).toBe(25 * 1024 * 1024);
  }, 180_000);

  it('names a plaintext ceiling well above the ciphertext one', () => {
    // A guard against filling the disk, not a product limit. If these invert, the scratch file
    // would be refused before the blob ever could be.
    expect(BACKUP_MAX_PLAINTEXT_BYTES).toBeGreaterThan(BACKUP_MAX_BYTES);
    const err = new BackupExportError('io', 'x');
    expect(err.reason).toBe('io');
    expect(err.name).toBe('BackupExportError');
  });
});
