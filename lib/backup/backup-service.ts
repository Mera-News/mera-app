// One backup, end to end: key → export → upload → prune, and its inverse.
//
// **The precondition that matters is the ordering one.** `runBackup` refuses
// until the user has been shown and has acknowledged their recovery code.
// Without that gate the sequence is: a scheduled backup fires, uploads under a
// key only the keychain holds, the user logs out, `wipeAllLocalUserData()`
// clears the keychain — and the cloud now holds a blob nobody on earth can
// open, which the user believes is their backup. The same shape as shipping an
// OTA before the flag it depends on: each half is correct and the order is the
// bug.
//
// **Every local path comes from `BACKUP_DOCUMENT_DIRECTORY` and
// `BACKUP_SCRATCH_DIRECTORY`.** Those are the two directories
// `wipeAllLocalUserData()` deletes. A path chosen here instead would mean the
// wipe covers nothing, with no test failing — it would still delete two
// directories, they would just be empty.
//
// **Remote filenames carry a timestamp and nothing else**, for the same reason
// `BackupHeader` holds no user id: the blob may sit in a cloud account shared
// with other people, and a filename that names its owner leaks what the
// ciphertext protects.

import { Directory, Paths } from 'expo-file-system';
import Constants from 'expo-constants';

import appSchema from '@/lib/database/schema';
import logger from '@/lib/logger';

import { RnfsFile } from './adapters/rnfs-file';
import { watermelonRowSink } from './adapters/watermelon-row-sink';
import { watermelonRowSource } from './adapters/watermelon-row-source';
import { exportBackup, type ExportProgress } from './export';
import { importBackup, inspectBackup, type ImportProgress, type ImportResult } from './import';
import { getBackupKey, isRecoveryCodeConfirmed } from './key-store';
import { REMOTE_DIRECTORY } from './providers/shared';
import {
  BACKUP_DOCUMENT_DIRECTORY,
  BACKUP_SCRATCH_DIRECTORY,
  type BackupHeader,
  type BackupProvider,
  type RestoreRefusal,
} from './types';

/** Blobs kept in the cloud. Older ones are pruned after a successful upload. */
export const BACKUP_KEEP_COUNT = 3;

/** Every blob this app writes starts with this, and `list` filters on it. */
export const REMOTE_FILENAME_PREFIX = 'mera-backup-';

export class BackupServiceError extends Error {
  constructor(
    readonly reason: RestoreRefusal | 'no-key' | 'code-unconfirmed',
    message: string,
  ) {
    super(message);
    this.name = 'BackupServiceError';
  }
}

export interface BackupRunResult {
  readonly header: BackupHeader;
  readonly blobBytes: number;
  readonly remotePath: string;
}

/** Timestamp only. No user id, no device name, no email. */
export function remoteFilenameFor(createdAt: number): string {
  return `${REMOTE_FILENAME_PREFIX}${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}.bin`;
}

/** RNFS wants a plain path; expo-file-system hands back a `file://` URI. */
function pathOf(dir: Directory, name: string): string {
  return `${dir.uri.replace('file://', '')}/${name}`;
}

function ensureDirectory(root: Directory, name: string): Directory {
  const dir = new Directory(root, name);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Empties the blob directory before writing a new one.
 *
 * The `finally` in `runBackup` handles the normal path, but it only runs if
 * code runs: a suspended process or an expired background task leaves the blob
 * behind, and each one is up to `BACKUP_MAX_BYTES` of the user's persona
 * sitting in app storage until the next logout wipe. Every file in here is
 * either a finished upload that should already be gone or an abandoned
 * attempt, and the directory is ours alone, so clearing it is unconditional.
 */
function clearStaleBlobs(dir: Directory): void {
  try {
    for (const entry of dir.list()) {
      try {
        entry.delete();
      } catch {
        // One undeletable file must not stop the backup that is about to run.
      }
    }
  } catch {
    // An unlistable directory is not a reason to refuse a backup.
  }
}

/** Column names per table, from the LIVE schema, for the importer's drift check. */
export function knownColumns(): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [table, def] of Object.entries(appSchema.tables)) {
    out[table] = Object.keys((def as { columns: Record<string, unknown> }).columns);
  }
  return out;
}

// ---- backup ---------------------------------------------------------------

export async function runBackup(
  provider: BackupProvider,
  onProgress?: (progress: ExportProgress) => void,
): Promise<BackupRunResult> {
  const key = await getBackupKey();
  if (!key) {
    throw new BackupServiceError('no-key', 'Backup is not set up on this device');
  }
  if (!(await isRecoveryCodeConfirmed())) {
    // The ordering gate. See the header.
    throw new BackupServiceError(
      'code-unconfirmed',
      'The recovery code has not been shown and acknowledged yet',
    );
  }
  if (!(await provider.isAvailable())) {
    throw new BackupServiceError(
      'provider-unavailable',
      `${provider.id} is not available on this device right now`,
    );
  }

  const now = Date.now();
  const blobDir = ensureDirectory(Paths.document, BACKUP_DOCUMENT_DIRECTORY);
  clearStaleBlobs(blobDir);
  const scratchDir = ensureDirectory(Paths.cache, BACKUP_SCRATCH_DIRECTORY);
  const filename = remoteFilenameFor(now);
  const blobFile = await RnfsFile.createEmpty(pathOf(blobDir, filename));
  const scratchFile = await RnfsFile.createEmpty(pathOf(scratchDir, 'snapshot.ndjson'));

  try {
    const { header, blobBytes } = await exportBackup({
      key,
      rows: watermelonRowSource,
      scratch: scratchFile,
      blob: blobFile,
      schemaVersion: appSchema.version,
      appVersion: Constants.expoConfig?.version ?? 'unknown',
      now,
      onProgress,
    });

    const remotePath = `${REMOTE_DIRECTORY}/${filename}`;
    await provider.upload(blobFile.path, remotePath);
    await pruneOldBackups(provider);
    return { header, blobBytes, remotePath };
  } finally {
    // Both always. The scratch file is the persona in CLEARTEXT, and the local
    // blob is the leak P7 exists to close — neither has any reason to outlive
    // this call, successful or not.
    await scratchFile.remove();
    await blobFile.remove();
  }
}

/** Newest first, so the restore screen can offer the most recent by default. */
export async function listBackups(provider: BackupProvider): Promise<readonly string[]> {
  const paths = await provider.list(REMOTE_FILENAME_PREFIX);
  // The filename is an ISO timestamp with `:` and `.` swapped for `-`, so it
  // sorts lexicographically in chronological order.
  return [...paths].sort().reverse();
}

async function pruneOldBackups(provider: BackupProvider): Promise<void> {
  try {
    const all = await listBackups(provider);
    for (const stale of all.slice(BACKUP_KEEP_COUNT)) {
      await provider.remove(stale);
    }
  } catch (err) {
    // A failed prune leaves extra blobs in the user's cloud storage. That is
    // untidy; failing the backup they just took over it would be worse.
    logger.addBreadcrumb(
      'backup: pruning old blobs failed',
      'backup-service',
      { message: err instanceof Error ? err.message : String(err) },
      'warning',
    );
  }
}

/**
 * One real round trip against the provider, run at the END of setup.
 *
 * Sign-in succeeding does not prove the `drive.appdata` grant landed, and a
 * token without that scope fails nothing until the first actual upload — which
 * is a background task at 3am that nobody is watching. Listing is the cheapest
 * call that genuinely exercises the grant: it reaches the API, so a missing
 * scope 403s here, during setup, while the user is looking at the screen.
 *
 * An EMPTY result is a pass. "No backups yet" is the expected state for someone
 * who has just finished setting up.
 */
export async function verifyProviderAccess(provider: BackupProvider): Promise<void> {
  try {
    await provider.list(REMOTE_FILENAME_PREFIX);
  } catch (err) {
    const reason = (err as { reason?: RestoreRefusal })?.reason ?? 'provider-unavailable';
    throw new BackupServiceError(
      reason,
      `Could not reach ${provider.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---- restore --------------------------------------------------------------

/**
 * Header of a remote blob, for the restore preview. Downloads and decrypts
 * nothing beyond the cleartext header, so "backup from <date>, 1,204 facts" is
 * cheap — but for the same reason it is NOT proof the key is right. Only
 * `runRestore` can tell you that.
 */
export async function inspectRemoteBackup(
  provider: BackupProvider,
  remotePath: string,
): Promise<BackupHeader> {
  const key = await getBackupKey();
  if (!key) throw new BackupServiceError('no-key', 'Backup is not set up on this device');

  const scratchDir = ensureDirectory(Paths.cache, BACKUP_SCRATCH_DIRECTORY);
  const local = new RnfsFile(pathOf(scratchDir, 'inspect.bin'));
  try {
    await provider.download(remotePath, local.path);
    return await inspectBackup(key, local);
  } finally {
    await local.remove();
  }
}

export async function runRestore(
  provider: BackupProvider,
  remotePath: string,
  onProgress?: (progress: ImportProgress) => void,
): Promise<ImportResult> {
  const key = await getBackupKey();
  if (!key) throw new BackupServiceError('no-key', 'Backup is not set up on this device');

  const scratchDir = ensureDirectory(Paths.cache, BACKUP_SCRATCH_DIRECTORY);
  const local = new RnfsFile(pathOf(scratchDir, 'restore.bin'));

  try {
    await provider.download(remotePath, local.path);
    return await importBackup({
      key,
      blob: local,
      sink: watermelonRowSink,
      knownColumns: knownColumns(),
      schemaVersion: appSchema.version,
      onProgress,
    });
  } finally {
    await local.remove();
  }
}
