// Backup & restore — the frozen contract.
//
// Every other file in `lib/backup/` reads this one. It is deliberately free of
// imports from `lib/database`, `lib/stores` and any native module so it can be
// read by tests, by the exporter, by the importer and by the server-side escrow
// without dragging a database or a TurboModule along.
//
// The blob is opaque ciphertext to everyone but the device that wrote it. The
// server stores an escrow record it cannot open; the cloud provider stores a
// file it cannot read. That is the whole point: the privacy invariant in the
// root CLAUDE.md is why the server cannot be the recovery path, so the recovery
// anchor has to be something the user holds.

/** Bumped only for a change that an older reader cannot parse. */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Hard ceiling on a finished blob. Exceeding it is a REPORTED failure, never a
 * silent truncation — a backup that quietly drops the tail is worse than no
 * backup, because the user believes they have one.
 */
export const BACKUP_MAX_BYTES = 25 * 1024 * 1024;

/** How the key that encrypts the blob was derived. */
export type BackupAlgo =
  /** 32 random bytes shown once as a recovery code. No passphrase involved. */
  | 'recovery-code-v1'
  /** Recovery code, additionally escrowed to the server wrapped by a passphrase-derived KEK. */
  | 'recovery-code-v1+passphrase-escrow';

/**
 * KDF parameters, stored in the header so a future reader can derive the same
 * KEK without guessing. The concrete algorithm is chosen by the P0 device spike
 * — this shape is what the spike is allowed to fill in, and nothing downstream
 * may hardcode a cost factor.
 */
export interface KdfParams {
  readonly name: 'scrypt' | 'pbkdf2';
  /** Base64. Per-backup, never reused across users or devices. */
  readonly salt: string;
  /** scrypt N / pbkdf2 iterations. */
  readonly cost: number;
  /** scrypt only. */
  readonly blockSize?: number;
  readonly parallelism?: number;
}

/** One table's contribution to the blob, as written by the exporter. */
export interface BackupTableStat {
  readonly table: string;
  /** Rows actually written, AFTER the per-table cap was applied. */
  readonly rows: number;
  /**
   * Rows the table held before the cap. Greater than `rows` means the backup is
   * intentionally partial for this table, and the restore UI says so rather
   * than implying completeness.
   */
  readonly rowsAvailable: number;
}

/**
 * The cleartext header. Authenticated as AAD over every frame, so tampering
 * with any field here invalidates the whole blob rather than silently changing
 * how it is read.
 *
 * Nothing in here may identify the user. It carries no user id, no email and no
 * device name: an escrow record the server cannot open is worth little if the
 * header next to it says who it belongs to.
 */
export interface BackupHeader {
  readonly formatVersion: number;
  readonly algo: BackupAlgo;
  readonly kdf: KdfParams | null;
  /** WatermelonDB `appSchema.version` the blob was written from. */
  readonly schemaVersion: number;
  /** `app.json` version, for diagnosing a blob written by a much older build. */
  readonly appVersion: string;
  readonly createdAt: number;
  readonly tables: readonly BackupTableStat[];
  /** Uncompressed byte length, so a reader can size its buffers up front. */
  readonly plaintextBytes: number;
}

/** Why a restore was refused. Each maps to its own user-facing message. */
export type RestoreRefusal =
  /** Header failed its AAD check, or a frame failed to authenticate. */
  | 'tampered'
  /** Right blob, wrong key — a mistyped recovery code lands here. */
  | 'wrong-key'
  /** Written by a newer build whose format this one cannot read. */
  | 'format-too-new'
  /** Truncated: the last-frame flag never arrived. */
  | 'incomplete'
  /** Larger than BACKUP_MAX_BYTES, so it was never fully written. */
  | 'too-large'
  /** No blob at the expected path for this device. */
  | 'not-found'
  /** Provider unreachable, signed out, or out of quota. */
  | 'provider-unavailable';

export type RestoreVerdict =
  | { readonly ok: true; readonly header: BackupHeader }
  | { readonly ok: false; readonly reason: RestoreRefusal };

/**
 * The provider seam. iCloud and Google Drive both satisfy it; tests use an
 * in-memory double. Nothing above this interface may reference CloudStorage,
 * GoogleSignin or any provider-specific type — that is what keeps the
 * export/import engines buildable and testable before the native modules are
 * installed, and portable if a provider is ever swapped.
 */
export interface BackupProvider {
  readonly id: 'icloud' | 'google-drive';
  /**
   * Runtime condition, never a build one. The user may be signed out, out of
   * quota, or have the provider disabled for this app. Never infer
   * availability from the platform.
   */
  isAvailable(): Promise<boolean>;
  upload(localPath: string, remotePath: string): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
  remove(remotePath: string): Promise<void>;
}

/** User-configured cadence. `off` unregisters the task rather than no-opping. */
export type BackupCadence = 'off' | 'daily' | 'weekly' | 'manual';
