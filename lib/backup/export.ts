// Writing a backup: database → NDJSON → deflate → authenticated frames.
//
// Two phases, and the split is the load-bearing decision in this file.
//
//   Phase A (snapshot)  rows → NDJSON → a temporary PLAINTEXT scratch file.
//                       Runs inside one `database.read()`, so no writer runs
//                       for its duration.
//   Phase B (seal)      scratch file → pako deflate → BlobWriter frames.
//                       Runs OUTSIDE the reader. Compression and XChaCha20 are
//                       the expensive parts and neither needs the snapshot.
//
// **Why one reader around the whole of phase A.** Per-table readers would let
// `messages` be snapshotted after `conversations`, so a message created in
// between references a conversation that is not in the blob. That is exactly
// the failure `allowlist.ts` warns about: a child row referencing a missing
// parent is a dangling read, not an error WatermelonDB will raise.
//
// **Why the expensive half is outside it.** A reader blocks every writer, and
// `scheduler-runner.ts` aborts a task at `definition.timeout` and reports the
// abort to Sentry — so a long reader does not merely delay the scheduler, it
// manufactures error events. Keeping deflate and encryption out of the reader
// is what keeps the blocked window to reads and JSON, not to CPU.
//
// **Why a scratch file rather than memory.** A capped export is up to ~72k
// rows; held as JS strings that is tens of megabytes on a phone. The scratch
// file is written under a caller-supplied path (the caller puts it in cache,
// not documents) and is deleted in a `finally`, including on failure. It is
// briefly the user's own data in cleartext in app-private storage — which is
// the same thing the SQLite database sitting beside it already is.
//
// The scratch file also buys exactness for free: `header.tables[]` and
// `plaintextBytes` describe what was ACTUALLY written, counted during phase A,
// rather than counted in advance and hoped for. That matters because the header
// is the AAD and must be complete before the first frame — a streaming
// single-pass design could only ever have guessed at those numbers.
//
// IO and the database are injected. `lib/backup` stays free of native modules.

import pako from 'pako';

import {
  BACKUP_TABLES,
  TABLE_CAP_ORDER_COLUMN,
  TABLE_ROW_CAPS,
  isBackedUpSettingKey,
} from './allowlist';
import { BlobWriter, type BlobSink, type BlobSource } from './blob';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_MAX_BYTES,
  type BackupHeader,
  type BackupTableStat,
} from './types';

/** Rows fetched per query. Bounded so one page is never a large allocation. */
const PAGE_ROWS = 500;
/** Scratch bytes handed to deflate at a time in phase B. */
const SEAL_READ_BYTES = 256 * 1024;

/**
 * Disk-safety stop on the scratch file, not a product limit — the product
 * limit is `BACKUP_MAX_BYTES` on the finished ciphertext. NDJSON of this shape
 * deflates roughly 5-8x, so a blob at the 25 MB ceiling comes from well under
 * this, and anything approaching it means a row cap is wrong rather than a user
 * being prolific.
 */
export const BACKUP_MAX_PLAINTEXT_BYTES = 200 * 1024 * 1024;

/**
 * Section marker preceding each table's rows. `__`-prefixed because every
 * WatermelonDB column in `schema.ts` is lowercase snake_case with no leading
 * underscores, so these keys cannot collide with a row's own fields and the
 * importer can tell a marker from a row without positional trust alone.
 */
export const SECTION_TABLE_KEY = '__t';
export const SECTION_ROWS_KEY = '__n';

export class BackupExportError extends Error {
  constructor(
    readonly reason: 'too-large' | 'io',
    message: string,
  ) {
    super(message);
    this.name = 'BackupExportError';
  }
}

// ---- ports ----------------------------------------------------------------

export interface RowPageQuery {
  readonly table: string;
  /** Applied in order. Emitted as `order by` clauses. */
  readonly orderBy: readonly { readonly column: string; readonly desc?: boolean }[];
  readonly limit: number;
  readonly offset: number;
}

/**
 * The database seam. `watermelon-row-source.ts` is the production
 * implementation; tests use an in-memory double.
 */
export interface RowSource {
  /** Runs `work` with every writer blocked, i.e. `database.read()`. */
  snapshot<T>(work: () => Promise<T>): Promise<T>;
  /** Raw column objects, including `id`. Ordering is the caller's policy. */
  page(query: RowPageQuery): Promise<readonly Record<string, unknown>[]>;
  /** Total rows in a table, for `rowsAvailable`. */
  count(table: string): Promise<number>;
}

/** A read-write temporary file. Written in phase A, read back in phase B. */
export interface ScratchFile extends BlobSink, BlobSource {}

export interface ExportProgress {
  readonly phase: 'snapshot' | 'seal';
  /** Set during `snapshot` only. */
  readonly table?: string;
  readonly rowsWritten: number;
  readonly bytesWritten: number;
}

export interface ExportOptions {
  readonly key: Uint8Array;
  readonly rows: RowSource;
  readonly scratch: ScratchFile;
  readonly blob: BlobSink;
  /** `appSchema.version` at the time of writing. */
  readonly schemaVersion: number;
  /** `app.json` version, for diagnosing a blob from a much older build. */
  readonly appVersion: string;
  readonly now: number;
  readonly onProgress?: (progress: ExportProgress) => void;
}

export interface ExportResult {
  readonly header: BackupHeader;
  /** Finished ciphertext length. */
  readonly blobBytes: number;
}

// ---- helpers --------------------------------------------------------------

/**
 * `_status` and `_changed` are dropped. They are WatermelonDB sync bookkeeping
 * and this app runs no sync engine — nothing calls `synchronize()`, rows are
 * written directly from GraphQL results. On restore the importer creates each
 * row fresh with `_raw.id` seeded, which is the correct state for a device that
 * has never synced them. (The rule that a MIGRATION must carry `_status` and
 * `_changed` across is a different situation: there the row survives in place.)
 *
 * `id` is kept and is not optional: `article_suggestions` seeds `_raw.id` from
 * the server `_id`, and `messages.conversation_id` points at `conversations.id`.
 */
function rowToLine(raw: Record<string, unknown>): string {
  const { _status: _s, _changed: _c, ...rest } = raw;
  return JSON.stringify(rest);
}

function sectionMarker(table: string, rows: number): string {
  return JSON.stringify({ [SECTION_TABLE_KEY]: table, [SECTION_ROWS_KEY]: rows });
}

/**
 * Page ordering, which is where a cap becomes meaningful or meaningless.
 *
 * Capped tables order by their timestamp DESC so the cap keeps the NEWEST rows,
 * with `id` ASC as a tiebreaker — without one, two rows sharing a timestamp can
 * swap between pages and OFFSET paging drops or duplicates a row. Uncapped
 * tables order by `id` alone, which is arbitrary but stable, and stability is
 * all an uncapped table needs.
 */
export function orderForTable(table: string): RowPageQuery['orderBy'] {
  const tsColumn = TABLE_CAP_ORDER_COLUMN[table];
  if (tsColumn) {
    return [
      { column: tsColumn, desc: true },
      { column: 'id' },
    ];
  }
  return [{ column: 'id' }];
}

// ---- phase A: snapshot ----------------------------------------------------

interface SnapshotResult {
  readonly tables: BackupTableStat[];
  readonly plaintextBytes: number;
}

/**
 * Reads every allowlisted table into `scratch` as NDJSON, inside ONE reader.
 * Returns exactly what was written, which becomes the header.
 */
async function writeSnapshot(
  rows: RowSource,
  scratch: ScratchFile,
  onProgress: ((progress: ExportProgress) => void) | undefined,
): Promise<SnapshotResult> {
  const encoder = new TextEncoder();
  const stats: BackupTableStat[] = [];
  let position = 0;
  let rowsWritten = 0;

  const append = async (text: string): Promise<void> => {
    const bytes = encoder.encode(text);
    if (position + bytes.length > BACKUP_MAX_PLAINTEXT_BYTES) {
      throw new BackupExportError(
        'too-large',
        `Snapshot exceeded ${BACKUP_MAX_PLAINTEXT_BYTES} bytes of plaintext`,
      );
    }
    await scratch.write(bytes, position);
    position += bytes.length;
  };

  await rows.snapshot(async () => {
    for (const table of BACKUP_TABLES) {
      const rowsAvailable = await rows.count(table);
      const cap = TABLE_ROW_CAPS[table] ?? Infinity;
      const orderBy = orderForTable(table);

      // Buffered per table because the section marker carries the row count and
      // has to precede the rows. A table's page loop is bounded by its cap, and
      // the buffer holds only the current page's LINES, not the whole table.
      const lines: string[] = [];
      let offset = 0;
      let taken = 0;

      for (;;) {
        const limit = Math.min(PAGE_ROWS, cap === Infinity ? PAGE_ROWS : cap - taken);
        if (limit <= 0) break;
        const page = await rows.page({ table, orderBy, limit, offset });
        if (page.length === 0) break;

        for (const raw of page) {
          // `settings` is the one key-filtered table: a wide key-value store
          // whose keys are declared across ~20 services, so it is filtered by
          // ALLOWLIST rather than denylist. `isBackedUpSettingKey` is what
          // consults FORBIDDEN_SETTING_KEYS, which is the `cached_user_id`
          // tripwire — never test membership of BACKUP_SETTING_KEYS directly.
          if (table === 'settings' && !isBackedUpSettingKey(String(raw.key ?? ''))) {
            continue;
          }
          lines.push(rowToLine(raw));
        }

        taken += page.length;
        offset += page.length;
        if (page.length < limit) break;
      }

      // For `settings` the count above is the whole table; only the filtered
      // rows are written, so `rowsAvailable` must be the filtered total too or
      // the restore UI reports a table as partial when it is complete.
      const available = table === 'settings' ? lines.length : rowsAvailable;

      await append(`${sectionMarker(table, lines.length)}\n`);
      for (const line of lines) await append(`${line}\n`);

      rowsWritten += lines.length;
      stats.push({ table, rows: lines.length, rowsAvailable: Math.max(available, lines.length) });
      onProgress?.({ phase: 'snapshot', table, rowsWritten, bytesWritten: position });
    }
  });

  return { tables: stats, plaintextBytes: position };
}

// ---- phase B: seal --------------------------------------------------------

/**
 * Compresses and encrypts the scratch file into `blob`.
 *
 * The subtlety is the last-frame flag. `writeFrame` needs `isLast` at call
 * time, but pako only reveals that a chunk was the final one by returning from
 * `push(…, true)`. So exactly one chunk is HELD back: when the next chunk
 * arrives the held one is written with `isLast: false`, and after the final
 * push the held one is written with `isLast: true`. Getting this wrong is
 * silent at write time and fatal at restore — never flagging gives every blob
 * `incomplete`, flagging early gives "Data follows the final frame".
 *
 * pako's `onData` is synchronous while `sink.write` is not, so chunks are
 * collected into an array and drained with `await` between pushes rather than
 * written from inside the callback, which would lose both ordering and
 * backpressure.
 */
async function sealSnapshot(
  key: Uint8Array,
  scratch: BlobSource,
  blob: BlobSink,
  header: BackupHeader,
  onProgress: ((progress: ExportProgress) => void) | undefined,
): Promise<number> {
  const writer = new BlobWriter(key, blob, header);
  const produced: Uint8Array[] = [];
  let held: Uint8Array | null = null;

  const deflate = new pako.Deflate({ level: 6 });
  deflate.onData = (chunk: Uint8Array) => {
    produced.push(chunk);
  };

  const drain = async (final: boolean): Promise<void> => {
    while (produced.length > 0) {
      const next = produced.shift() as Uint8Array;
      if (held) {
        await writer.writeFrame(held, false);
        if (writer.bytesWritten > BACKUP_MAX_BYTES) {
          throw new BackupExportError(
            'too-large',
            `Blob exceeded ${BACKUP_MAX_BYTES} bytes and was abandoned`,
          );
        }
        onProgress?.({ phase: 'seal', rowsWritten: 0, bytesWritten: writer.bytesWritten });
      }
      held = next;
    }
    if (final) {
      // An empty held chunk is legitimate for an empty backup: a deflate stream
      // is never zero bytes, but the split across chunks is pako's business.
      await writer.writeFrame(held ?? new Uint8Array(0), true);
      held = null;
    }
  };

  const total = await scratch.size();
  let read = 0;
  do {
    const chunk = await scratch.read(SEAL_READ_BYTES, read);
    read += chunk.length;
    const isFinalRead = read >= total || chunk.length === 0;
    deflate.push(chunk, isFinalRead);
    if (deflate.err) {
      throw new BackupExportError('io', `deflate failed (${deflate.err}): ${deflate.msg}`);
    }
    await drain(isFinalRead);
    if (isFinalRead) break;
  } while (read < total);

  if (!writer.wroteFinalFrame) {
    // Only reachable if `total` is 0 and the loop never ran, which the do/while
    // prevents. Refuse loudly rather than emit a blob that reads `incomplete`.
    throw new BackupExportError('io', 'Sealed a blob with no final frame');
  }
  if (writer.bytesWritten > BACKUP_MAX_BYTES) {
    throw new BackupExportError(
      'too-large',
      `Blob exceeded ${BACKUP_MAX_BYTES} bytes and was abandoned`,
    );
  }
  return writer.bytesWritten;
}

// ---- entry point ----------------------------------------------------------

/**
 * Writes one backup. Throws `BackupExportError` on refusal.
 *
 * The caller owns both files and MUST delete them on a throw: a partial blob
 * has no final frame, so it reads as `incomplete` — correct, but leaving it
 * staged is the same lifecycle hazard P7 exists for.
 */
export async function exportBackup(options: ExportOptions): Promise<ExportResult> {
  const { key, rows, scratch, blob, schemaVersion, appVersion, now, onProgress } = options;

  const { tables, plaintextBytes } = await writeSnapshot(rows, scratch, onProgress);

  const header: BackupHeader = {
    formatVersion: BACKUP_FORMAT_VERSION,
    algo: 'recovery-code-v1',
    schemaVersion,
    appVersion,
    createdAt: now,
    tables,
    plaintextBytes,
  };

  const blobBytes = await sealSnapshot(key, scratch, blob, header, onProgress);
  return { header, blobBytes };
}
