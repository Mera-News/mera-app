/* eslint-disable @typescript-eslint/no-require-imports */
// The on-device model download: `startModelDownloads` / `cancelModelDownload` (downloadService) over the REAL
// modelManager, store, app-restart holds and i18n, on the in-memory expo-file-system. Both catalogue models download
// one after the other; the catalogue's sizes are shrunk to the 4 bytes a fake download writes. The download task itself
// is the one native edge chat's fake does not cover, so `expo-file-system/legacy` is faked per file: each
// `createDownloadResumable` call becomes a download the test settles by hand (a finished file lands on the
// in-memory disk, as it would on the device). expo-notifications is the setup's native fake.
import * as Notifications from 'expo-notifications';
import * as RNFS from '@dr.pogodin/react-native-fs';
import {
    cancelModelDownload,
    downloadFailureBody,
    downloadFailureKind,
    getDownloadBytes,
    isDownloadInProgress,
    setPromoteWhenDone,
    startModelDownloads,
} from '@/lib/mera-protocol-toolkit/core/downloadService';
import { cancelActiveDownload, downloadBaseModel, isModelDownloaded } from '@/lib/mera-protocol-toolkit/core/modelManager';
import { RELEVANCE_MODEL, TEXT_MODEL } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useUserStore } from '@/lib/stores/user-store';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';
import { placeDownloadedModel } from '@/test/helpers/fs';
import { __resetAppRestartForTests, activeHolds } from '@/lib/app-restart';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { fileSystemModule, resetFileSystem, until } from '@/test/integration/chat/_helpers';
import { FIXTURE_ACCOUNT, graphql, HttpResponse, initI18nEn, server, signInFixtureAccount } from '@/test/helpers';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/lib/mera-protocol-toolkit/core/model-catalog', () => {
    const actual = jest.requireActual('@/lib/mera-protocol-toolkit/core/model-catalog');
    const TEXT = { ...actual.TEXT_MODEL, sizeBytes: 4 };
    const KEV = { ...actual.RELEVANCE_MODEL, sizeBytes: 4 };
    return { ...actual, TEXT_MODEL: TEXT, RELEVANCE_MODEL: KEV, MODEL_CATALOG: [TEXT, KEV] };
});

interface FakeDownload {
    url: string;
    path: string;
    options: unknown;
    onProgress: (p: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void;
    /** The task finishes with this HTTP status; the file lands on disk either way (an error body is a file too). */
    finish: (status?: number, content?: string) => void;
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
            finish: (status = 200, content = 'GGUF') => {
                void new fileSystemModule.File(path).write(content);
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
const config = () => ({ modelId: TEXT_MODEL.modelId, modelUrl: 'https://models.example/m.gguf', sizeBytes: 4 });
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
    useMeraProtocolStore.setState({
        modelState: 'not_downloaded',
        downloadProgress: 0,
        modelError: null,
        processingMode: ProcessingMode.Cloud,
    });
    captured = jest.spyOn(logger, 'captureException').mockReturnValue('');
    jest.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(async () => {
    // Drops module state a test left behind (an unsettled download) before the next one starts.
    await cancelModelDownload();
    setPromoteWhenDone(false);
    jest.restoreAllMocks();
});

/** UpdateProcessingMode inputs the server received, in order. */
function recordModeUpdates(): { userId: string; mode: string }[] {
    const sent: { userId: string; mode: string }[] = [];
    server.use(
        graphql.mutation('UpdateProcessingMode', ({ variables }) => {
            const input = (variables as { input: { userId: string; mode: string } }).input;
            sent.push(input);
            return HttpResponse.json({
                data: { updateProcessingMode: personaFor(Date.now(), { userId: input.userId, processingMode: input.mode as ProcessingMode }) },
            });
        }),
    );
    return sent;
}

describe('startModelDownloads', () => {
    it('downloads the text model, THEN Kev, under one hold, with byte-weighted progress, and leaves both ready', async () => {
        startModelDownloads();
        expect(protocol().modelState).toBe('downloading');
        expect(isDownloadInProgress()).toBe(true);
        expect(activeHolds()).toEqual(['model-download']);
        await started();

        // Sequential: Kev has not started while the text model downloads.
        expect(downloads).toHaveLength(1);
        expect(last().url).toBe(TEXT_MODEL.modelUrl);
        expect(last().path).toContain(`${TEXT_MODEL.modelId}/model.gguf`);
        expect(last().options).toEqual({ sessionType: 0 });
        expect((RNFS as unknown as { downloadFile: jest.Mock }).downloadFile).not.toHaveBeenCalled();

        last().onProgress({ totalBytesWritten: 2, totalBytesExpectedToWrite: 4 });
        expect(getDownloadBytes()).toEqual({ doneBytes: 2, totalBytes: 8 });
        expect(protocol().downloadProgress).toBe(25);
        last().finish();
        await started(2);

        expect(last().url).toBe(RELEVANCE_MODEL.modelUrl);
        expect(activeHolds()).toEqual(['model-download']);
        last().onProgress({ totalBytesWritten: 2, totalBytesExpectedToWrite: 4 });
        expect(getDownloadBytes()).toEqual({ doneBytes: 6, totalBytes: 8 });
        expect(protocol().downloadProgress).toBe(75);
        last().finish();
        await until(() => protocol().modelState === 'downloaded');

        expect(protocol().downloadProgress).toBe(100);
        expect(isDownloadInProgress()).toBe(false);
        expect(activeHolds()).toEqual([]);
        expect(getDownloadBytes()).toEqual({ doneBytes: 0, totalBytes: 0 });
        expect(await isModelDownloaded()).toBe(true);
        expect(notificationIds()).toEqual(['model-download-complete']);
        expect(scheduled.mock.calls[0][0].content.body).toBe('Mera Protocol is now ready for use.');
    });

    it('a retry downloads only what is still missing', async () => {
        placeDownloadedModel(TEXT_MODEL.modelId);
        startModelDownloads();
        await started();
        expect(last().url).toBe(RELEVANCE_MODEL.modelUrl);
        expect(getDownloadBytes()).toEqual({ doneBytes: 0, totalBytes: 4 });
        last().finish();
        await until(() => protocol().modelState === 'downloaded');
        expect(downloads).toHaveLength(1);
    });

    it('with the on-device intent, the pair landing promotes the phone to OnDevice and says so', async () => {
        useUserStore.setState({ userId: FIXTURE_ACCOUNT.userId });
        await signInFixtureAccount();
        const sent = recordModeUpdates();
        startModelDownloads({ promote: true });
        await started();
        last().finish();
        await started(2);
        last().finish();
        await until(() => protocol().processingMode === ProcessingMode.OnDevice);

        expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, mode: ProcessingMode.OnDevice }]);
        await until(() => notificationIds().length === 1);
        expect(scheduled.mock.calls[0][0].content.body).toBe('Mera now runs on this phone.');
    });

    it('an intent withdrawn mid-download promotes nothing', async () => {
        const sent = recordModeUpdates();
        startModelDownloads({ promote: true });
        await started();
        setPromoteWhenDone(false);
        last().finish();
        await started(2);
        last().finish();
        await until(() => protocol().modelState === 'downloaded');
        expect(sent).toEqual([]);
        expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
    });

    it('a second start while one runs does not start a second download', async () => {
        startModelDownloads();
        await started();
        startModelDownloads();
        await new Promise((r) => setImmediate(r));
        expect(downloads).toHaveLength(1);
        expect(activeHolds()).toEqual(['model-download']);
    });

    it('a connection failure on the second file keeps the first, releases the hold and says so in plain words', async () => {
        startModelDownloads();
        await started();
        last().finish();
        await started(2);
        last().fail(new Error('network down'));
        await until(() => protocol().modelState === 'error');

        expect(protocol().modelError).toBe('network down');
        expect(activeHolds()).toEqual([]);
        expect(isDownloadInProgress()).toBe(false);
        expect(captured).toHaveBeenCalledTimes(1);
        expect(await isModelDownloaded(TEXT_MODEL.modelId)).toBe(true);
        expect(await isModelDownloaded()).toBe(false);
        expect(notificationIds()).toEqual(['model-download-error']);
        expect(scheduled.mock.calls[0][0].content.body).toBe('Check your connection and try again.');
    });

    it('a server error removes the partial file and says the server had a problem', async () => {
        startModelDownloads();
        await started();
        last().finish(503);
        await until(() => protocol().modelState === 'error');

        expect(protocol().modelError).toBe('Download failed with HTTP status 503');
        expect(new fileSystemModule.File(last().path).exists).toBe(false);
        expect(downloads).toHaveLength(1);
        expect(scheduled.mock.calls[0][0].content.body).toBe('The download server had a problem. Try again later.');
    });
});

describe('cancelModelDownload', () => {
    it('settles as not_downloaded with no error and no notification, even when the task rejects afterwards', async () => {
        startModelDownloads();
        await started();
        last().onProgress({ totalBytesWritten: 3, totalBytesExpectedToWrite: 4 });
        await cancelModelDownload();

        expect(last().cancelAsync).toHaveBeenCalledTimes(1);
        expect(protocol().modelState).toBe('not_downloaded');
        expect(protocol().downloadProgress).toBe(0);
        expect(getDownloadBytes()).toEqual({ doneBytes: 0, totalBytes: 0 });
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
        expect(downloads).toHaveLength(1);
    });

    it('a task that resolves with nothing (expo cancelled it) is not a failure either', async () => {
        startModelDownloads();
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
        startModelDownloads();
        await started();
        const first = last();
        await cancelModelDownload();

        startModelDownloads();
        await started(2);
        expect(activeHolds()).toEqual(['model-download']);

        first.fail(new Error('Download has been aborted'));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        expect(isDownloadInProgress()).toBe(true);
        expect(protocol().modelState).toBe('downloading');
        expect(activeHolds()).toEqual(['model-download']);

        last().finish();
        await started(3);
        last().finish();
        await until(() => protocol().modelState === 'downloaded');
        expect(activeHolds()).toEqual([]);
    });
});

describe('downloadFailureBody', () => {
    it('maps the developer error to words a reader can act on, never the raw message', () => {
        expect(downloadFailureBody('Download failed with HTTP status 503')).toBe('The download server had a problem. Try again later.');
        expect(downloadFailureBody('Damaged download: size 3, expected 4')).toBe('The download was damaged. Try again.');
        expect(downloadFailureBody('Network request failed')).toBe('Check your connection and try again.');
        expect(downloadFailureBody('ENOSPC: no space left on device')).toBe('Not enough space on this phone. Free up space and try again.');
    });

    it('classifies each failure kind', () => {
        expect(downloadFailureKind('Damaged download: the file is not a GGUF')).toBe('damaged');
        expect(downloadFailureKind('Write failed: disk full')).toBe('space');
        expect(downloadFailureKind('Download failed with HTTP status 404')).toBe('server');
        expect(downloadFailureKind('timeout')).toBe('connection');
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

    it('a file of the wrong size is damaged: deleted, no manifest', async () => {
        const run = downloadBaseModel(config());
        const failed = expect(run).rejects.toThrow('Damaged download: size 3, expected 4');
        await started();
        last().finish(200, 'GGU');
        await failed;
        expect(new fileSystemModule.File(last().path).exists).toBe(false);
        expect(await isModelDownloaded(config().modelId)).toBe(false);
    });

    it('a file without the GGUF magic (an HTML error page) is damaged: deleted, no manifest', async () => {
        const run = downloadBaseModel(config());
        const failed = expect(run).rejects.toThrow('Damaged download: the file is not a GGUF');
        await started();
        last().finish(200, '<htm');
        await failed;
        expect(new fileSystemModule.File(last().path).exists).toBe(false);
        expect(await isModelDownloaded(config().modelId)).toBe(false);
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
