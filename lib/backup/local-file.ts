// Backup to and from a file the user keeps themselves.
//
// **This is the path most people will take**, and it is deliberately NOT a
// `BackupProvider`. That port is `isAvailable/upload/download/list/remove`, and
// a file the user filed away in Files, Drive, or a folder on a laptop has no
// `list` and no stable `remotePath`. Forcing it into the port would mean
// implementing three methods as lies. The interaction model is genuinely
// different: hand a file out once, take a file back in once.
//
// **The consequence is that a file backup cannot be SCHEDULED**, and that is
// not a limitation to work around. The unattended alternative would be writing
// to app-private storage, which the user cannot reach on Android and which is
// deleted with the app — a "backup" that disappears exactly when it is needed.
// So `'file'` never satisfies `scheduledBackupEnabled()`, and the UI shows how
// old the last copy is instead of pretending something refreshes it.
//
// `copyToCacheDirectory: true` on the picker is load-bearing. It hands back a
// `file://` path in the app's own cache; without it Android returns a
// `content://` URI, and this codec does not read a file start to finish — it
// reads the header, then seeks to each frame — which a content URI does not
// reliably support.

import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Directory, Paths } from 'expo-file-system';
import Constants from 'expo-constants';

import appSchema from '@/lib/database/schema';

import { RnfsFile } from './adapters/rnfs-file';
import { watermelonRowSink } from './adapters/watermelon-row-sink';
import { watermelonRowSource } from './adapters/watermelon-row-source';
import {
  BackupServiceError,
  knownColumns,
  remoteFilenameFor,
} from './backup-service';
import { recordBackupRun } from './backup-settings';
import { exportBackup, type ExportProgress } from './export';
import { importBackup, type ImportProgress, type ImportResult } from './import';
import { getBackupKey, isRecoveryCodeConfirmed } from './key-store';
import { BACKUP_SCRATCH_DIRECTORY, type BackupHeader } from './types';

/** Anything, because a backup blob has no registered type on either platform. */
const PICKER_TYPE = '*/*';
const BLOB_MIME_TYPE = 'application/octet-stream';

export interface SaveToFileResult {
  readonly header: BackupHeader;
  readonly blobBytes: number;
}

function ensureDirectory(root: Directory, name: string): Directory {
  const dir = new Directory(root, name);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function pathOf(dir: Directory, name: string): string {
  return `${dir.uri.replace('file://', '')}/${name}`;
}

/**
 * Writes a backup and hands it to the system share sheet.
 *
 * Both files live under `BACKUP_SCRATCH_DIRECTORY`, which
 * `wipeAllLocalUserData()` deletes — a blob left in app storage after a logout
 * is the previous user's whole persona sitting there for the next one.
 *
 * The blob is deleted after sharing. The share sheet has already copied it
 * wherever the user chose by then; keeping our copy would only recreate the
 * leak the wipe exists to close.
 */
export async function saveBackupToFile(
  onProgress?: (progress: ExportProgress) => void,
): Promise<SaveToFileResult> {
  const key = await getBackupKey();
  if (!key) throw new BackupServiceError('no-key', 'Backup is not set up on this device');
  if (!(await isRecoveryCodeConfirmed())) {
    // Same ordering gate as the cloud path: a blob written under a key only the
    // keychain holds becomes unopenable the moment the user logs out.
    throw new BackupServiceError(
      'code-unconfirmed',
      'The recovery code has not been shown and acknowledged yet',
    );
  }

  const now = Date.now();
  const dir = ensureDirectory(Paths.cache, BACKUP_SCRATCH_DIRECTORY);
  const filename = remoteFilenameFor(now);
  const blobFile = await RnfsFile.createEmpty(pathOf(dir, filename));
  const scratchFile = await RnfsFile.createEmpty(pathOf(dir, 'snapshot.ndjson'));

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

    // The cleartext snapshot goes BEFORE the share sheet opens, not in the
    // finally: the sheet can sit open for as long as the user browses folders,
    // and there is no reason for a plaintext copy of the persona to exist for
    // that whole time.
    await scratchFile.remove();

    if (!(await Sharing.isAvailableAsync())) {
      throw new BackupServiceError(
        'provider-unavailable',
        'This device cannot share files',
      );
    }
    await Sharing.shareAsync(`file://${blobFile.path}`, {
      mimeType: BLOB_MIME_TYPE,
      UTI: 'public.data',
      dialogTitle: 'Save your Mera backup',
    });

    // `shareAsync` resolves whether the user saved the file or dismissed the
    // sheet, and neither platform tells us which. So there is deliberately no
    // `shared` flag on the result: a field that is always true is worse than an
    // absent one, because a caller will believe it.
    //
    // The run IS recorded, and that is the lesser of two inaccuracies. If it
    // were only recorded on a confirmed save — which cannot be detected — the
    // staleness prompt would nag forever, including at the people who back up
    // most diligently, and a warning that is always on is a warning nobody
    // reads.
    await recordBackupRun(now);
    return { header, blobBytes };
  } finally {
    await scratchFile.remove();
    await blobFile.remove();
  }
}

/**
 * Restores from a file the user picks. Returns null if they cancel.
 *
 * This is the new-phone path, so it must work with no provider configured and
 * no prior backup on this device — everything it needs is the key, which
 * `adoptRecoveryCode` puts in place from the written-down code.
 */
export async function restoreBackupFromFile(
  onProgress?: (progress: ImportProgress) => void,
): Promise<ImportResult | null> {
  const key = await getBackupKey();
  if (!key) {
    throw new BackupServiceError(
      'no-key',
      'Enter your recovery code before restoring from a file',
    );
  }

  const picked = await DocumentPicker.getDocumentAsync({
    type: PICKER_TYPE,
    // See the header: without this, Android hands back a content:// URI that
    // cannot be seeked, and the codec reads the header then seeks per frame.
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled) return null;

  const asset = picked.assets?.[0];
  if (!asset?.uri) return null;

  const local = new RnfsFile(asset.uri.replace('file://', ''));
  try {
    return await importBackup({
      key,
      blob: local,
      sink: watermelonRowSink,
      knownColumns: knownColumns(),
      schemaVersion: appSchema.version,
      onProgress,
    });
  } finally {
    // The picker's copy lives in OUR cache directory, so it is ours to remove —
    // and it is a decrypted-on-demand copy of the user's whole persona.
    await local.remove();
  }
}
