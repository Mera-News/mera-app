// The model download must not go through RNFS: its progress events race the
// TurboModule event map from a background thread and crashed the app natively
// (MERA-APP-7M / 7N). It runs in an expo-file-system background session.

let mockProgress: ((p: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void) | null = null;
let mockDownloadResult: unknown = { status: 200, uri: 'file:///c/m.gguf' };
const mockCreateDownloadResumable = jest.fn();
const mockCancelAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-file-system/legacy', () => ({
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
  createDownloadResumable: (...args: any[]) => {
    mockCreateDownloadResumable(...args);
    mockProgress = args[3];
    return {
      downloadAsync: () => Promise.resolve(mockDownloadResult),
      cancelAsync: mockCancelAsync,
    };
  },
}));
const mockDelete = jest.fn();
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    exists = true;
    constructor(...parts: any[]) { this.uri = 'file:///c/' + parts.slice(1).join('/'); }
    delete() { mockDelete(this.uri); }
    info() { return { size: 1234 }; }
    write() {}
    text() { return '{}'; }
  }
  class Directory { exists = true; create() {} delete() {} }
  return { File, Directory, Paths: { cache: 'cache' } };
});
jest.mock('../../../logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => ({ selectedModelId: 'm' }) },
}));
jest.mock('../../../app-restart', () => ({ holdRestart: () => () => {} }));

import * as RNFS from '@dr.pogodin/react-native-fs';
import { cancelActiveDownload, downloadBaseModel } from '../modelManager';

const cfg = { modelId: 'm', modelUrl: 'https://x/m.gguf', expectedChecksum: '' };

beforeEach(() => {
  jest.clearAllMocks();
  mockDownloadResult = { status: 200, uri: 'file:///c/m.gguf' };
});

describe('downloadBaseModel', () => {
  it('uses an expo-file-system BACKGROUND session and never RNFS.downloadFile', async () => {
    const manifest = await downloadBaseModel(cfg);
    expect(mockCreateDownloadResumable).toHaveBeenCalledWith(
      'https://x/m.gguf',
      expect.stringContaining('model.gguf'),
      { sessionType: 0 },
      expect.any(Function),
    );
    expect((RNFS as any).downloadFile).not.toHaveBeenCalled();
    expect(manifest.ready).toBe(true);
  });

  it('forwards only whole-percent progress changes to JS', async () => {
    const seen: number[] = [];
    const run = downloadBaseModel(cfg, (i) => seen.push(Math.floor(i.progress)));
    for (const w of [0, 1, 5, 9, 10, 11, 19, 20, 99, 100]) {
      mockProgress!({ totalBytesWritten: w, totalBytesExpectedToWrite: 100 });
    }
    mockProgress!({ totalBytesWritten: 5, totalBytesExpectedToWrite: -1 }); // unknown size: ignored
    await run;
    expect(seen).toEqual([0, 1, 5, 9, 10, 11, 19, 20, 99, 100]);
    // A second event inside the same whole percent is dropped:
    const seen2: number[] = [];
    const run2 = downloadBaseModel(cfg, (i) => seen2.push(i.bytesWritten));
    mockProgress!({ totalBytesWritten: 1000, totalBytesExpectedToWrite: 100000 });
    mockProgress!({ totalBytesWritten: 1500, totalBytesExpectedToWrite: 100000 });
    await run2;
    expect(seen2).toEqual([1000]);
  });

  it('treats an undefined result (cancelled) as an aborted download', async () => {
    mockDownloadResult = undefined;
    await expect(downloadBaseModel(cfg)).rejects.toThrow('Download has been aborted');
  });

  it('fails a non-200 download and removes the file', async () => {
    mockDownloadResult = { status: 404, uri: 'file:///c/m.gguf' };
    await expect(downloadBaseModel(cfg)).rejects.toThrow('HTTP status 404');
    expect(mockDelete).toHaveBeenCalled();
  });

  it('cancelActiveDownload cancels the in-flight expo task', async () => {
    let release!: (v: unknown) => void;
    mockDownloadResult = new Promise((r) => { release = r; });
    const run = downloadBaseModel(cfg).catch(() => {});
    await new Promise((r) => setImmediate(r));
    cancelActiveDownload();
    expect(mockCancelAsync).toHaveBeenCalledTimes(1);
    release(undefined);
    await run;
  });
});
