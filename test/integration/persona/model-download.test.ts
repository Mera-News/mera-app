/* eslint-disable @typescript-eslint/no-require-imports */
// The on-device model download: `startModelDownloads` / `cancelModelDownload` (downloadService) over the REAL
// modelManager, store, app-restart holds and i18n, on the in-memory expo-file-system. The catalogue holds Kev only
// (D37); a test-only SECOND entry is added in front of it so the serial queue (one model at a time, per-model state,
// cancel, retry) stays covered. Sizes are shrunk to the 4 bytes a fake download writes. The download task itself
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
    getModelDownloads,
    isDownloadInProgress,
    restoreOnDeviceIfRunnable,
    setPromoteWhenDone,
    startModelDownloads,
} from '@/lib/mera-protocol-toolkit/core/downloadService';
import {
    cancelActiveDownload,
    downloadBaseModel,
    isModelDownloaded,
    purgeStaleModels,
} from '@/lib/mera-protocol-toolkit/core/modelManager';
import { MODEL_CATALOG, RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useUserStore } from '@/lib/stores/user-store';
import { retireLegacyModels } from '@/lib/mera-protocol-toolkit/core/retire-models';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';
import { placeDownloadedModel } from '@/test/helpers/fs';
import { installOnDeviceLlm, setOnDeviceLlmAvailability } from '@/test/helpers/on-device-llm';
import { __resetAppRestartForTests, activeHolds } from '@/lib/app-restart';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { fileSystemModule, resetFileSystem, until } from '@/test/integration/chat/_helpers';
import { FIXTURE_ACCOUNT, graphql, HttpResponse, initI18nEn, server, signInFixtureAccount } from '@/test/helpers';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);
jest.mock('@/lib/mera-protocol-toolkit/core/model-catalog', () => {
    const actual = jest.requireActual('@/lib/mera-protocol-toolkit/core/model-catalog');
    const KEV = { ...actual.RELEVANCE_MODEL, sizeBytes: 4 };
    const SECOND = { ...KEV, modelId: 'test-second-model', modelUrl: 'https://models.example/second.gguf' };
    return { ...actual, RELEVANCE_MODEL: KEV, MODEL_CATALOG: [SECOND, KEV] };
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

/** The test-only catalogue entry queued in front of Kev. */
const SECOND = MODEL_CATALOG[0];
const scheduled = Notifications.scheduleNotificationAsync as unknown as jest.Mock;
const protocol = () => useMeraProtocolStore.getState();
const config = () => ({ modelId: SECOND.modelId, modelUrl: 'https://models.example/m.gguf', sizeBytes: 4 });
const last = () => downloads[downloads.length - 1];
/** Lets the download task start (the directory is created first) and the permission check settle. */
const started = (count = 1) => until(() => downloads.length === count, 2000, `download ${count} started`);
const notificationIds = () => scheduled.mock.calls.map((c) => (c[0] as { identifier: string }).identifier);

let captured: jest.SpyInstance;

beforeAll(async () => {
    await initI18nEn();
});

beforeEach(async () => {
    installOnDeviceLlm({ availability: { available: true, reason: null } });
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

const downloadsOf = () => getModelDownloads();
const completeBody = (modelId: string) =>
    scheduled.mock.calls.find((c) => (c[0] as { identifier: string }).identifier === `model-download-complete:${modelId}`)?.[0].content.body;

describe('startModelDownloads: a serial queue, one model at a time', () => {
    it('downloads SECOND, THEN Kev, under one hold, with per-model state and queue-wide progress, and never touches modelState', async () => {
        useMeraProtocolStore.setState({ modelState: 'ready' });
        startModelDownloads();
        expect(isDownloadInProgress()).toBe(true);
        expect(activeHolds()).toEqual(['model-download']);
        await started();

        // Sequential: Kev waits its turn while SECOND downloads.
        expect(downloads).toHaveLength(1);
        expect(last().url).toBe(SECOND.modelUrl);
        expect(last().path).toContain(`${SECOND.modelId}/model.gguf`);
        expect(last().options).toEqual({ sessionType: 0 });
        expect((RNFS as unknown as { downloadFile: jest.Mock }).downloadFile).not.toHaveBeenCalled();
        expect(downloadsOf()[SECOND.modelId]).toMatchObject({ status: 'downloading', doneBytes: 0, totalBytes: 4 });
        expect(downloadsOf()[RELEVANCE_MODEL.modelId]).toMatchObject({ status: 'queued', totalBytes: 4 });

        last().onProgress({ totalBytesWritten: 2, totalBytesExpectedToWrite: 4 });
        expect(downloadsOf()[SECOND.modelId].doneBytes).toBe(2);
        expect(getDownloadBytes()).toEqual({ doneBytes: 2, totalBytes: 8 });
        expect(protocol().downloadProgress).toBe(25);
        last().finish();
        await started(2);

        expect(last().url).toBe(RELEVANCE_MODEL.modelUrl);
        expect(downloadsOf()[SECOND.modelId]).toBeUndefined();
        expect(activeHolds()).toEqual(['model-download']);
        last().onProgress({ totalBytesWritten: 2, totalBytesExpectedToWrite: 4 });
        // The landed model still counts, so the overall figure never jumps back.
        expect(getDownloadBytes()).toEqual({ doneBytes: 6, totalBytes: 8 });
        expect(protocol().downloadProgress).toBe(75);
        last().finish();
        await until(() => !isDownloadInProgress());

        expect(downloadsOf()).toEqual({});
        expect(activeHolds()).toEqual([]);
        expect(getDownloadBytes()).toEqual({ doneBytes: 0, totalBytes: 0 });
        expect(await isModelDownloaded()).toBe(true);
        // A running model stays running: a download is not the runtime state.
        expect(protocol().modelState).toBe('ready');
        // One notification per model, each with its own id, Beta in the title's words.
        await until(() => notificationIds().length === 2);
        expect(notificationIds()).toEqual([
            `model-download-complete:${SECOND.modelId}`,
            `model-download-complete:${RELEVANCE_MODEL.modelId}`,
        ]);
        expect(scheduled.mock.calls[0][0].content.title).toBe('Download complete (Beta)');
        expect(completeBody(SECOND.modelId)).toBe('The Mera relevance model is on this phone.');
        expect(completeBody(RELEVANCE_MODEL.modelId)).toBe('The Mera relevance model is on this phone.');
    });

    it('downloads only the models asked for, and a start while one runs queues behind it', async () => {
        startModelDownloads({ modelIds: [RELEVANCE_MODEL.modelId] });
        await started();
        expect(last().url).toBe(RELEVANCE_MODEL.modelUrl);
        startModelDownloads({ modelIds: [SECOND.modelId, RELEVANCE_MODEL.modelId] });
        expect(downloadsOf()[SECOND.modelId]).toMatchObject({ status: 'queued' });
        await new Promise((r) => setImmediate(r));
        // Kev is not queued twice and SECOND waits its turn.
        expect(downloads).toHaveLength(1);
        last().finish();
        await started(2);
        expect(last().url).toBe(SECOND.modelUrl);
        last().finish();
        await until(() => !isDownloadInProgress());
        expect(downloads).toHaveLength(2);
    });

    it('a retry downloads only what is still missing', async () => {
        placeDownloadedModel(SECOND.modelId);
        startModelDownloads();
        await started();
        expect(last().url).toBe(RELEVANCE_MODEL.modelUrl);
        expect(getDownloadBytes()).toEqual({ doneBytes: 0, totalBytes: 4 });
        last().finish();
        await until(() => !isDownloadInProgress());
        expect(downloads).toHaveLength(1);
    });

    it('with the on-device intent, the landing that makes it runnable promotes the phone and says so', async () => {
        useUserStore.setState({
            userId: FIXTURE_ACCOUNT.userId,
            userPersona: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode: ProcessingMode.Cloud }),
        });
        await signInFixtureAccount();
        const sent = recordModeUpdates();
        startModelDownloads({ promote: true });
        await started();
        last().finish();
        await started(2);
        // SECOND alone cannot run (no Kev): still Private cloud.
        expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
        last().finish();
        await until(() => protocol().processingMode === ProcessingMode.OnDevice);

        // The intent is saved when the download starts, and again by the promotion.
        const onDevice = { userId: FIXTURE_ACCOUNT.userId, mode: ProcessingMode.OnDevice };
        expect(sent).toEqual([onDevice, onDevice]);
        // The cached persona the boot purge reads now carries the intent too.
        expect(useUserStore.getState().userPersona?.processingMode).toBe(ProcessingMode.OnDevice);
        await until(() => notificationIds().length === 2);
        expect(completeBody(SECOND.modelId)).toBe('The Mera relevance model is on this phone.');
        expect(completeBody(RELEVANCE_MODEL.modelId)).toBe('Mera now runs on this phone.');
    });

    it('Kev landing with Gemini Nano ready promotes on its own', async () => {
        useUserStore.setState({
            userId: FIXTURE_ACCOUNT.userId,
            userPersona: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode: ProcessingMode.Cloud }),
        });
        await signInFixtureAccount();
        recordModeUpdates();
        installOnDeviceLlm({ platformModel: 'nano', availability: { available: true, reason: null } });
        startModelDownloads({ modelIds: [RELEVANCE_MODEL.modelId], promote: true });
        await started();
        last().finish();
        await until(() => protocol().processingMode === ProcessingMode.OnDevice);
        expect(downloads).toHaveLength(1);
        await until(() => notificationIds().length === 1);
        expect(completeBody(RELEVANCE_MODEL.modelId)).toBe('Mera now runs on this phone.');
    });

    it('a phone already running keeps running while another model downloads, and is not promoted again', async () => {
        useUserStore.setState({ userId: FIXTURE_ACCOUNT.userId });
        await signInFixtureAccount();
        const sent = recordModeUpdates();
        placeDownloadedModel(RELEVANCE_MODEL.modelId);
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice, modelState: 'ready' });
        startModelDownloads({ modelIds: [SECOND.modelId], promote: true });
        await started();
        expect(protocol()).toMatchObject({ processingMode: ProcessingMode.OnDevice, modelState: 'ready' });
        last().finish();
        await until(() => notificationIds().length === 1);
        expect(protocol()).toMatchObject({ processingMode: ProcessingMode.OnDevice, modelState: 'ready' });
        // Only the start's intent write: nothing to promote.
        expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, mode: ProcessingMode.OnDevice }]);
    });

    it('an intent withdrawn mid-download promotes nothing', async () => {
        useUserStore.setState({ userId: FIXTURE_ACCOUNT.userId });
        await signInFixtureAccount();
        const sent = recordModeUpdates();
        startModelDownloads({ promote: true });
        await started();
        await until(() => sent.length === 1);
        // The screen's Private cloud pick writes Cloud itself; the download only stops promoting.
        setPromoteWhenDone(false);
        last().finish();
        await started(2);
        last().finish();
        await until(() => !isDownloadInProgress());
        expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, mode: ProcessingMode.OnDevice }]);
        expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
    });

    it('with the built-in model not ready, the landing keeps the intent and says Mera waits for it', async () => {
        useUserStore.setState({
            userId: FIXTURE_ACCOUNT.userId,
            userPersona: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode: ProcessingMode.Cloud }),
        });
        await signInFixtureAccount();
        const sent = recordModeUpdates();
        placeDownloadedModel(SECOND.modelId);
        {
            installOnDeviceLlm({ availability: { available: false, reason: 'modelNotReady' } });
            startModelDownloads({ promote: true });
            await started();
            expect(last().url).toBe(RELEVANCE_MODEL.modelUrl);
            expect(getDownloadBytes()).toEqual({ doneBytes: 0, totalBytes: 4 });
            last().finish();
            await until(() => notificationIds().length === 1);
            expect(downloads).toHaveLength(1);
            // The D6 split state: Cloud locally, the server and the cached persona keep the intent,
            // so the next foreground promotes and the boot purge keeps the file.
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(sent.length).toBeGreaterThan(0);
            expect(sent.every((s) => s.mode === ProcessingMode.OnDevice)).toBe(true);
            expect(useUserStore.getState().userPersona?.processingMode).toBe(ProcessingMode.OnDevice);
            // The notification does not claim it is ready.
            expect(completeBody(RELEVANCE_MODEL.modelId)).toBe('Mera uses Private cloud until Apple Intelligence is ready.');

            // The next cold boot sees local Cloud and runs the purge: the file stays.
            await purgeStaleModels();
            await expect(isModelDownloaded(RELEVANCE_MODEL.modelId)).resolves.toBe(true);
        }
    });

    it('a promoting download killed partway keeps the finished file through the boot purge, so a retry fetches only the rest', async () => {
        useUserStore.setState({
            userId: FIXTURE_ACCOUNT.userId,
            userPersona: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode: ProcessingMode.Cloud }),
        });
        await signInFixtureAccount();
        const sent = recordModeUpdates();
        startModelDownloads({ promote: true });
        await started();
        last().finish();
        await started(2);
        await until(() => sent.length === 1);
        expect(useUserStore.getState().userPersona?.processingMode).toBe(ProcessingMode.OnDevice);

        // The app dies here; the next cold boot is on Cloud locally and runs the purge.
        await purgeStaleModels();
        await expect(isModelDownloaded(SECOND.modelId)).resolves.toBe(true);
    });

    it('picking On this phone mid-download saves the intent, since the screen sends no write while it cannot run', async () => {
        useUserStore.setState({
            userId: FIXTURE_ACCOUNT.userId,
            userPersona: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode: ProcessingMode.Cloud }),
        });
        await signInFixtureAccount();
        const sent = recordModeUpdates();
        startModelDownloads();
        await started();
        setPromoteWhenDone(true);
        await until(() => useUserStore.getState().userPersona?.processingMode === ProcessingMode.OnDevice);
        expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, mode: ProcessingMode.OnDevice }]);
        expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
    });

    it('an intent withdrawn while its save is in flight leaves the cached persona on Cloud', async () => {
        useUserStore.setState({
            userId: FIXTURE_ACCOUNT.userId,
            userPersona: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode: ProcessingMode.Cloud }),
        });
        await signInFixtureAccount();
        const sent = recordModeUpdates();
        startModelDownloads({ promote: true });
        setPromoteWhenDone(false);
        await until(() => sent.length === 1);
        await started();
        await new Promise((r) => setTimeout(r, 50));
        expect(useUserStore.getState().userPersona?.processingMode).toBe(ProcessingMode.Cloud);
    });

    it('a second start while one runs does not start a second download', async () => {
        startModelDownloads();
        await started();
        startModelDownloads();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(downloads).toHaveLength(1);
        expect(activeHolds()).toEqual(['model-download']);
    });

    it('a connection failure fails that model only: the next one still downloads, and the failure is said in plain words', async () => {
        startModelDownloads();
        await started();
        last().fail(new Error('network down'));
        await started(2);
        expect(downloadsOf()[SECOND.modelId]).toMatchObject({ status: 'failed', failure: 'connection' });
        expect(last().url).toBe(RELEVANCE_MODEL.modelUrl);
        last().finish();
        await until(() => !isDownloadInProgress());

        expect(activeHolds()).toEqual([]);
        expect(captured).toHaveBeenCalledTimes(1);
        // The failure is the download's own, never the runtime model state.
        expect(protocol().modelState).toBe('not_downloaded');
        expect(protocol().modelError).toBeNull();
        expect(await isModelDownloaded(RELEVANCE_MODEL.modelId)).toBe(true);
        expect(await isModelDownloaded(SECOND.modelId)).toBe(false);
        await until(() => notificationIds().length === 2);
        expect(notificationIds()[0]).toBe(`model-download-error:${SECOND.modelId}`);
        expect(scheduled.mock.calls[0][0].content).toMatchObject({ title: 'Download failed (Beta)', body: 'Check your connection and try again.' });

        // Try again queues the failed model afresh.
        startModelDownloads({ modelIds: [SECOND.modelId] });
        expect(downloadsOf()[SECOND.modelId]).toMatchObject({ status: 'queued', failure: null });
        await started(3);
        last().finish();
        await until(() => !isDownloadInProgress());
        expect(await isModelDownloaded(SECOND.modelId)).toBe(true);
    });

    it('a server error removes the partial file and says the server had a problem', async () => {
        startModelDownloads({ modelIds: [SECOND.modelId] });
        await started();
        last().finish(503);
        await until(() => downloadsOf()[SECOND.modelId]?.status === 'failed');

        expect(downloadsOf()[SECOND.modelId].failure).toBe('server');
        expect(new fileSystemModule.File(last().path).exists).toBe(false);
        expect(downloads).toHaveLength(1);
        await until(() => scheduled.mock.calls.length === 1);
        expect(scheduled.mock.calls[0][0].content.body).toBe('The download server had a problem. Try again later.');
    });
});

describe('cancelModelDownload', () => {
    it('one model: the running one stops with no failure, even when its task rejects afterwards, and the next one starts', async () => {
        startModelDownloads();
        await started();
        last().onProgress({ totalBytesWritten: 3, totalBytesExpectedToWrite: 4 });
        const text = last();
        await cancelModelDownload(SECOND.modelId);

        expect(text.cancelAsync).toHaveBeenCalledTimes(1);
        expect(downloadsOf()[SECOND.modelId]).toBeUndefined();
        await started(2);
        expect(last().url).toBe(RELEVANCE_MODEL.modelUrl);
        expect(activeHolds()).toEqual(['model-download']);

        // The native session rejects a moment after the cancel: that must not become a failure.
        text.fail(new Error('Download has been aborted'));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(downloadsOf()[SECOND.modelId]).toBeUndefined();
        expect(downloadsOf()[RELEVANCE_MODEL.modelId]).toMatchObject({ status: 'downloading' });
        expect(captured).not.toHaveBeenCalled();
        expect(scheduled).not.toHaveBeenCalled();

        last().finish();
        await until(() => !isDownloadInProgress());
        expect(activeHolds()).toEqual([]);
    });

    it('one queued model: it leaves the queue and the running one carries on', async () => {
        startModelDownloads();
        await started();
        await cancelModelDownload(RELEVANCE_MODEL.modelId);
        expect(downloadsOf()[RELEVANCE_MODEL.modelId]).toBeUndefined();
        last().finish();
        await until(() => !isDownloadInProgress());
        expect(downloads).toHaveLength(1);
        expect(activeHolds()).toEqual([]);
    });

    it('everything: the queue empties, the hold goes, and a task that resolves with nothing is not a failure', async () => {
        startModelDownloads();
        await started();
        last().cancelAsync.mockImplementation(async () => last().resolveCancelled());
        await cancelModelDownload();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        expect(downloadsOf()).toEqual({});
        expect(isDownloadInProgress()).toBe(false);
        expect(activeHolds()).toEqual([]);
        expect(getDownloadBytes()).toEqual({ doneBytes: 0, totalBytes: 0 });
        expect(captured).not.toHaveBeenCalled();
        expect(scheduled).not.toHaveBeenCalled();
        expect(downloads).toHaveLength(1);
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
        expect(downloadsOf()[SECOND.modelId]).toMatchObject({ status: 'downloading' });
        expect(activeHolds()).toEqual(['model-download']);

        last().finish();
        await started(3);
        last().finish();
        await until(() => !isDownloadInProgress());
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

describe('restoreOnDeviceIfRunnable: a local Cloud fallback ends once On this phone can run again', () => {
    const cachedPersona = (processingMode: ProcessingMode) =>
        useUserStore.setState({ userPersona: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode }) });
    /** The server persona's mode; the default fixture is not relied on. */
    const serverMode = (processingMode: ProcessingMode) =>
        server.use(
            graphql.query('GetUserPersona', () =>
                HttpResponse.json({ data: { userPersonaByUserId: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode }) } }),
            ),
        );

    beforeEach(async () => {
        useUserStore.setState({ userId: FIXTURE_ACCOUNT.userId });
        await signInFixtureAccount();
        placeDownloadedModel(RELEVANCE_MODEL.modelId);
        cachedPersona(ProcessingMode.OnDevice);
        serverMode(ProcessingMode.OnDevice);
        // Boot with Apple Intelligence still getting ready: the boot rule falls back to Cloud locally.
        installOnDeviceLlm({ availability: { available: false, reason: 'modelNotReady' } });
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice, modelState: 'downloaded', downloadProgress: 100 });
        await retireLegacyModels();
        expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
    });

    afterEach(async () => {
        useUserStore.setState({ userPersona: null });
    });

    it('moves the phone back to OnDevice locally and sends no mutation', async () => {
        const sent = recordModeUpdates();
        setOnDeviceLlmAvailability({ available: true, reason: null });
        await expect(restoreOnDeviceIfRunnable()).resolves.toBe(true);
        expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);
        expect(sent).toEqual([]);
    });

    it('stays on Cloud while On this phone still cannot run', async () => {
        await expect(restoreOnDeviceIfRunnable()).resolves.toBe(false);
        expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
    });

    it('stays on Cloud when the cached persona says Cloud', async () => {
        cachedPersona(ProcessingMode.Cloud);
        setOnDeviceLlmAvailability({ available: true, reason: null });
        await expect(restoreOnDeviceIfRunnable()).resolves.toBe(false);
        expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
    });

    it('stays on Cloud when the reader picked Private cloud and only the server knows it, and refreshes the cache', async () => {
        serverMode(ProcessingMode.Cloud);
        setOnDeviceLlmAvailability({ available: true, reason: null });
        await expect(restoreOnDeviceIfRunnable()).resolves.toBe(false);
        expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
        expect(useUserStore.getState().userPersona?.processingMode).toBe(ProcessingMode.Cloud);
    });

    it('moves back even while another model downloads: the phone can already run', async () => {
        setOnDeviceLlmAvailability({ available: true, reason: null });
        startModelDownloads({ modelIds: [SECOND.modelId] });
        await started();
        await expect(restoreOnDeviceIfRunnable()).resolves.toBe(true);
        expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);
    });

    it('stays on Cloud when the server cannot be reached', async () => {
        server.use(graphql.query('GetUserPersona', () => HttpResponse.json({ errors: [{ message: 'down' }] })));
        setOnDeviceLlmAvailability({ available: true, reason: null });
        await expect(restoreOnDeviceIfRunnable()).resolves.toBe(false);
        expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
    });
});
