/* eslint-disable @typescript-eslint/no-require-imports */
// The on-device model download: `startModelDownload` / `cancelModelDownload` (downloadService) over the REAL
// modelManager, store, app-restart holds and i18n, on chat's in-memory expo-file-system. The download task itself
// is the one native edge chat's fake does not cover, so `expo-file-system/legacy` is faked per file: each
// `createDownloadResumable` call becomes a download the test settles by hand (a finished file lands on the
// in-memory disk, as it would on the device). expo-notifications is the setup's native fake.
import * as Notifications from 'expo-notifications';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { cancelModelDownload, downloadFailureBody, isDownloadInProgress, startModelDownload } from '@/lib/mera-protocol-toolkit/core/downloadService';
import { cancelActiveDownload, downloadBaseModel, isModelDownloaded } from '@/lib/mera-protocol-toolkit/core/modelManager';
import { __resetAppRestartForTests, activeHolds } from '@/lib/app-restart';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { fileSystemModule, resetFileSystem, until } from '@/test/integration/chat/_helpers';
import { initI18nEn } from '@/test/helpers';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);

interface FakeDownload {
    url: string;
    path: string;
    options: unknown;
    onProgress: (p: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void;
    /** The task finishes with this HTTP status; the file lands on disk either way (an error body is a file too). */
    finish: (status?: number) => void;
    /** The task rejects, as a cancelled native session does a moment after the cancel. */
    fail: (error: Error) => void;
    /** The task resolves with nothing, as expo does for a cancelled task. */
    resolveCancelled: () => void;
    cancelAsync: jest.Mock;
}

const downloads: FakeDownload[] = [];

const mockCreateDownloadResumable = jest.fn(
    (url: string, path: string, options: unknown, onProgress: FakeDownload['onProgress']) => {
        let settle!: (r: unknown) => void;
        let reject!: (e: Error) => void;
        const result = new Promise<unknown>((res, rej) => {
            settle = res;
            reject = rej;
        });
        const download: FakeDownload = {
            url,
            path,
            options,
            onProgress,
            finish: (status = 200) => {
                void new fileSystemModule.File(path).write('GGUF');
                settle({ status, uri: path });
            },
            fail: (e) => reject(e),
            resolveCancelled: () => settle(undefined),
            cancelAsync: jest.fn(async () => {}),
        };
        downloads.push(download);
        return { downloadAsync: () => result, cancelAsync: download.cancelAsync };
    },
);
jest.mock('expo-file-system/legacy', () => ({
    FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
    createDownloadResumable: (...args: unknown[]) => (mockCreateDownloadResumable as (...a: unknown[]) => unknown)(...args),
}));

const scheduled = Notifications.scheduleNotificationAsync as unknown as jest.Mock;
const protocol = () => useMeraProtocolStore.getState();
const config = () => ({ modelId: protocol().selectedModelId, modelUrl: 'https://models.example/m.gguf', expectedChecksum: '' });
const last = () => downloads[downloads.length - 1];
/** Lets the download task start (the directory is created first) and the permission check settle. */
const started = (count = 1) => until(() => downloads.length === count, 2000, `download ${count} started`);
const notificationIds = () => scheduled.mock.calls.map((c) => (c[0] as { identifier: string }).identifier);

let captured: jest.SpyInstance;

beforeAll(async () => {
    await initI18nEn();
});

beforeEach(() => {
    downloads.length = 0;
    resetFileSystem();
    __resetAppRestartForTests();
    useMeraProtocolStore.setState({ modelState: 'not_downloaded', downloadProgress: 0, modelError: null });
    captured = jest.spyOn(logger, 'captureException').mockReturnValue('');
    jest.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(async () => {
    // Drops module state a test left behind (an unsettled download) before the next one starts.
    await cancelModelDownload();
    jest.restoreAllMocks();
});

describe('startModelDownload', () => {
    it('downloads in a background session, holds the restart meanwhile, and leaves a ready model on disk', async () => {
        startModelDownload(config());
        expect(protocol().modelState).toBe('downloading');
        expect(isDownloadInProgress()).toBe(true);
        expect(activeHolds()).toEqual(['model-download']);
        await started();

        expect(last().url).toBe('https://models.example/m.gguf');
        expect(last().path).toContain('model.gguf');
        expect(last().options).toEqual({ sessionType: 0 });
        expect((RNFS as unknown as { downloadFile: jest.Mock }).downloadFile).not.toHaveBeenCalled();

        last().onProgress({ totalBytesWritten: 40, totalBytesExpectedToWrite: 100 });
        expect(protocol().downloadProgress).toBe(40);
        last().finish();
        await until(() => protocol().modelState === 'downloaded');

        expect(protocol().downloadProgress).toBe(100);
        expect(isDownloadInProgress()).toBe(false);
        expect(activeHolds()).toEqual([]);
        expect(await isModelDownloaded()).toBe(true);
        expect(notificationIds()).toEqual(['model-download-complete']);
    });

    it('a second start while one runs does not start a second download', async () => {
        startModelDownload(config());
        await started();
        startModelDownload(config());
        await new Promise((r) => setImmediate(r));
        expect(downloads).toHaveLength(1);
        expect(activeHolds()).toEqual(['model-download']);
    });

    it('a connection failure is reported, releases the hold and tells the reader in plain words', async () => {
        startModelDownload(config());
        await started();
        last().fail(new Error('network down'));
        await until(() => protocol().modelState === 'error');

        expect(protocol().modelError).toBe('network down');
        expect(activeHolds()).toEqual([]);
        expect(isDownloadInProgress()).toBe(false);
        expect(captured).toHaveBeenCalledTimes(1);
        expect(notificationIds()).toEqual(['model-download-error']);
        expect(scheduled.mock.calls[0][0].content.body).toBe('Check your connection and try again.');
    });

    it('a server error removes the partial file and says the server had a problem', async () => {
        startModelDownload(config());
        await started();
        last().finish(503);
        await until(() => protocol().modelState === 'error');

        expect(protocol().modelError).toBe('Download failed with HTTP status 503');
        expect(new fileSystemModule.File(last().path).exists).toBe(false);
        expect(await isModelDownloaded()).toBe(false);
        expect(scheduled.mock.calls[0][0].content.body).toBe('The download server had a problem. Try again later.');
    });
});

describe('cancelModelDownload', () => {
    it('settles as not_downloaded with no error and no notification, even when the task rejects afterwards', async () => {
        startModelDownload(config());
        await started();
        last().onProgress({ totalBytesWritten: 30, totalBytesExpectedToWrite: 100 });
        await cancelModelDownload();

        expect(last().cancelAsync).toHaveBeenCalledTimes(1);
        expect(protocol().modelState).toBe('not_downloaded');
        expect(protocol().downloadProgress).toBe(0);
        expect(activeHolds()).toEqual([]);
        expect(isDownloadInProgress()).toBe(false);

        // The native session rejects a moment after the cancel: that must not become a failure.
        last().fail(new Error('Download has been aborted'));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(protocol().modelState).toBe('not_downloaded');
        expect(protocol().modelError).toBeNull();
        expect(captured).not.toHaveBeenCalled();
        expect(scheduled).not.toHaveBeenCalled();
    });

    it('a task that resolves with nothing (expo cancelled it) is not a failure either', async () => {
        startModelDownload(config());
        await started();
        last().cancelAsync.mockImplementation(async () => last().resolveCancelled());
        await cancelModelDownload();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        expect(protocol().modelState).toBe('not_downloaded');
        expect(protocol().modelError).toBeNull();
        expect(captured).not.toHaveBeenCalled();
        expect(scheduled).not.toHaveBeenCalled();
    });

    it('an old download settling late cannot clear or fail the download started after the cancel', async () => {
        startModelDownload(config());
        await started();
        const first = last();
        await cancelModelDownload();

        startModelDownload(config());
        await started(2);
        expect(activeHolds()).toEqual(['model-download']);

        first.fail(new Error('Download has been aborted'));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        expect(isDownloadInProgress()).toBe(true);
        expect(protocol().modelState).toBe('downloading');
        expect(activeHolds()).toEqual(['model-download']);

        last().finish();
        await until(() => protocol().modelState === 'downloaded');
        expect(activeHolds()).toEqual([]);
    });
});

describe('downloadFailureBody', () => {
    it('maps the developer error to words a reader can act on, never the raw message', () => {
        expect(downloadFailureBody('Download failed with HTTP status 503')).toBe('The download server had a problem. Try again later.');
        expect(downloadFailureBody('Checksum mismatch: expected a, got b')).toBe('The download was damaged. Try again.');
        expect(downloadFailureBody('Network request failed')).toBe('Check your connection and try again.');
    });
});

describe('downloadBaseModel', () => {
    it('writes the manifest with the size on disk', async () => {
        const run = downloadBaseModel(config());
        await started();
        last().finish();
        const manifest = await run;
        expect(manifest).toMatchObject({ modelId: config().modelId, ready: true, sizeBytes: 4 });
    });

    it('forwards only whole-percent progress changes, and ignores an unknown size', async () => {
        const seen: number[] = [];
        const run = downloadBaseModel(config(), (i) => seen.push(Math.floor(i.progress)));
        await started();
        for (const w of [0, 1, 5, 9, 10, 11, 19, 20, 99, 100]) {
            last().onProgress({ totalBytesWritten: w, totalBytesExpectedToWrite: 100 });
        }
        last().onProgress({ totalBytesWritten: 5, totalBytesExpectedToWrite: -1 });
        last().finish();
        await run;
        expect(seen).toEqual([0, 1, 5, 9, 10, 11, 19, 20, 99, 100]);
    });

    it('drops a second event inside the same whole percent', async () => {
        const seen: number[] = [];
        const run = downloadBaseModel(config(), (i) => seen.push(i.bytesWritten));
        await started();
        last().onProgress({ totalBytesWritten: 1000, totalBytesExpectedToWrite: 100000 });
        last().onProgress({ totalBytesWritten: 1500, totalBytesExpectedToWrite: 100000 });
        last().finish();
        await run;
        expect(seen).toEqual([1000]);
    });

    it('treats a task that resolves with nothing (cancelled) as an aborted download', async () => {
        const run = downloadBaseModel(config());
        const failed = expect(run).rejects.toThrow('Download has been aborted');
        await started();
        last().resolveCancelled();
        await failed;
    });

    it('cancelActiveDownload cancels the in-flight task once', async () => {
        const run = downloadBaseModel(config()).catch(() => {});
        await started();
        cancelActiveDownload();
        cancelActiveDownload();
        expect(last().cancelAsync).toHaveBeenCalledTimes(1);
        last().resolveCancelled();
        await run;
    });
});
