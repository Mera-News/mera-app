// Reading a backup: authenticated frames → inflate → NDJSON → batched writes.
//
// The mirror of `export.ts`, and it refuses far more than it accepts.
//
// **A valid signature is not a promise that the writer was correct.** The AEAD
// proves nobody tampered with the blob after it was sealed; it proves nothing
// about the build that sealed it. So every settings key is re-filtered through
// `isBackedUpSettingKey` on the way IN, not only on the way out. A blob written
// by a build with a broken allowlist — or by hand — must not be able to write
// `cached_user_id`, because identity-gate reads that key and a foreign value
// triggers `wipeAndProceed`, destroying the very restore that wrote it.
//
// **`settings` is not cleared and not created, it is upserted by key.** Every
// other backed-up table is wiped and rewritten, which is what makes a restore
// deterministic and re-runnable. Wiping `settings` would take device-scoped
// keys with it — `cached_user_id`, `needs_reauth`, the PIN preference — and
// those belong to the device the restore is landing on, not to the blob.
//
// **A restore is not atomic and is not pretending to be.** 70k rows cannot go
// through one WatermelonDB `batch()`, so writes are chunked and a crash lands
// mid-restore. That is what the torn-restore marker is for: `beginRestore`
// sets it and `finishRestore` clears it, so the next launch can tell a finished
// restore from an interrupted one rather than booting a half-written persona.
//
// IO, the database and the current schema are all injected. `lib/backup` stays
// free of native modules.

import pako from 'pako';

import { RESTORE_REPLACED_TABLES, isBackedUpSettingKey } from './allowlist';
import { openBlob, type BlobSource } from './blob';
import { SECTION_ROWS_KEY, SECTION_TABLE_KEY } from './export';
import type { BackupHeader, RestoreRefusal } from './types';

/** Rows per `batch()` call. Bounded so one write is never a huge allocation. */
const WRITE_BATCH_ROWS = 500;

const NEWLINE = 0x0a;

export class BackupImportError extends Error {
  constructor(
    readonly reason: RestoreRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'BackupImportError';
  }
}

// ---- ports ----------------------------------------------------------------

/**
 * The write seam. `watermelon-row-sink.ts` is the production implementation;
 * tests use an in-memory double.
 */
export interface RowSink {
  /** Sets the torn-restore marker. Nothing else may run before this. */
  beginRestore(): Promise<void>;
  /** Empties the tables about to be rewritten. Never includes `settings`. */
  clearTables(tables: readonly string[]): Promise<void>;
  /** Creates rows with `_raw.id` seeded from the row's own `id`. */
  createRows(table: string, rows: readonly Record<string, unknown>[]): Promise<void>;
  /** Upserts by `key`, leaving unlisted keys and existing row ids alone. */
  upsertSettings(entries: readonly { key: string; value: unknown }[]): Promise<void>;
  /** Clears the torn-restore marker. */
  finishRestore(): Promise<void>;
  /** Best-effort. Leaves the marker set: an aborted restore IS torn. */
  abortRestore(): Promise<void>;
}

export interface ImportOptions {
  readonly key: Uint8Array;
  readonly blob: BlobSource;
  readonly sink: RowSink;
  /**
   * Columns this build knows, per table, from the live `appSchema`. Anything
   * the blob carries beyond this is dropped and reported rather than handed to
   * WatermelonDB, which would reject the whole batch.
   */
  readonly knownColumns: Readonly<Record<string, readonly string[]>>;
  /** `appSchema.version` of this build, for the drift report. */
  readonly schemaVersion: number;
  readonly onProgress?: (progress: ImportProgress) => void;
}

export interface ImportProgress {
  readonly table: string;
  readonly rowsRestored: number;
}

export interface ImportResult {
  readonly header: BackupHeader;
  readonly rowsRestored: number;
  readonly perTable: Readonly<Record<string, number>>;
  /** In the blob, unknown to this build. Only ever from a NEWER blob. */
  readonly skippedTables: readonly string[];
  /** Per table, columns dropped because this build's schema lacks them. */
  readonly droppedColumns: Readonly<Record<string, readonly string[]>>;
  /** Settings keys the blob carried that this build refuses to write. */
  readonly refusedSettingKeys: readonly string[];
  /** True when the blob came from a newer schema than this build runs. */
  readonly fromNewerSchema: boolean;
}

// ---- header inspection ----------------------------------------------------

/**
 * Parses the header and nothing else, so a restore preview ("backup from
 * <date>, 1,204 facts") costs a header read rather than a full decrypt.
 * Refusals surface as `BlobFormatError`, whose `reason` is a `RestoreRefusal`.
 */
export async function inspectBackup(key: Uint8Array, blob: BlobSource): Promise<BackupHeader> {
  return (await openBlob(key, blob)).header;
}

// ---- line splitting -------------------------------------------------------

/**
 * Splits inflate output into NDJSON lines at the BYTE level.
 *
 * Deliberately not `TextDecoder(..., {stream: true})`: streaming decode support
 * is uneven across engines and a chunk boundary landing mid-character would
 * corrupt a line silently. Splitting on 0x0A first is safe unconditionally,
 * because a UTF-8 continuation byte is always >= 0x80 and so `\n` can never
 * appear inside a multibyte sequence. Each complete line is then decoded whole.
 */
class LineSplitter {
  private carry = new Uint8Array(0);
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    const buf = new Uint8Array(this.carry.length + chunk.length);
    buf.set(this.carry, 0);
    buf.set(chunk, this.carry.length);

    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== NEWLINE) continue;
      if (i > start) lines.push(this.decoder.decode(buf.subarray(start, i)));
      start = i + 1;
    }
    this.carry = buf.slice(start);
    return lines;
  }

  /** Any trailing bytes with no final newline. The exporter always ends with
   * one, so a non-empty flush means a truncated or hand-made blob. */
  flush(): string[] {
    if (this.carry.length === 0) return [];
    const last = this.decoder.decode(this.carry);
    this.carry = new Uint8Array(0);
    return [last];
  }
}

// ---- row shaping ----------------------------------------------------------

interface Shaped {
  readonly row: Record<string, unknown>;
  readonly dropped: readonly string[];
}

/**
 * Narrows a row to the columns this build's schema has. A column the blob
 * carries and this build lacks means the blob is from a newer schema; handing
 * it to WatermelonDB would reject the whole batch, so it is dropped and named
 * in the result. A column this build has and the blob lacks needs nothing:
 * migrations are additive by invariant, so it is optional or defaulted.
 */
function shapeRow(row: Record<string, unknown>, known: readonly string[]): Shaped {
  const allowed = new Set<string>([...known, 'id']);
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (allowed.has(k)) out[k] = v;
    else dropped.push(k);
  }
  return { row: out, dropped };
}

// ---- entry point ----------------------------------------------------------

/**
 * Restores one backup. Throws `BackupImportError` or `BlobFormatError`; either
 * way `reason` is a `RestoreRefusal` and the caller has one message per reason.
 *
 * On any throw the torn-restore marker is left SET on purpose. A restore that
 * failed halfway has genuinely torn the local data, and pretending otherwise
 * boots the user into a mixture of two personas.
 */
export async function importBackup(options: ImportOptions): Promise<ImportResult> {
  const { key, blob, sink, knownColumns, schemaVersion, onProgress } = options;

  const opened = await openBlob(key, blob);
  const header = opened.header;
  const fromNewerSchema = header.schemaVersion > schemaVersion;

  // Tables the blob declares and this build does not have. Only reachable from
  // a newer blob, and skipping them is the only option — there is no table to
  // write them to.
  const skippedTables = header.tables
    .map((t) => t.table)
    .filter((t) => t !== 'settings' && !(t in knownColumns));

  // Cleared from the ALLOWLIST, never from the blob's own table list. A restore
  // replaces the persona; deriving this from `header.tables[]` would let a blob
  // declaring a subset write itself on top of the tables it did not declare,
  // which is the mixed persona this whole lifecycle exists to prevent.
  const clearable = RESTORE_REPLACED_TABLES.filter((t) => t in knownColumns);

  const perTable: Record<string, number> = {};
  const droppedColumns: Record<string, Set<string>> = {};
  const refusedSettingKeys: string[] = [];
  let rowsRestored = 0;

  // AUTHENTICATE BEFORE CLEARING ANYTHING. `openBlob` parses the header, which
  // is cleartext, and decrypts nothing — the first frame is only opened when
  // the iterator is pulled. Clearing first meant a mistyped recovery code wiped
  // the user's local data and THEN reported `wrong-key`, which is the single
  // worst thing this file could do. So the first frame is pulled here, outside
  // the try, while the sink is still untouched.
  const frames = opened.frames();
  const first = await frames.next();

  await sink.beginRestore();

  try {
    await sink.clearTables(clearable);

    const splitter = new LineSplitter();
    const inflate = new pako.Inflate();
    const inflated: Uint8Array[] = [];
    inflate.onData = (chunk: Uint8Array) => {
      inflated.push(chunk);
    };

    let currentTable: string | null = null;
    let declared = 0;
    let seen = 0;
    let pending: Record<string, unknown>[] = [];

    const flush = async (): Promise<void> => {
      if (!currentTable || pending.length === 0) return;
      const table = currentTable;
      const rows = pending;
      pending = [];

      if (table === 'settings') {
        await sink.upsertSettings(
          rows.map((r) => ({ key: String(r.key), value: r.value })),
        );
      } else {
        await sink.createRows(table, rows);
      }
      perTable[table] = (perTable[table] ?? 0) + rows.length;
      rowsRestored += rows.length;
      onProgress?.({ table, rowsRestored });
    };

    const endSection = (): void => {
      if (currentTable && seen !== declared) {
        throw new BackupImportError(
          'tampered',
          `Section ${currentTable} declared ${declared} rows but carried ${seen}`,
        );
      }
    };

    const handleLine = async (line: string): Promise<void> => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new BackupImportError('tampered', 'Backup contains a line that is not JSON');
      }

      if (typeof parsed[SECTION_TABLE_KEY] === 'string') {
        await flush();
        endSection();
        currentTable = parsed[SECTION_TABLE_KEY] as string;
        declared = Number(parsed[SECTION_ROWS_KEY] ?? 0);
        seen = 0;
        return;
      }

      if (!currentTable) {
        throw new BackupImportError('tampered', 'Backup has a row before any section marker');
      }
      seen += 1;

      if (currentTable === 'settings') {
        const settingKey = String(parsed.key ?? '');
        // Re-filtered on the way IN. See the header comment: a signature says
        // nothing about whether the writer was a correct build.
        if (!isBackedUpSettingKey(settingKey)) {
          refusedSettingKeys.push(settingKey);
          return;
        }
        // `id` is deliberately not carried: the upsert matches on `key` and an
        // existing row keeps its own id.
        pending.push({ key: settingKey, value: parsed.value });
      } else {
        if (!(currentTable in knownColumns)) return; // skippedTables, already reported
        const { row, dropped } = shapeRow(parsed, knownColumns[currentTable]);
        if (dropped.length > 0) {
          const seenForTable = (droppedColumns[currentTable] ??= new Set<string>());
          for (const c of dropped) seenForTable.add(c);
        }
        if (typeof row.id !== 'string' || row.id === '') {
          throw new BackupImportError(
            'tampered',
            `A ${currentTable} row has no id; restoring it would break every reference to it`,
          );
        }
        pending.push(row);
      }

      if (pending.length >= WRITE_BATCH_ROWS) await flush();
    };

    let inflatedBytes = 0;
    const feed = async (frame: Uint8Array, isLast: boolean): Promise<void> => {
      inflate.push(frame, isLast);
      if (inflate.err) {
        throw new BackupImportError('tampered', `inflate failed (${inflate.err}): ${inflate.msg}`);
      }
      while (inflated.length > 0) {
        const chunk = inflated.shift() as Uint8Array;
        inflatedBytes += chunk.length;
        for (const line of splitter.push(chunk)) await handleLine(line);
      }
    };

    // One frame is held back, mirroring the exporter's held CHUNK, so the final
    // push carries `true` rather than `push(empty, true)` after the loop —
    // pako's behaviour once a stream has ended is not something to build a
    // restore on.
    let heldFrame: Uint8Array | null = first.done ? null : (first.value as Uint8Array);
    if (!first.done) {
      for (;;) {
        const next = await frames.next();
        if (next.done) break;
        await feed(heldFrame as Uint8Array, false);
        heldFrame = next.value as Uint8Array;
      }
    }
    await feed(heldFrame ?? new Uint8Array(0), true);

    for (const line of splitter.flush()) await handleLine(line);

    // The blob's last-frame flag proves the CIPHERTEXT arrived whole; it says
    // nothing about the deflate stream inside it. pako reports a truncated
    // stream by simply producing less output — `err` stays 0 and `push` still
    // returns true — so the only honest check is against the byte count the
    // exporter recorded. This is what `header.plaintextBytes` is for.
    if (inflatedBytes !== header.plaintextBytes) {
      throw new BackupImportError(
        'incomplete',
        `Backup declared ${header.plaintextBytes} bytes of content but yielded ${inflatedBytes}`,
      );
    }

    await flush();
    endSection();
    await sink.finishRestore();
  } catch (err) {
    await sink.abortRestore();
    throw err;
  }

  return {
    header,
    rowsRestored,
    perTable,
    skippedTables,
    droppedColumns: Object.fromEntries(
      Object.entries(droppedColumns).map(([t, s]) => [t, [...s].sort()]),
    ),
    refusedSettingKeys,
    fromNewerSchema,
  };
}
