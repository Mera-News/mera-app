// The importer, driven through the real codec — including a full
// export → import round trip, which is the only test that proves the two files
// agree about the NDJSON section format rather than each being self-consistent.
//
// The rest are refusals. An importer that accepts a malformed blob writes
// wrong data into a database the user cannot then un-restore, so every one of
// these asserts a THROW plus the fact that `finishRestore` never ran.

import pako from 'pako';

import { BACKUP_TABLES } from '../allowlist';
import { BlobWriter, openBlob } from '../blob';
import {
  SECTION_ROWS_KEY,
  SECTION_TABLE_KEY,
  exportBackup,
  type RowPageQuery,
  type RowSource,
} from '../export';
import {
  BackupImportError,
  importBackup,
  inspectBackup,
  type ImportResult,
  type RowSink,
} from '../import';
import { BACKUP_FORMAT_VERSION, type BackupHeader } from '../types';
import { MemoryFile } from './memory-file';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/** Every column the fixtures use, per table. Stands in for the live appSchema. */
const KNOWN_COLUMNS: Record<string, readonly string[]> = Object.fromEntries(
  BACKUP_TABLES.filter((t) => t !== 'settings').map((t) => [
    t,
    [
      'statement',
      'weight',
      'created_at',
      'fact_id',
      'text',
      'topic_id',
      'llm_headline',
      'article_id',
      'saved_at',
      'description_en',
      'visited_at',
    ],
  ]),
);

class FakeSink implements RowSink {
  readonly events: string[] = [];
  readonly tables: Record<string, Record<string, unknown>[]> = {};
  readonly settings: Record<string, unknown> = {};
  cleared: readonly string[] = [];
  createCalls = 0;
  /** Set to make `createRows` blow up, for the abort path. */
  failOnTable?: string;

  beginRestore(): Promise<void> {
    this.events.push('begin');
    return Promise.resolve();
  }

  clearTables(tables: readonly string[]): Promise<void> {
    this.events.push('clear');
    this.cleared = tables;
    return Promise.resolve();
  }

  createRows(table: string, rows: readonly Record<string, unknown>[]): Promise<void> {
    if (table === this.failOnTable) return Promise.reject(new Error('disk full'));
    this.createCalls += 1;
    (this.tables[table] ??= []).push(...rows);
    return Promise.resolve();
  }

  upsertSettings(entries: readonly { key: string; value: unknown }[]): Promise<void> {
    this.events.push('upsertSettings');
    for (const e of entries) this.settings[e.key] = e.value;
    return Promise.resolve();
  }

  finishRestore(): Promise<void> {
    this.events.push('finish');
    return Promise.resolve();
  }

  abortRestore(): Promise<void> {
    this.events.push('abort');
    return Promise.resolve();
  }
}

// ---- fixtures -------------------------------------------------------------

class FakeRowSource implements RowSource {
  constructor(private readonly data: Record<string, Record<string, unknown>[]>) {}
  snapshot<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
  page(query: RowPageQuery): Promise<readonly Record<string, unknown>[]> {
    const rows = [...(this.data[query.table] ?? [])];
    rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return Promise.resolve(rows.slice(query.offset, query.offset + query.limit));
  }
  count(table: string): Promise<number> {
    return Promise.resolve((this.data[table] ?? []).length);
  }
}

async function sealedByExporter(
  data: Record<string, Record<string, unknown>[]>,
): Promise<MemoryFile> {
  const blob = new MemoryFile();
  await exportBackup({
    key: KEY,
    rows: new FakeRowSource(data),
    scratch: new MemoryFile(),
    blob,
    schemaVersion: 53,
    appVersion: '1.3.0',
    now: 1_755_000_000_000,
  });
  return blob;
}

const BASE_HEADER: BackupHeader = {
  formatVersion: BACKUP_FORMAT_VERSION,
  algo: 'recovery-code-v1',
  schemaVersion: 53,
  appVersion: '1.3.0',
  createdAt: 1_755_000_000_000,
  tables: [],
  plaintextBytes: 0,
};

/** Seals arbitrary NDJSON, so a malformed blob can be built on purpose. */
async function sealedByHand(
  ndjson: string,
  header: Partial<BackupHeader> = {},
  options: { truncateDeflate?: boolean } = {},
): Promise<MemoryFile> {
  const blob = new MemoryFile();
  const bytes = new TextEncoder().encode(ndjson);
  const full: BackupHeader = { ...BASE_HEADER, plaintextBytes: bytes.length, ...header };
  const writer = new BlobWriter(KEY, blob, full);
  let payload = pako.deflate(bytes);
  if (options.truncateDeflate) payload = payload.slice(0, payload.length - 24);
  await writer.writeFrame(payload, true);
  return blob;
}

function section(table: string, rows: Record<string, unknown>[]): string {
  return [
    JSON.stringify({ [SECTION_TABLE_KEY]: table, [SECTION_ROWS_KEY]: rows.length }),
    ...rows.map((r) => JSON.stringify(r)),
  ]
    .map((l) => `${l}\n`)
    .join('');
}

function run(blob: MemoryFile, sink: FakeSink, schemaVersion = 53): Promise<ImportResult> {
  return importBackup({ key: KEY, blob, sink, knownColumns: KNOWN_COLUMNS, schemaVersion });
}

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const reason = (err as { reason?: string }).reason;
    if (reason) return reason;
    throw err;
  }
  throw new Error('expected a refusal, but the import succeeded');
}

// ---- tests ----------------------------------------------------------------

describe('export → import round trip', () => {
  it('restores every row the exporter wrote, to the right table', async () => {
    const blob = await sealedByExporter({
      facts: [
        { id: 'f1', statement: 'I follow EU policy', weight: 1.5 },
        { id: 'f2', statement: 'I cycle', weight: 1 },
      ],
      topics: [{ id: 't1', fact_id: 'f1', text: 'EU policy' }],
      saved_article_suggestions: [{ id: 's1', article_id: 'a1', saved_at: 5 }],
    });

    const sink = new FakeSink();
    const result = await run(blob, sink);

    expect(sink.tables.facts).toEqual([
      { id: 'f1', statement: 'I follow EU policy', weight: 1.5 },
      { id: 'f2', statement: 'I cycle', weight: 1 },
    ]);
    expect(sink.tables.saved_article_suggestions).toEqual([
      { id: 's1', article_id: 'a1', saved_at: 5 },
    ]);
    expect(result.rowsRestored).toBe(4);
    expect(result.perTable).toEqual({ facts: 2, topics: 1, saved_article_suggestions: 1 });
    expect(result.skippedTables).toEqual([]);
    expect(result.fromNewerSchema).toBe(false);
  });

  it('round-trips an empty backup without writing anything', async () => {
    const sink = new FakeSink();
    const result = await run(await sealedByExporter({}), sink);
    expect(result.rowsRestored).toBe(0);
    expect(sink.createCalls).toBe(0);
    expect(sink.events).toEqual(['begin', 'clear', 'finish']);
  });

  it('spans many write batches without losing or duplicating a row', async () => {
    // WRITE_BATCH_ROWS is 500, so 1,201 rows is three full batches and a tail.
    const facts = Array.from({ length: 1201 }, (_, i) => ({
      id: `f${String(i).padStart(5, '0')}`,
      statement: `s${i}`,
    }));
    const sink = new FakeSink();
    const result = await run(await sealedByExporter({ facts }), sink);

    expect(result.perTable.facts).toBe(1201);
    expect(sink.createCalls).toBeGreaterThan(2);
    expect(sink.tables.facts.map((r) => r.id)).toEqual(facts.map((f) => f.id));
  });

  it('survives a payload large enough to span many frames', async () => {
    // The frame boundary is invisible in the NDJSON, so a line split across two
    // frames is only exercised by a payload this size.
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let lcg = 0x2545f491;
    let content = '';
    for (let i = 0; i < 400_000; i++) {
      lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
      content += alphabet[(lcg >>> 26) % alphabet.length];
    }
    const blob = await sealedByExporter({
      saved_article_suggestions: [{ id: 's1', article_id: 'a1', description_en: content }],
    });
    const opened = await openBlob(KEY, blob);
    const frameSizes: number[] = [];
    for await (const frame of opened.frames()) frameSizes.push(frame.length);
    expect(frameSizes.length).toBeGreaterThan(1);

    const sink = new FakeSink();
    await run(blob, sink);
    expect(sink.tables.saved_article_suggestions[0].description_en).toBe(content);
  });
});

describe('settings are upserted, never cleared, and re-filtered on the way in', () => {
  it('never asks the sink to clear the settings table', async () => {
    const sink = new FakeSink();
    await run(await sealedByExporter({ facts: [{ id: 'f1' }] }), sink);
    expect(sink.cleared).not.toContain('settings');
    // Everything else the blob declares IS cleared, which is what makes a
    // restore deterministic and re-runnable.
    expect(sink.cleared).toContain('facts');
  });

  it('clears every replaced table even when the blob declares only some of them', async () => {
    // A restore REPLACES the persona. Deriving the clear list from the blob's
    // own header.tables[] would let a partial blob write itself on top of the
    // tables it did not declare, which is the mixed persona lifecycle.ts
    // exists to prevent. Today's exporter always emits every section, so this
    // is the case that only a hand-made blob reaches.
    const blob = await sealedByHand(section('facts', [{ id: 'f1', statement: 'a' }]), {
      tables: [{ table: 'facts', rows: 1, rowsAvailable: 1 }],
    });
    const sink = new FakeSink();
    await run(blob, sink);

    expect(sink.cleared).toContain('saved_article_suggestions');
    expect(sink.cleared).toContain('tracked_stories');
    expect(sink.cleared).not.toContain('settings');
  });

  it('upserts allowlisted keys by key, carrying no row id', async () => {
    const sink = new FakeSink();
    await run(
      await sealedByExporter({
        settings: [
          { id: 's1', key: 'app_language', value: 'de' },
          { id: 's2', key: 'headline_depth:DE', value: '3' },
        ],
      }),
      sink,
    );
    expect(sink.settings).toEqual({ app_language: 'de', 'headline_depth:DE': '3' });
    expect(sink.events).toContain('upsertSettings');
  });

  it('refuses a forbidden settings key even in a perfectly authenticated blob', async () => {
    // The attack this closes: the AEAD proves nobody altered the blob AFTER it
    // was sealed. It proves nothing about the build that sealed it. A blob
    // carrying cached_user_id would make identity-gate wipeAndProceed and
    // destroy the restore that wrote it.
    const blob = await sealedByHand(
      section('settings', [
        { id: 's1', key: 'cached_user_id', value: 'someone-else' },
        { id: 's2', key: 'last_known_subscription_tier', value: 'professional' },
        { id: 's3', key: 'app_language', value: 'fr' },
      ]),
      { tables: [{ table: 'settings', rows: 3, rowsAvailable: 3 }] },
    );

    const sink = new FakeSink();
    const result = await run(blob, sink);

    expect(sink.settings).toEqual({ app_language: 'fr' });
    expect([...result.refusedSettingKeys].sort()).toEqual([
      'cached_user_id',
      'last_known_subscription_tier',
    ]);
  });
});

describe('schema drift', () => {
  it('drops a column this build does not have, keeps the row, and says so', async () => {
    const blob = await sealedByHand(
      section('facts', [{ id: 'f1', statement: 'a', a_column_from_the_future: 42 }]),
      { schemaVersion: 61, tables: [{ table: 'facts', rows: 1, rowsAvailable: 1 }] },
    );
    const sink = new FakeSink();
    const result = await run(blob, sink);

    expect(sink.tables.facts).toEqual([{ id: 'f1', statement: 'a' }]);
    expect(result.droppedColumns).toEqual({ facts: ['a_column_from_the_future'] });
    expect(result.fromNewerSchema).toBe(true);
  });

  it('skips a table this build does not have rather than throwing', async () => {
    const blob = await sealedByHand(
      `${section('facts', [{ id: 'f1', statement: 'a' }])}${section('a_future_table', [{ id: 'x1' }])}`,
      {
        schemaVersion: 61,
        tables: [
          { table: 'facts', rows: 1, rowsAvailable: 1 },
          { table: 'a_future_table', rows: 1, rowsAvailable: 1 },
        ],
      },
    );
    const sink = new FakeSink();
    const result = await run(blob, sink);

    expect(result.skippedTables).toEqual(['a_future_table']);
    expect(sink.tables.a_future_table).toBeUndefined();
    expect(sink.cleared).not.toContain('a_future_table');
    expect(result.perTable.facts).toBe(1);
  });

  it('needs nothing for an OLDER blob: migrations are additive, so a missing column is defaulted', async () => {
    const blob = await sealedByHand(section('facts', [{ id: 'f1', statement: 'a' }]), {
      schemaVersion: 40,
      tables: [{ table: 'facts', rows: 1, rowsAvailable: 1 }],
    });
    const result = await run(blob, new FakeSink());
    expect(result.fromNewerSchema).toBe(false);
    expect(result.droppedColumns).toEqual({});
  });
});

describe('refusals', () => {
  it('refuses a row with no id, which would break every reference to it', async () => {
    const blob = await sealedByHand(section('facts', [{ statement: 'orphan' }]), {
      tables: [{ table: 'facts', rows: 1, rowsAvailable: 1 }],
    });
    const sink = new FakeSink();
    expect(await refusal(() => run(blob, sink))).toBe('tampered');
    expect(sink.events).not.toContain('finish');
    expect(sink.events).toContain('abort');
  });

  it('refuses a section whose declared count disagrees with its rows', async () => {
    const body = [
      JSON.stringify({ [SECTION_TABLE_KEY]: 'facts', [SECTION_ROWS_KEY]: 5 }),
      JSON.stringify({ id: 'f1', statement: 'a' }),
    ]
      .map((l) => `${l}\n`)
      .join('');
    const blob = await sealedByHand(body, { tables: [{ table: 'facts', rows: 5, rowsAvailable: 5 }] });
    expect(await refusal(() => run(blob, new FakeSink()))).toBe('tampered');
  });

  it('refuses a row that arrives before any section marker', async () => {
    const blob = await sealedByHand(`${JSON.stringify({ id: 'f1' })}\n`);
    expect(await refusal(() => run(blob, new FakeSink()))).toBe('tampered');
  });

  it('refuses a line that is not JSON', async () => {
    const blob = await sealedByHand('this is not json\n');
    expect(await refusal(() => run(blob, new FakeSink()))).toBe('tampered');
  });

  it('refuses a deflate stream cut short, which authenticates perfectly', async () => {
    // Every byte present is genuine and the frame's tag verifies, so the AEAD
    // waves it through. MEASURED, and it is why the byte-count check exists:
    // pako reports a truncated stream by producing LESS OUTPUT — `err` stays 0
    // and `push(…, true)` still returns true. Only `header.plaintextBytes`
    // catches it.
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: `f${i}`, statement: `s${i}` }));
    const blob = await sealedByHand(section('facts', rows), {}, { truncateDeflate: true });
    expect(await refusal(() => run(blob, new FakeSink()))).toBe('incomplete');
  });

  it('refuses the wrong key before touching the sink', async () => {
    const blob = await sealedByExporter({ facts: [{ id: 'f1' }] });
    const sink = new FakeSink();
    const other = Uint8Array.from({ length: 32 }, (_, i) => i + 99);
    await expect(
      importBackup({ key: other, blob, sink, knownColumns: KNOWN_COLUMNS, schemaVersion: 53 }),
    ).rejects.toMatchObject({ reason: 'wrong-key' });
    // beginRestore must not have run: nothing has been torn yet.
    expect(sink.events).toEqual([]);
  });

  it('leaves the torn-restore marker set when a write fails mid-way', async () => {
    const sink = new FakeSink();
    sink.failOnTable = 'facts';
    const blob = await sealedByExporter({ facts: [{ id: 'f1', statement: 'a' }] });
    await expect(run(blob, sink)).rejects.toThrow('disk full');
    // abort, never finish — a restore that failed halfway HAS torn the data,
    // and the next launch has to be able to tell.
    expect(sink.events).toContain('abort');
    expect(sink.events).not.toContain('finish');
  });

  it('exposes a reason on every refusal it raises itself', () => {
    expect(new BackupImportError('incomplete', 'x').reason).toBe('incomplete');
    expect(new BackupImportError('incomplete', 'x').name).toBe('BackupImportError');
  });
});

describe('inspectBackup', () => {
  it('returns the header for a restore preview without decrypting the body', async () => {
    const blob = await sealedByExporter({
      facts: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }],
    });
    const header = await inspectBackup(KEY, blob);
    expect(header.createdAt).toBe(1_755_000_000_000);
    expect(header.tables.find((t) => t.table === 'facts')?.rows).toBe(3);
  });

  it('refuses the wrong key rather than returning a header', async () => {
    const blob = await sealedByExporter({ facts: [{ id: 'f1' }] });
    const other = Uint8Array.from({ length: 32 }, (_, i) => i + 99);
    // The header is cleartext, so this only fails once a frame is opened —
    // which is why inspect is a preview, never an authorisation check.
    const header = await inspectBackup(other, blob);
    expect(header.formatVersion).toBe(BACKUP_FORMAT_VERSION);
  });
});
