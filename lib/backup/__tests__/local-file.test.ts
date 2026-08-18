// The file destination: the path most people will take, and the one the
// scheduler can never touch.
//
// The two assertions worth having here are about honesty rather than
// mechanics. `copyToCacheDirectory` must be true, because without it Android
// hands back a content:// URI and this codec seeks per frame rather than
// reading start to finish — the failure would be a restore that mysteriously
// fails on one platform. And the CLEARTEXT scratch file must be gone before the
// share sheet opens, because that sheet can stay open for as long as the user
// browses folders.

const mockFiles: { path: string; removed: boolean }[] = [];
const calls: string[] = [];

jest.mock('expo-file-system', () => {
  class Directory {
    uri: string;
    constructor(parent: { uri: string } | string, name: string) {
      this.uri = `${typeof parent === 'string' ? parent : parent.uri}${name}`;
    }
    get exists() {
      return true;
    }
    create() {}
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
      calls.push(`remove:${this.path.split('/').pop()}`);
      const e = mockFiles.find((f) => f.path === this.path);
      if (e) e.removed = true;
    }
  }
  return { RnfsFile };
});

const mockExport = jest.fn(async (_o?: unknown) => ({
  header: { tables: [{ table: 'facts', rows: 4, rowsAvailable: 4 }] },
  blobBytes: 99,
}));
jest.mock('../export', () => ({ exportBackup: (o: unknown) => mockExport(o) }));

const mockImport = jest.fn(async (_o?: unknown) => ({ rowsRestored: 12 }));
jest.mock('../import', () => ({ importBackup: (o: unknown) => mockImport(o) }));

const mockShareAsync = jest.fn(async (uri: string, _o?: unknown) => {
  calls.push(`share:${uri}`);
});
let mockSharingAvailable = true;
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => mockSharingAvailable),
  shareAsync: (u: string, o?: unknown) => mockShareAsync(u, o),
}));

let mockPickerResult: unknown = { canceled: false, assets: [{ uri: 'file:///cache/picked.bin' }] };
const mockGetDocument = jest.fn(async (o?: unknown) => {
  calls.push(`picker:${JSON.stringify(o)}`);
  return mockPickerResult;
});
jest.mock('expo-document-picker', () => ({ getDocumentAsync: (o?: unknown) => mockGetDocument(o) }));

const mockGetKey = jest.fn(async (): Promise<Uint8Array | null> => new Uint8Array(32));
const mockConfirmed = jest.fn(async () => true);
jest.mock('../key-store', () => ({
  getBackupKey: () => mockGetKey(),
  isRecoveryCodeConfirmed: () => mockConfirmed(),
}));

const mockRecordRun = jest.fn(async (_at: number) => { calls.push('recordBackupRun'); });
jest.mock('../backup-settings', () => ({ recordBackupRun: (at: number) => mockRecordRun(at) }));

jest.mock('../adapters/watermelon-row-source', () => ({ watermelonRowSource: {} }));
jest.mock('../adapters/watermelon-row-sink', () => ({ watermelonRowSink: {} }));
jest.mock('@/lib/database/schema', () => ({
  __esModule: true,
  default: { version: 53, tables: { facts: { columns: { statement: {} } } } },
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.3.0' } } }));

import { restoreBackupFromFile, saveBackupToFile } from '../local-file';

beforeEach(() => {
  jest.clearAllMocks();
  mockFiles.length = 0;
  calls.length = 0;
  mockSharingAvailable = true;
  mockGetKey.mockResolvedValue(new Uint8Array(32));
  mockConfirmed.mockResolvedValue(true);
  mockPickerResult = { canceled: false, assets: [{ uri: 'file:///cache/picked.bin' }] };
});

describe('saving a copy', () => {
  it('exports, shares, and records the run', async () => {
    const result = await saveBackupToFile();
    expect(result.blobBytes).toBe(99);
    expect(mockShareAsync).toHaveBeenCalled();
    // Recorded even though the platform never tells us whether the user saved
    // or dismissed. Recording only on a confirmed save is impossible, and the
    // staleness prompt would then nag forever, including at the most diligent
    // users — a warning that is always on is one nobody reads.
    expect(calls).toContain('recordBackupRun');
  });

  it('deletes the CLEARTEXT scratch file before the share sheet opens', async () => {
    await saveBackupToFile();
    const scratchGone = calls.indexOf('remove:snapshot.ndjson');
    const shared = calls.findIndex((c) => c.startsWith('share:'));
    expect(scratchGone).toBeGreaterThanOrEqual(0);
    expect(shared).toBeGreaterThanOrEqual(0);
    // The sheet can sit open for as long as the user browses folders. There is
    // no reason for a plaintext copy of the whole persona to exist for that.
    expect(scratchGone).toBeLessThan(shared);
  });

  it('leaves nothing behind, success or failure', async () => {
    await saveBackupToFile();
    expect(mockFiles.every((f) => f.removed)).toBe(true);

    mockFiles.length = 0;
    mockShareAsync.mockRejectedValueOnce(new Error('no sheet'));
    await expect(saveBackupToFile()).rejects.toThrow('no sheet');
    expect(mockFiles.every((f) => f.removed)).toBe(true);
  });

  it('applies the same recovery-code gate as the cloud path', async () => {
    mockConfirmed.mockResolvedValue(false);
    await expect(saveBackupToFile()).rejects.toMatchObject({ reason: 'code-unconfirmed' });
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('refuses with no key rather than writing an unopenable file', async () => {
    mockGetKey.mockResolvedValue(null);
    await expect(saveBackupToFile()).rejects.toMatchObject({ reason: 'no-key' });
  });

  it('refuses when the device cannot share at all', async () => {
    mockSharingAvailable = false;
    await expect(saveBackupToFile()).rejects.toMatchObject({ reason: 'provider-unavailable' });
  });
});

describe('restoring from a file', () => {
  it('copies to the cache, which is what makes the file seekable', async () => {
    await restoreBackupFromFile();
    const picker = calls.find((c) => c.startsWith('picker:')) ?? '';
    // Without this Android returns a content:// URI. The codec reads the header
    // then seeks to each frame, which such a URI does not reliably support, so
    // the symptom would be a restore that fails on one platform only.
    expect(JSON.parse(picker.slice('picker:'.length))).toMatchObject({
      copyToCacheDirectory: true,
      multiple: false,
    });
  });

  it('returns null when the picker is dismissed', async () => {
    mockPickerResult = { canceled: true, assets: null };
    expect(await restoreBackupFromFile()).toBeNull();
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('imports the picked file and reports what landed', async () => {
    const result = await restoreBackupFromFile();
    expect(result?.rowsRestored).toBe(12);
    expect(mockImport).toHaveBeenCalledWith(
      expect.objectContaining({ schemaVersion: 53, knownColumns: { facts: ['statement'] } }),
    );
  });

  it("strips the file:// prefix, because RNFS wants a plain path", async () => {
    await restoreBackupFromFile();
    expect(mockFiles.some((f) => f.path === '/cache/picked.bin')).toBe(true);
  });

  it('deletes the picker copy afterwards, which is a decrypted persona in our cache', async () => {
    await restoreBackupFromFile();
    expect(mockFiles.find((f) => f.path === '/cache/picked.bin')?.removed).toBe(true);
  });

  it('refuses without a key, pointing at the recovery code', async () => {
    mockGetKey.mockResolvedValue(null);
    await expect(restoreBackupFromFile()).rejects.toMatchObject({ reason: 'no-key' });
    expect(mockGetDocument).not.toHaveBeenCalled();
  });
});
