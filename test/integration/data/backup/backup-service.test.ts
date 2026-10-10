// One backup end to end: key store (real, over the stateful keychain) -> real export from the
// in-memory DB -> real RnfsFile (over the RNFS byte-store fake) -> the real iCloud provider (over
// the cloud-storage fake, whose remote keeps the bytes) -> prune; and the inverse.
//
// Replaces lib/backup/__tests__/backup-service.test.ts (all 17 `it`). The legacy suite mocked the
// codec, the key store, the adapters and the schema; every one of those is real here.
import { File, Paths } from 'expo-file-system';

import { BACKUP_TABLES } from '@/lib/backup/allowlist';
import { MemoryFile } from '@/test/unit/data/backup/memory-file';
import { restoreWasInterrupted } from '@/lib/backup/adapters/watermelon-row-sink';
import {
  BACKUP_KEEP_COUNT,
  BackupServiceError,
  REMOTE_FILENAME_PREFIX,
  knownColumns,
  listBackups,
  remoteFilenameFor,
  runBackup,
  runRestore,
  verifyProviderAccess,
} from '@/lib/backup/backup-service';
import {
  BACKUP_KEY_ITEM,
  adoptRecoveryCode,
  clearBackupKey,
  ensureBackupKey,
  getBackupKey,
  getRecoveryCode,
  isRecoveryCodeConfirmed,
  markRecoveryCodeConfirmed,
} from '@/lib/backup/key-store';
import { icloudProvider } from '@/lib/backup/providers/icloud';
import { REMOTE_DIRECTORY } from '@/lib/backup/providers/shared';
import { createdAtFromRemoteFilename } from '@/lib/backup/remote-names';
import {
  BACKUP_DOCUMENT_DIRECTORY,
  BACKUP_SCRATCH_DIRECTORY,
  type BackupProvider,
} from '@/lib/backup/types';
import appSchema from '@/lib/database/schema';
import { addFact, deleteFact } from '@/lib/database/services/fact-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import NetInfo from '@react-native-community/netinfo';

import { runScheduledBackup } from '@/lib/background/backup-task';
import logger from '@/lib/logger';
import { failSecureStore, secureStoreDump } from '@/test/helpers';
import { resetFileSystem } from '@/test/helpers/fs';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@dr.pogodin/react-native-fs', () => require('./fakes').rnfsModule);
jest.mock('react-native-cloud-storage', () => require('./fakes').cloudStorageModule);

import { callsTo, putRemote, remoteBytes, remoteNames, resetFakes, shared } from './fakes';
import {
  OTHER_KEY,
  decode,
  rawRows,
  refusalOf,
  sealedByHand,
  section,
  seedDevice,
  settingsMap,
  stat,
} from './support';

beforeEach(() => {
  resetFakes();
  resetFileSystem();
});

/** A device that has finished backup setup: a key, and the recovery code acknowledged. */
async function setUpBackup(): Promise<void> {
  await ensureBackupKey();
  await markRecoveryCodeConfirmed();
}

/** The blob the provider holds, wrapped so the test decoder can read it. */
function remoteBlob(path: string): MemoryFile {
  const blob = new MemoryFile();
  blob.bytes = new Uint8Array(remoteBytes(path)!);
  return blob;
}

const oldName = (day: number) => `${REMOTE_DIRECTORY}/${remoteFilenameFor(Date.UTC(2020, 0, day))}`;

describe('the ordering gate', () => {
  it('refuses to upload before the recovery code has been acknowledged', async () => {
    await ensureBackupKey();

    await expect(runBackup(icloudProvider)).rejects.toMatchObject({ reason: 'code-unconfirmed' });

    // Nothing was exported and nothing left the device. A blob uploaded under a key only the
    // keychain holds is unopenable the moment the user logs out.
    expect(callsTo('uploadFile')).toHaveLength(0);
    expect(remoteNames()).toEqual([]);
    expect(shared.created).toEqual([]);
  });

  it('refuses when no key has been set up', async () => {
    await expect(runBackup(icloudProvider)).rejects.toMatchObject({ reason: 'no-key' });
    expect(shared.created).toEqual([]);
  });

  it('refuses an unavailable provider before doing the expensive part', async () => {
    await setUpBackup();
    shared.icloudAvailable = false;

    await expect(runBackup(icloudProvider)).rejects.toMatchObject({ reason: 'provider-unavailable' });

    expect(shared.created).toEqual([]);
    expect(callsTo('uploadFile')).toHaveLength(0);
  });

  it('is a BackupServiceError carrying its reason', async () => {
    const err = await runBackup(icloudProvider).catch((e) => e);
    expect(err).toBeInstanceOf(BackupServiceError);
    expect(err.name).toBe('BackupServiceError');
    expect(err.reason).toBe('no-key');
  });
});

describe('the scheduled backup meets a keychain that cannot be read', () => {
  // A locked keychain (before the first unlock after a reboot) is a normal state of a phone that
  // wakes overnight, like "not set up": it needs nothing fixed, so it should not file an event.
  async function scheduleDaily(): Promise<void> {
    await setUpBackup();
    await setSetting('backup_cadence', 'daily');
    await setSetting('backup_provider', 'icloud');
    (NetInfo.fetch as unknown as jest.Mock).mockResolvedValueOnce({ type: 'wifi' });
    failSecureStore(BACKUP_KEY_ITEM, 'get', new Error('keychain locked'));
  }

  function spyLogger() {
    return {
      capture: jest.spyOn(logger, 'captureException').mockImplementation(() => undefined as never),
      crumb: jest.spyOn(logger, 'addBreadcrumb'),
    };
  }

  it('DA40: an unreadable keychain exits quietly, with no captured exception', async () => {
    await scheduleDaily();
    const { capture, crumb } = spyLogger();
    try {
      await runScheduledBackup();
      expect(capture).not.toHaveBeenCalled();
      expect(crumb).toHaveBeenCalled();
    } finally {
      capture.mockRestore();
      crumb.mockRestore();
    }
  });

  it('a device with no key set up exits on a breadcrumb alone', async () => {
    await setSetting('backup_cadence', 'daily');
    await setSetting('backup_provider', 'icloud');
    (NetInfo.fetch as unknown as jest.Mock).mockResolvedValueOnce({ type: 'wifi' });
    const { capture, crumb } = spyLogger();
    try {
      await runScheduledBackup();
      expect(capture).not.toHaveBeenCalled();
      expect(crumb).toHaveBeenCalledWith('backup: not set up on this device', 'backup-task', { reason: 'no-key' }, 'warning');
    } finally {
      capture.mockRestore();
      crumb.mockRestore();
    }
  });
});

describe('a backup, uploaded and opened again', () => {
  it('uploads a blob that opens under the stored key and describes the device', async () => {
    await seedDevice();
    await setUpBackup();
    const before = Date.now();

    const result = await runBackup(icloudProvider);

    expect(remoteNames()).toEqual([result.remotePath]);
    expect(remoteBytes(result.remotePath)!.length).toBe(result.blobBytes);
    expect(result.remotePath).toBe(`${REMOTE_DIRECTORY}/${remoteFilenameFor(result.header.createdAt)}`);
    expect(result.header.createdAt).toBeGreaterThanOrEqual(before);

    const decoded = await decode(remoteBlob(result.remotePath), (await getBackupKey())!);
    expect(decoded.header).toMatchObject({ createdAt: result.header.createdAt, schemaVersion: appSchema.version });
    expect(decoded.sections.find((s) => s.table === 'facts')?.rows).toHaveLength(2);
  });

  it('writes the blob and the cleartext scratch file only under the directories the wipe deletes', async () => {
    await setUpBackup();
    await runBackup(icloudProvider);

    const [blobPath, scratchPath] = shared.created;
    expect(blobPath).toMatch(new RegExp(`^/document/${BACKUP_DOCUMENT_DIRECTORY}/${REMOTE_FILENAME_PREFIX}`));
    expect(scratchPath).toBe(`/cache/${BACKUP_SCRATCH_DIRECTORY}/snapshot.ndjson`);
    // RNFS wants a plain path, not a file:// URI
    for (const path of shared.created) expect(path.startsWith('file://')).toBe(false);
    // and it is the staged blob the provider was handed
    expect(callsTo('uploadFile')[0].args[1]).toBe(blobPath);
  });

  it('deletes both the blob and the cleartext scratch file after a success', async () => {
    await seedDevice();
    await setUpBackup();
    await runBackup(icloudProvider);
    expect(shared.created).toHaveLength(2);
    expect(shared.disk.size).toBe(0);
  });

  it('deletes them when the upload throws, too', async () => {
    await seedDevice();
    await setUpBackup();
    shared.failOn = { method: 'uploadFile', code: 'ERR_QUOTA' };

    await expect(runBackup(icloudProvider)).rejects.toMatchObject({ reason: 'provider-unavailable' });

    // the scratch file is the persona in CLEARTEXT: no reason to survive a failure
    expect(shared.created).toHaveLength(2);
    expect(shared.disk.size).toBe(0);
    expect(remoteNames()).toEqual([]);
  });

  it('clears a blob an earlier, interrupted run left in the document directory', async () => {
    await setUpBackup();
    const stale = new File(Paths.document, BACKUP_DOCUMENT_DIRECTORY, 'mera-backup-old.bin');
    stale.create();
    expect(stale.exists).toBe(true);

    await runBackup(icloudProvider);

    expect(stale.exists).toBe(false);
  });

  it('reports export progress table by table, in allowlist order, with rows written only growing', async () => {
    await seedDevice();
    await setUpBackup();
    const seen: { table?: string; rowsWritten: number }[] = [];

    await runBackup(icloudProvider, (p) => {
      if (p.phase === 'snapshot') seen.push({ table: p.table, rowsWritten: p.rowsWritten });
    });

    expect(seen.map((p) => p.table)).toEqual([...BACKUP_TABLES]);
    expect(seen.map((p) => p.rowsWritten)).toEqual([...seen.map((p) => p.rowsWritten)].sort((a, b) => a - b));
    expect(seen[seen.length - 1].rowsWritten).toBeGreaterThan(0);
  });
});

describe('restore', () => {
  it('puts the persona back from the cloud after the device changed', async () => {
    const seeded = await seedDevice();
    await setUpBackup();
    const { remotePath } = await runBackup(icloudProvider);
    const factsBefore = (await rawRows('facts')).map((r) => r.statement);

    await addFact('I cycle to work');
    await deleteFact(seeded.factIds[0]);
    await setSetting('app_language', 'fr');

    const progress: number[] = [];
    const result = await runRestore(icloudProvider, remotePath, (p) => progress.push(p.rowsRestored));

    expect((await rawRows('facts')).map((r) => r.statement).sort()).toEqual([...factsBefore].sort());
    expect((await settingsMap()).app_language).toBe('de');
    expect(result.perTable.facts).toBe(2);
    expect(progress[progress.length - 1]).toBe(result.rowsRestored);
    expect(await restoreWasInterrupted()).toBe(false);
  });

  it('downloads before it imports, with the copying overload of downloadFile', async () => {
    await seedDevice();
    await setUpBackup();
    const { remotePath } = await runBackup(icloudProvider);

    await runRestore(icloudProvider, remotePath);

    // the 2-argument overload copies nothing; a restore that got this far read real bytes
    const [download] = callsTo('downloadFile');
    expect(download.args).toHaveLength(3);
    expect(download.args[0]).toBe(remotePath);
    expect(download.args[1]).toBe(`/cache/${BACKUP_SCRATCH_DIRECTORY}/restore.bin`);
  });

  it('hands the importer the LIVE schema, so a column from a newer build is dropped and named', async () => {
    await setUpBackup();
    const path = `${REMOTE_DIRECTORY}/${remoteFilenameFor(1_700_000_000_000)}`;
    const blob = await sealedByHand(
      section('facts', [{ id: 'f1', statement: 'a', a_column_from_the_future: 1 }]),
      { schemaVersion: appSchema.version + 100, tables: [stat('facts', 1)] },
      { key: (await getBackupKey())! },
    );
    putRemote(path, blob.bytes);

    const result = await runRestore(icloudProvider, path);

    expect(result.droppedColumns).toEqual({ facts: ['a_column_from_the_future'] });
    expect(result.fromNewerSchema).toBe(true);
  });

  it('knows its columns from the live schema, table by table', () => {
    const columns = knownColumns();
    expect(Object.keys(columns).sort()).toEqual(Object.keys(appSchema.tables).sort());
    expect(columns.facts).toContain('statement');
    expect(columns.settings).toEqual(['key', 'value']);
  });

  it('refuses without a key', async () => {
    await expect(runRestore(icloudProvider, `${REMOTE_DIRECTORY}/x.bin`)).rejects.toMatchObject({ reason: 'no-key' });
    expect(callsTo('downloadFile')).toHaveLength(0);
  });

  it('refuses a blob sealed under another key, before touching the device, and removes the download', async () => {
    await seedDevice();
    await setUpBackup();
    const before = await rawRows('facts');
    const path = `${REMOTE_DIRECTORY}/${remoteFilenameFor(1_700_000_000_000)}`;
    putRemote(path, (await sealedByHand(section('facts', [{ id: 'f1', statement: 'x' }]), { tables: [stat('facts', 1)] }, { key: OTHER_KEY })).bytes);

    expect(await refusalOf(() => runRestore(icloudProvider, path))).toBe('wrong-key');

    expect(await rawRows('facts')).toEqual(before);
    expect(shared.disk.size).toBe(0);
  });

  it('reports a missing remote file as not-found and removes the download', async () => {
    await setUpBackup();
    putRemote(`${REMOTE_DIRECTORY}/${remoteFilenameFor(1)}`, new Uint8Array([1]));

    expect(await refusalOf(() => runRestore(icloudProvider, `${REMOTE_DIRECTORY}/gone.bin`))).toBe('not-found');
    expect(shared.disk.size).toBe(0);
  });

  it('deletes the downloaded blob after a restore throws part way', async () => {
    await setUpBackup();
    const path = `${REMOTE_DIRECTORY}/${remoteFilenameFor(1_700_000_000_000)}`;
    putRemote(path, (await sealedByHand('this is not json\n', {}, { key: (await getBackupKey())! })).bytes);

    expect(await refusalOf(() => runRestore(icloudProvider, path))).toBe('tampered');

    expect(shared.disk.size).toBe(0);
  });

  it('refuses a file that is not a backup at all', async () => {
    await setUpBackup();
    const path = `${REMOTE_DIRECTORY}/${remoteFilenameFor(1_700_000_000_000)}`;
    putRemote(path, new Uint8Array([1, 2]));
    expect(await refusalOf(() => runRestore(icloudProvider, path))).toBe('incomplete');
  });
});

describe('remote naming and retention', () => {
  it('reads the creation time back out of a blob name, and ignores names that are not ours', () => {
    const t = Date.UTC(2026, 8, 23, 21, 14, 5, 123);
    expect(createdAtFromRemoteFilename(`/mera-backup/${remoteFilenameFor(t)}`)).toBe(t);
    expect(createdAtFromRemoteFilename('notes.txt')).toBeNull();
    expect(createdAtFromRemoteFilename('mera-backup-garbage.bin')).toBeNull();
  });

  it('names a blob by timestamp and nothing else', () => {
    const name = remoteFilenameFor(Date.UTC(2026, 7, 17, 12, 34, 56));
    expect(name).toBe(`${REMOTE_FILENAME_PREFIX}2026-08-17T12-34-56-000Z.bin`);
    // no user id, no email, no device name: the cloud account may be shared with other people
    expect(name).not.toMatch(/@|user|device/i);
  });

  it('lists backups newest first, whatever order the cloud returns them', async () => {
    putRemote(`${REMOTE_DIRECTORY}/${remoteFilenameFor(Date.UTC(2026, 7, 1))}`, new Uint8Array(1));
    putRemote(`${REMOTE_DIRECTORY}/${remoteFilenameFor(Date.UTC(2026, 7, 17))}`, new Uint8Array(1));
    putRemote(`${REMOTE_DIRECTORY}/${remoteFilenameFor(Date.UTC(2026, 7, 9))}`, new Uint8Array(1));
    putRemote(`${REMOTE_DIRECTORY}/notes.txt`, new Uint8Array(1));

    const listed = await listBackups(icloudProvider);

    expect(listed).toHaveLength(3);
    expect(listed[0]).toContain('2026-08-17');
    expect(listed[2]).toContain('2026-08-01');
  });

  it('prunes down to the keep count after a successful upload, oldest first', async () => {
    await setUpBackup();
    for (let day = 1; day <= BACKUP_KEEP_COUNT + 1; day += 1) putRemote(oldName(day), new Uint8Array(1));

    const { remotePath } = await runBackup(icloudProvider);

    expect(BACKUP_KEEP_COUNT).toBe(3);
    // five blobs held, two removed: the two oldest
    expect(remoteNames()).toEqual([oldName(3), oldName(4), remotePath].sort());
    expect(callsTo('unlink').map((c) => c.args[0])).toEqual([oldName(2), oldName(1)]);
  });

  it('does not prune when the upload failed, so the last good backups survive', async () => {
    await setUpBackup();
    for (let day = 1; day <= BACKUP_KEEP_COUNT + 1; day += 1) putRemote(oldName(day), new Uint8Array(1));
    shared.failOn = { method: 'uploadFile', code: 'ERR_QUOTA' };

    await expect(runBackup(icloudProvider)).rejects.toBeDefined();

    expect(callsTo('unlink')).toHaveLength(0);
    expect(remoteNames()).toHaveLength(BACKUP_KEEP_COUNT + 1);
  });

  it('does not fail a backup that was taken just because pruning failed', async () => {
    await setUpBackup();
    shared.failOn = { method: 'readdir', code: 'ERR_OFFLINE' };

    // untidy cloud storage beats losing the backup the user just took
    const result = await runBackup(icloudProvider);

    expect(result.blobBytes).toBeGreaterThan(0);
    expect(remoteNames()).toEqual([result.remotePath]);
  });
});

describe('verifyProviderAccess', () => {
  it('passes on an empty cloud: "no backups yet" is the expected state after setup', async () => {
    await expect(verifyProviderAccess(icloudProvider)).resolves.toBeUndefined();
  });

  it('refuses with the provider\'s own reason when the listing fails', async () => {
    shared.failOn = { method: 'exists', code: 'ERR_FILE_NOT_FOUND' };
    await expect(verifyProviderAccess(icloudProvider)).rejects.toMatchObject({
      name: 'BackupServiceError',
      reason: 'not-found',
    });
  });

  it('calls any other failure provider-unavailable', async () => {
    const failing: BackupProvider = {
      ...icloudProvider,
      list: async () => {
        throw new Error('403 insufficient scope');
      },
    };
    const err = await verifyProviderAccess(failing).catch((e) => e);
    expect(err.reason).toBe('provider-unavailable');
    expect(err.message).toContain('403 insufficient scope');
  });
});

describe('the key store the service reads', () => {
  it('mints one key and keeps it: asking again must not orphan existing blobs', async () => {
    const first = await ensureBackupKey();
    expect(await ensureBackupKey()).toBe(first);
    expect(await getRecoveryCode()).toBe(first);
    expect(secureStoreDump()[BACKUP_KEY_ITEM]).toBe(first);
    expect((await getBackupKey())!.length).toBe(32);
  });

  it('adopts a typed recovery code in canonical form and counts it as acknowledged', async () => {
    const code = await ensureBackupKey();
    await clearBackupKey();
    expect(await isRecoveryCodeConfirmed()).toBe(false);

    expect(await adoptRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(true);

    expect(await getRecoveryCode()).toBe(code);
    expect(await isRecoveryCodeConfirmed()).toBe(true);
    expect(await adoptRecoveryCode('not a code')).toBe(false);
  });

  it('forgets the key and the acknowledgement, after which a backup is refused as not set up', async () => {
    await setUpBackup();
    await clearBackupKey();
    expect(await getSetting('backup_recovery_code_confirmed')).toBeNull();
    await expect(runBackup(icloudProvider)).rejects.toMatchObject({ reason: 'no-key' });
  });
});
