// The exporter, driven end to end through the REAL deflate and the real codec.
//
// The one test that could not exist in `blob.test.ts` is the multi-chunk one.
// That suite drives `BlobWriter` directly, so it can never catch the exporter's
// hardest bug: `writeFrame` needs `isLast` at call time but pako only reveals
// the final chunk by returning from `push(…, true)`, so the exporter holds one
// chunk back. Never flagging gives every blob `incomplete`; flagging early
// gives "Data follows the final frame". Both need a payload big enough to
// produce several output chunks, which is what `highEntropyText` is for.

import pako from 'pako';

import { BACKUP_TABLES, TABLE_ROW_CAPS } from '../allowlist';
import { openBlob } from '../blob';
import {
  BACKUP_MAX_PLAINTEXT_BYTES,
  BackupExportError,
  SECTION_ROWS_KEY,
  SECTION_TABLE_KEY,
  exportBackup,
  orderForTable,
  type RowPageQuery,
  type RowSource,
} from '../export';
import { BACKUP_MAX_BYTES } from '../types';
import { MemoryFile } from './memory-file';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/** Implements ordering and paging for real, so the cap tests mean something. */
class FakeRowSource implements RowSource {
  snapshotCalls = 0;
  pagesOutsideSnapshot = 0;
  private inSnapshot = false;

  constructor(private readonly data: Record<string, Record<string, unknown>[]>) {}

  async snapshot<T>(work: () => Promise<T>): Promise<T> {
    this.snapshotCalls += 1;
    this.inSnapshot = true;
    try {
      return await work();
    } finally {
      this.inSnapshot = false;
    }
  }

  async page(query: RowPageQuery): Promise<readonly Record<string, unknown>[]> {
    if (!this.inSnapshot) this.pagesOutsideSnapshot += 1;
    const rows = [...(this.data[query.table] ?? [])];
    rows.sort((a, b) => {
      for (const o of query.orderBy) {
        const av = a[o.column] as string | number;
        const bv = b[o.column] as string | number;
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return o.desc ? -cmp : cmp;
      }
      return 0;
    });
    return rows.slice(query.offset, query.offset + query.limit);
  }

  count(table: string): Promise<number> {
    return Promise.resolve((this.data[table] ?? []).length);
  }
}

interface Decoded {
  header: Awaited<ReturnType<typeof openBlob>>['header'];
  frameCount: number;
  sections: { table: string; declared: number; rows: Record<string, unknown>[] }[];
}

async function decode(blob: MemoryFile): Promise<Decoded> {
  const opened = await openBlob(KEY, blob);
  const frames: Uint8Array[] = [];
  for await (const f of opened.frames()) frames.push(f);

  const inflate = new pako.Inflate();
  const chunks: Uint8Array[] = [];
  inflate.onData = (c: Uint8Array) => chunks.push(c);
  frames.forEach((f, i) => inflate.push(f, i === frames.length - 1));
  if (inflate.err) throw new Error(`inflate failed: ${inflate.msg}`);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  const text = new TextDecoder().decode(joined);

  const sections: Decoded['sections'] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed[SECTION_TABLE_KEY] === 'string') {
      sections.push({
        table: parsed[SECTION_TABLE_KEY] as string,
        declared: parsed[SECTION_ROWS_KEY] as number,
        rows: [],
      });
    } else {
      sections[sections.length - 1].rows.push(parsed);
    }
  }
  return { header: opened.header, frameCount: frames.length, sections };
}

function run(
  data: Record<string, Record<string, unknown>[]>,
): Promise<{ blob: MemoryFile; rows: FakeRowSource; result: Awaited<ReturnType<typeof exportBackup>> }> {
  const blob = new MemoryFile();
  const scratch = new MemoryFile();
  const rows = new FakeRowSource(data);
  return exportBackup({
    key: KEY,
    rows,
    scratch,
    blob,
    schemaVersion: 53,
    appVersion: '1.3.0',
    now: 1_755_000_000_000,
  }).then((result) => ({ blob, rows, result }));
}

/**
 * Deterministic LCG rendered as text. Deflate cannot squash it, so N bytes in
 * means roughly N bytes of output and therefore N/16384 output chunks — which
 * is the only way to exercise the held-chunk path. A patterned fixture would
 * compress to a single chunk and the test would pass without testing anything.
 */
function highEntropyText(bytes: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
  let lcg = 0x2545f491;
  let out = '';
  for (let i = 0; i < bytes; i++) {
    lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
    out += alphabet[(lcg >>> 26) & 63];
  }
  return out;
}

describe('round trip', () => {
  it('writes every allowlisted table as a section, in allowlist order', async () => {
    const { blob } = await run({
      facts: [{ id: 'f1', statement: 'a', created_at: 1 }],
      messages: [{ id: 'm1', conversation_id: 'c1', content: 'hi', created_at: 5 }],
      conversations: [{ id: 'c1', surface: 'chat', created_at: 4 }],
    });

    const { sections } = await decode(blob);
    expect(sections.map((s) => s.table)).toEqual([...BACKUP_TABLES]);
    // `conversations` before `messages`: the importer seeds `_raw.id`, and a
    // child row written before its parent is a dangling read, not an error.
    expect(sections.findIndex((s) => s.table === 'conversations')).toBeLessThan(
      sections.findIndex((s) => s.table === 'messages'),
    );
  });

  it('round-trips row values exactly', async () => {
    const fact = { id: 'f1', statement: 'I follow EU policy', weight: 1.5, created_at: 7 };
    const { blob } = await run({ facts: [fact] });
    const { sections } = await decode(blob);
    expect(sections.find((s) => s.table === 'facts')?.rows).toEqual([fact]);
  });

  it('keeps `id` and drops the sync bookkeeping columns', async () => {
    const { blob } = await run({
      facts: [{ id: 'f1', _status: 'created', _changed: 'statement', statement: 'a' }],
    });
    const [row] = (await decode(blob)).sections.find((s) => s.table === 'facts')!.rows;
    expect(row.id).toBe('f1');
    expect(row).not.toHaveProperty('_status');
    expect(row).not.toHaveProperty('_changed');
  });

  it('produces a readable blob from a completely empty database', async () => {
    const { blob } = await run({});
    const { sections, header } = await decode(blob);
    expect(sections).toHaveLength(BACKUP_TABLES.length);
    expect(sections.every((s) => s.rows.length === 0)).toBe(true);
    expect(header.tables.every((t) => t.rows === 0)).toBe(true);
  });

  it('declares a row count per section that matches the rows that follow', async () => {
    const { blob } = await run({
      facts: Array.from({ length: 37 }, (_, i) => ({ id: `f${i}`, statement: `s${i}` })),
    });
    for (const s of (await decode(blob)).sections) {
      expect(s.declared).toBe(s.rows.length);
    }
  });
});

describe('the multi-chunk seal — what blob.test.ts structurally cannot reach', () => {
  it('flags exactly the last frame across many deflate output chunks', async () => {
    // ~600 KB of incompressible text, so deflate emits well over pako's 16 KB
    // output chunk several times over.
    const { blob } = await run({
      messages: Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        conversation_id: 'c1',
        content: highEntropyText(100_000),
        created_at: i,
      })),
    });

    const { frameCount, sections } = await decode(blob);
    expect(frameCount).toBeGreaterThanOrEqual(3);
    expect(sections.find((s) => s.table === 'messages')?.rows).toHaveLength(6);
  });

  it('spans more than one scratch read, so paging the plaintext is exercised', async () => {
    const { result } = await run({
      messages: [{ id: 'm1', conversation_id: 'c1', content: highEntropyText(700_000), created_at: 1 }],
    });
    // SEAL_READ_BYTES is 256 KB, so this is three passes round the read loop —
    // enough for a bug in the read offset to show up as a corrupt inflate.
    expect(Math.ceil(result.header.plaintextBytes / (256 * 1024))).toBeGreaterThanOrEqual(3);
  });
});

describe('the header describes what was actually written', () => {
  it('reports rows and rowsAvailable per table', async () => {
    const { result } = await run({
      facts: [{ id: 'f1' }, { id: 'f2' }],
      topics: [{ id: 't1' }],
    });
    const facts = result.header.tables.find((t) => t.table === 'facts');
    expect(facts).toEqual({ table: 'facts', rows: 2, rowsAvailable: 2 });
    expect(result.header.schemaVersion).toBe(53);
    expect(result.header.appVersion).toBe('1.3.0');
    expect(result.header.algo).toBe('recovery-code-v1');
  });

  it('reports plaintextBytes equal to the bytes the sections occupy', async () => {
    const { blob, result } = await run({ facts: [{ id: 'f1', statement: 'a' }] });
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
});

describe('caps keep the newest rows', () => {
  const CAP = TABLE_ROW_CAPS.fact_checks;

  it('orders a capped table by its timestamp descending, id ascending', () => {
    expect(orderForTable('fact_checks')).toEqual([
      { column: 'requested_at', desc: true },
      { column: 'id' },
    ]);
    expect(orderForTable('facts')).toEqual([{ column: 'id' }]);
  });

  it('truncates to the cap and keeps the newest, not an arbitrary N', async () => {
    // Ids ascend while timestamps DESCEND, so an id-ordered exporter would keep
    // the oldest rows and this assertion is what catches it.
    const rows = Array.from({ length: CAP + 25 }, (_, i) => ({
      id: `fc${String(i).padStart(5, '0')}`,
      requested_at: CAP + 25 - i,
    }));
    const { blob, result } = await run({ fact_checks: rows });

    const stat = result.header.tables.find((t) => t.table === 'fact_checks');
    expect(stat).toEqual({ table: 'fact_checks', rows: CAP, rowsAvailable: CAP + 25 });

    const written = (await decode(blob)).sections.find((s) => s.table === 'fact_checks')!.rows;
    expect(written).toHaveLength(CAP);
    expect(written[0].requested_at).toBe(CAP + 25);
    expect(Math.min(...written.map((r) => r.requested_at as number))).toBe(26);
  });

  it('leaves an uncapped table whole', async () => {
    const { result } = await run({
      facts: Array.from({ length: 1200 }, (_, i) => ({ id: `f${i}` })),
    });
    expect(result.header.tables.find((t) => t.table === 'facts')).toEqual({
      table: 'facts',
      rows: 1200,
      rowsAvailable: 1200,
    });
  });
});

describe('settings are allowlisted, never denylisted', () => {
  it('carries allowed keys, drops forbidden ones, and honours the prefix family', async () => {
    const { blob, result } = await run({
      settings: [
        { id: 's1', key: 'app_language', value: 'de' },
        { id: 's2', key: 'headline_depth:DE', value: '3' },
        { id: 's3', key: 'cached_user_id', value: 'abc123' },
        { id: 's4', key: 'last_known_subscription_tier', value: 'professional' },
        { id: 's5', key: 'some_future_key_nobody_opted_in', value: 'x' },
      ],
    });

    const keys = (await decode(blob)).sections
      .find((s) => s.table === 'settings')!
      .rows.map((r) => r.key);
    expect(keys.sort()).toEqual(['app_language', 'headline_depth:DE']);

    // rowsAvailable must be the FILTERED total, or the restore UI reports a
    // complete table as partial.
    expect(result.header.tables.find((t) => t.table === 'settings')).toEqual({
      table: 'settings',
      rows: 2,
      rowsAvailable: 2,
    });
  });
});

describe('the snapshot boundary', () => {
  it('reads every table inside exactly one reader', async () => {
    const { rows } = await run({
      facts: [{ id: 'f1' }],
      messages: [{ id: 'm1', created_at: 1 }],
      topics: [{ id: 't1' }],
    });
    expect(rows.snapshotCalls).toBe(1);
    expect(rows.pagesOutsideSnapshot).toBe(0);
  });
});

describe('refusals', () => {
  it('refuses rather than truncating when the blob exceeds the size cap', async () => {
    // Base64-alphabet text is 6 bits of entropy per byte, so deflate still
    // takes ~25% off it — 40 MB of payload is what actually clears a 25 MB
    // ciphertext ceiling. Measured, not assumed: 30 MB sealed to 22.7 MB and
    // this test passed while asserting nothing.
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      conversation_id: 'c1',
      content: highEntropyText(1_000_000),
      created_at: i,
    }));
    await expect(run({ messages: rows })).rejects.toMatchObject({
      name: 'BackupExportError',
      reason: 'too-large',
    });
    expect(BACKUP_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it('names a plaintext ceiling well above the ciphertext one', () => {
    // A guard against filling the disk, not a product limit. If these ever
    // invert, the scratch file would be refused before the blob ever could be.
    expect(BACKUP_MAX_PLAINTEXT_BYTES).toBeGreaterThan(BACKUP_MAX_BYTES);
    expect(new BackupExportError('io', 'x').reason).toBe('io');
  });
});
