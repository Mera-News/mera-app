// The orchestration, and above all the ORDERING GATE.
//
// A backup taken before the user has been shown their recovery code produces a
// blob in the cloud that nobody can ever open: the key exists only in the
// keychain, and the next logout wipes the keychain. The user is left believing
// they have a backup. Each half of that sequence is correct on its own; the
// order is the bug, which is exactly why it needs a test rather than a comment.
//
// The second thing here is duller and just as load-bearing: every local path
// must sit under the two directories `wipeAllLocalUserData()` deletes. A path
// chosen freehand would mean the wipe covers nothing while still deleting two
// (empty) directories, and no test anywhere would fail.

const mockCreatedDirs: string[] = [];
const mockFiles: { path: string; removed: boolean }[] = [];

jest.mock('expo-file-system', () => {
  class Directory {
    uri: string;
    constructor(parent: { uri: string } | string, name: string) {
      const base = typeof parent === 'string' ? parent : parent.uri;
      this.uri = `${base}${name}`;
    }
    get exists() {
      return mockCreatedDirs.includes(this.uri);
    }
    create() {
      mockCreatedDirs.push(this.uri);
    }
  }
  return { Directory, Paths: { document: { uri: 'file:///doc/' }, cache: { uri: 'file:///cache/' } } };
});

jest.mock('../adapters/rnfs-file', () => {
  class RnfsFile {
    path: string;
    constructor(path: string) {
      this.path = path;
      mockFiles.push({ path, removed: false });
    }
    static async createEmpty(path: string) {
      return new RnfsFile(path);
    }
    async remove() {
      const entry = mockFiles.find((f) => f.path === this.path);
      if (entry) entry.removed = true;
    }
    async write() {}
    async read() {
      return new Uint8Array(0);
    }
    async size() {
      return 0;
    }
  }
  return { RnfsFile };
});

const mockExportBackup = jest.fn(async (_options?: unknown) => ({
  header: { createdAt: 1, tables: [], plaintextBytes: 0 },
  blobBytes: 1234,
}));
jest.mock('../export', () => ({ exportBackup: (o: unknown) => mockExportBackup(o) }));

const mockImportBackup = jest.fn(async (_options?: unknown) => ({ rowsRestored: 7 }));
const mockInspectBackup = jest.fn(async (_key?: unknown, _blob?: unknown) => ({ createdAt: 1, tables: [] }));
jest.mock('../import', () => ({
  importBackup: (o: unknown) => mockImportBackup(o),
  inspectBackup: (k: unknown, b: unknown) => mockInspectBackup(k, b),
}));

const mockGetBackupKey = jest.fn(async (): Promise<Uint8Array | null> => new Uint8Array(32));
const mockIsConfirmed = jest.fn(async () => true);
jest.mock('../key-store', () => ({
  getBackupKey: () => mockGetBackupKey(),
  isRecoveryCodeConfirmed: () => mockIsConfirmed(),
}));

jest.mock('../adapters/watermelon-row-source', () => ({ watermelonRowSource: {} }));
jest.mock('../adapters/watermelon-row-sink', () => ({ watermelonRowSink: {} }));
jest.mock('@/lib/database/schema', () => ({
  __esModule: true,
  default: {
    version: 53,
    tables: { facts: { columns: { statement: {}, created_at: {} } } },
  },
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.3.0' } } }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { addBreadcrumb: jest.fn(), captureException: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import {
  BACKUP_KEEP_COUNT,
  REMOTE_FILENAME_PREFIX,
  listBackups,
  remoteFilenameFor,
  runBackup,
  runRestore,
} from '../backup-service';
import {
  BACKUP_DOCUMENT_DIRECTORY,
  BACKUP_SCRATCH_DIRECTORY,
  type BackupProvider,
} from '../types';

function makeProvider(overrides: Partial<BackupProvider> = {}): BackupProvider {
  return {
    id: 'icloud',
    isAvailable: jest.fn(async () => true),
    upload: jest.fn(async () => {}),
    download: jest.fn(async () => {}),
    list: jest.fn(async () => []),
    remove: jest.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreatedDirs.length = 0;
  mockFiles.length = 0;
  mockGetBackupKey.mockResolvedValue(new Uint8Array(32));
  mockIsConfirmed.mockResolvedValue(true);
});

describe('the ordering gate', () => {
  it('refuses to upload before the recovery code has been acknowledged', async () => {
    mockIsConfirmed.mockResolvedValue(false);
    const provider = makeProvider();

    await expect(runBackup(provider)).rejects.toMatchObject({ reason: 'code-unconfirmed' });

    // Nothing was exported and nothing left the device. A blob uploaded under a
    // key only the keychain holds becomes unopenable the moment the user logs
    // out, and they would believe they had a backup.
    expect(mockExportBackup).not.toHaveBeenCalled();
    expect(provider.upload).not.toHaveBeenCalled();
  });

  it('refuses when no key has been set up', async () => {
    mockGetBackupKey.mockResolvedValue(null);
    await expect(runBackup(makeProvider())).rejects.toMatchObject({ reason: 'no-key' });
    expect(mockExportBackup).not.toHaveBeenCalled();
  });

  it('refuses an unavailable provider before doing the expensive part', async () => {
    const provider = makeProvider({ isAvailable: jest.fn(async () => false) });
    await expect(runBackup(provider)).rejects.toMatchObject({ reason: 'provider-unavailable' });
    expect(mockExportBackup).not.toHaveBeenCalled();
  });
});

describe('local paths are the ones the wipe deletes', () => {
  it('writes the blob under the document backup directory', async () => {
    await runBackup(makeProvider());
    expect(mockFiles.some((f) => f.path.includes(`/doc/${BACKUP_DOCUMENT_DIRECTORY}/`))).toBe(true);
  });

  it('writes the plaintext scratch file under the cache scratch directory', async () => {
    await runBackup(makeProvider());
    expect(mockFiles.some((f) => f.path.includes(`/cache/${BACKUP_SCRATCH_DIRECTORY}/`))).toBe(true);
  });

  it('hands RNFS a plain path, not a file:// URI', async () => {
    await runBackup(makeProvider());
    for (const f of mockFiles) expect(f.path.startsWith('file://')).toBe(false);
  });
});

describe('cleanup', () => {
  it('deletes both the blob and the cleartext scratch file after a success', async () => {
    await runBackup(makeProvider());
    expect(mockFiles).toHaveLength(2);
    expect(mockFiles.every((f) => f.removed)).toBe(true);
  });

  it('deletes them when the upload throws, too', async () => {
    const provider = makeProvider({
      upload: jest.fn(async () => {
        throw new Error('quota');
      }),
    });
    await expect(runBackup(provider)).rejects.toThrow('quota');
    // The scratch file is the persona in CLEARTEXT. It has no reason to
    // survive a failure any more than a success.
    expect(mockFiles.every((f) => f.removed)).toBe(true);
  });

  it('deletes the downloaded blob after a restore throws', async () => {
    mockImportBackup.mockRejectedValueOnce(new Error('tampered'));
    await expect(runRestore(makeProvider(), '/mera-backup/x.bin')).rejects.toThrow('tampered');
    expect(mockFiles.every((f) => f.removed)).toBe(true);
  });
});

describe('remote naming and retention', () => {
  it('names a blob by timestamp and nothing else', async () => {
    const name = remoteFilenameFor(Date.UTC(2026, 7, 17, 12, 34, 56));
    expect(name).toBe(`${REMOTE_FILENAME_PREFIX}2026-08-17T12-34-56-000Z.bin`);
    // No user id, no email, no device name. The blob may sit in a cloud account
    // shared with other people, and BackupHeader carries no identity for the
    // same reason.
    expect(name).not.toMatch(/@|user|device/i);
  });

  it('sorts backups newest first', async () => {
    const provider = makeProvider({
      list: jest.fn(async () => [
        `/mera-backup/${REMOTE_FILENAME_PREFIX}2026-08-01T00-00-00-000Z.bin`,
        `/mera-backup/${REMOTE_FILENAME_PREFIX}2026-08-17T00-00-00-000Z.bin`,
        `/mera-backup/${REMOTE_FILENAME_PREFIX}2026-08-09T00-00-00-000Z.bin`,
      ]),
    });
    const [newest] = await listBackups(provider);
    expect(newest).toContain('2026-08-17');
  });

  it('prunes down to the keep count after a successful upload', async () => {
    const names = Array.from(
      { length: BACKUP_KEEP_COUNT + 2 },
      (_, i) => `/mera-backup/${REMOTE_FILENAME_PREFIX}2026-08-0${i + 1}T00-00-00-000Z.bin`,
    );
    const provider = makeProvider({ list: jest.fn(async () => names) });
    await runBackup(provider);

    const removed = (provider.remove as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(removed).toHaveLength(2);
    // The two OLDEST, which after the newest-first sort are the tail.
    expect(removed.every((r) => r.includes('2026-08-01') || r.includes('2026-08-02'))).toBe(true);
  });

  it('does not fail a backup that was taken just because pruning failed', async () => {
    const provider = makeProvider({
      list: jest.fn(async () => {
        throw new Error('drive offline');
      }),
    });
    // Untidy cloud storage beats losing the backup the user just took.
    await expect(runBackup(provider)).resolves.toMatchObject({ blobBytes: 1234 });
  });
});

describe('restore wiring', () => {
  it('passes the LIVE schema version and columns to the importer', async () => {
    await runRestore(makeProvider(), '/mera-backup/x.bin');
    expect(mockImportBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 53,
        knownColumns: { facts: ['statement', 'created_at'] },
      }),
    );
  });

  it('downloads before importing', async () => {
    const order: string[] = [];
    const provider = makeProvider({
      download: jest.fn(async () => {
        order.push('download');
      }),
    });
    mockImportBackup.mockImplementationOnce(async () => {
      order.push('import');
      return { rowsRestored: 0 };
    });
    await runRestore(provider, '/mera-backup/x.bin');
    expect(order).toEqual(['download', 'import']);
  });
});
