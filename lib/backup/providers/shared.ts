// What the iCloud and Drive adapters have in common, and the two traps in
// `react-native-cloud-storage` that both of them have to route around.
//
// **Trap 1 — `downloadFile` is overloaded, and the wrong overload is a silent
// no-op.** There are two: the deprecated `downloadFile(path, scope?)`, which
// merely TRIGGERS an iCloud sync and copies nothing, and the real
// `downloadFile(remotePath, localPath, scope?)`. TypeScript picks the second
// only because `CloudStorageScope` is a string enum and a plain `string` is not
// assignable to it — which is a coincidence, not a guarantee. Always pass the
// scope as an explicit third argument so the intended overload is the one that
// matches on its arity.
//
// **Trap 2 — argument order is inverted from the port.** `uploadFile` takes
// `(remotePath, localPath, …)`. `BackupProvider.upload` takes
// `(localPath, remotePath)`, matching every other "copy from A to B" in this
// codebase. The swap happens here, once.
//
// Never `writeFile` / `readFile`: both are string-only, so a 25 MB blob would
// be base64'd through JS memory in one piece. `uploadFile` / `downloadFile` are
// file-to-file on both providers.

import {
  CloudStorage,
  CloudStorageError,
  CloudStorageErrorCode,
  CloudStorageScope,
} from 'react-native-cloud-storage';

import type { RestoreRefusal } from '../types';

/**
 * App-data scope on both providers: Drive's hidden `appDataFolder`, matching
 * the `drive.appdata` OAuth scope, and iCloud's app container. The blob is
 * opaque ciphertext with no user-meaningful name, so putting it in the user's
 * visible Documents would be clutter they cannot act on.
 */
export const BACKUP_SCOPE = CloudStorageScope.AppData;

/** Remote directory holding every blob this app writes. */
export const REMOTE_DIRECTORY = '/mera-backup';

export const BLOB_MIME_TYPE = 'application/octet-stream';

export class BackupProviderError extends Error {
  constructor(
    readonly reason: RestoreRefusal,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BackupProviderError';
  }
}

/**
 * Maps a provider failure onto a refusal the UI has a sentence for.
 *
 * Everything that is not provably "the file is not there" becomes
 * `provider-unavailable`, because from the user's side a quota failure, an
 * expired token and a dead network are the same situation: try again later.
 * Reporting one of those as `not-found` would tell them their backup is gone.
 */
export function toRefusal(err: unknown, what: string): BackupProviderError {
  if (err instanceof CloudStorageError) {
    if (
      err.code === CloudStorageErrorCode.FILE_NOT_FOUND ||
      err.code === CloudStorageErrorCode.DIRECTORY_NOT_FOUND
    ) {
      return new BackupProviderError('not-found', `${what}: ${err.message}`, err);
    }
  }
  return new BackupProviderError('provider-unavailable', `${what}: ${String(err)}`, err);
}

/** `mkdir` is not idempotent across providers; an existing directory is fine. */
export async function ensureRemoteDirectory(storage: CloudStorage): Promise<void> {
  try {
    if (await storage.exists(REMOTE_DIRECTORY, BACKUP_SCOPE)) return;
    await storage.mkdir(REMOTE_DIRECTORY, BACKUP_SCOPE);
  } catch (err) {
    if (
      err instanceof CloudStorageError &&
      err.code === CloudStorageErrorCode.FILE_ALREADY_EXISTS
    ) {
      return;
    }
    throw toRefusal(err, 'Could not create the backup directory');
  }
}

export async function uploadTo(
  storage: CloudStorage,
  localPath: string,
  remotePath: string,
): Promise<void> {
  await ensureRemoteDirectory(storage);
  try {
    // Remote FIRST. See trap 2.
    await storage.uploadFile(remotePath, localPath, { mimeType: BLOB_MIME_TYPE }, BACKUP_SCOPE);
  } catch (err) {
    throw toRefusal(err, 'Upload failed');
  }
}

export async function downloadTo(
  storage: CloudStorage,
  remotePath: string,
  localPath: string,
): Promise<void> {
  try {
    // Three arguments, always. See trap 1.
    await storage.downloadFile(remotePath, localPath, BACKUP_SCOPE);
  } catch (err) {
    throw toRefusal(err, 'Download failed');
  }
}

export async function listWithPrefix(
  storage: CloudStorage,
  prefix: string,
): Promise<readonly string[]> {
  try {
    if (!(await storage.exists(REMOTE_DIRECTORY, BACKUP_SCOPE))) return [];
    const names = await storage.readdir(REMOTE_DIRECTORY, BACKUP_SCOPE);
    return names
      .filter((n) => n.startsWith(prefix))
      .map((n) => `${REMOTE_DIRECTORY}/${n}`)
      .sort();
  } catch (err) {
    // An absent directory means no backups, which is a fact and not a failure.
    if (
      err instanceof CloudStorageError &&
      err.code === CloudStorageErrorCode.DIRECTORY_NOT_FOUND
    ) {
      return [];
    }
    throw toRefusal(err, 'Could not list backups');
  }
}

export async function removeRemote(storage: CloudStorage, remotePath: string): Promise<void> {
  try {
    await storage.unlink(remotePath, BACKUP_SCOPE);
  } catch (err) {
    // Deleting something already gone is the outcome the caller wanted.
    if (err instanceof CloudStorageError && err.code === CloudStorageErrorCode.FILE_NOT_FOUND) {
      return;
    }
    throw toRefusal(err, 'Could not delete the backup');
  }
}
