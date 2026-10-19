/* eslint-disable @typescript-eslint/no-require-imports */
// You > Settings > Mera Protocol through `useMeraProtocolSettings`: loading the persona's processing mode,
// switching it, the one download for both on-device models (Qwen text + Kev relevance), and deleting them. Real hook,
// stores, Apollo over MSW, auth client, in-memory DB, the REAL modelManager on chat's in-memory file system
// (the model "on disk" is a manifest the manager reads) and the real toast queue. Mocked: the file system
// module (an expo-* edge) and the llama.rn / device natives from the setup.
import { act, configure, renderHook, waitFor } from '@testing-library/react-native';
import { useMeraProtocolSettings } from '@/components/custom/config-mera/useMeraProtocolSettings';
import database from '@/lib/database';
import { setSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import * as downloadService from '@/lib/mera-protocol-toolkit/core/downloadService';
import { MODEL_CATALOG } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { isModelDownloaded } from '@/lib/mera-protocol-toolkit/core/modelManager';
import { STORAGE_MARGIN_BYTES } from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import NetInfo from '@react-native-community/netinfo';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { resetToastQueue, useToastQueue } from '@/lib/toast/toast-queue';
import { placeDownloadedModel, resetFileSystem } from '@/test/helpers/fs';
import {
    FIXTURE_ACCOUNT,
    graphql,
    HttpResponse,
    initI18nEn,
    mockGql,
    mockGqlError,
    server,
    signInFixtureAccount,
} from '@/test/helpers';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';

// expo-device with a settable RAM figure: the on-device requirement check reads it.
let mockTotalMemory: number | undefined;
jest.mock('expo-device', () => ({
    isDevice: true,
    osVersion: '18.0',
    get totalMemory() {
        return mockTotalMemory;
    },
}));
// Free space on the phone, settable per test. The setup's react-native-fs mock has no getFSInfo.
let mockFreeBytes = 100e9;
jest.mock('@dr.pogodin/react-native-fs', () => ({
    DocumentDirectoryPath: '/tmp/mera-test',
    CachesDirectoryPath: '/tmp/mera-test-cache',
    exists: jest.fn(() => Promise.resolve(false)),
    mkdir: jest.fn(() => Promise.resolve()),
    unlink: jest.fn(() => Promise.resolve()),
    stat: jest.fn(() => Promise.resolve({ size: 0 })),
    getFSInfo: jest.fn(() => Promise.resolve({ freeSpace: mockFreeBytes, totalSpace: 200e9 })),
    stopDownload: jest.fn(),
}));
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

// MSW answers on real I/O while the fake clock ticks, so the default one-second wait is too tight.
configure({ asyncUtilTimeout: 20_000 });

const protocol = () => useMeraProtocolStore.getState();

const TEXT_ID = MODEL_CATALOG[0].modelId;
const KEV_ID = MODEL_CATALOG[1].modelId;

/** Puts both on-device models on disk the way finished downloads leave them. */
function putModelsOnDisk(): void {
    MODEL_CATALOG.forEach((m) => placeDownloadedModel(m.modelId));
}

/** The server persona's processing mode. */
const serverMode = (mode: ProcessingMode) =>
    server.use(
        mockGql('GetUserPersona', (v: Record<string, unknown>) => ({
            userPersonaByUserId: personaFor(Date.now(), {
                userId: (v.userId as string) ?? FIXTURE_ACCOUNT.userId,
                processingMode: mode,
            }),
        })),
    );

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

const toastTitles = () =>
    useToastQueue.getState().entries.map((e) => {
        const first = (e.render({ id: e.id }) as { props: { children: { props: { children: unknown } }[] } }).props.children[0];
        return String(first.props.children);
    });

async function mountLoaded() {
    const hook = renderHook(() => useMeraProtocolSettings());
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    return hook;
}

const initialProtocol = {
    processingMode: ProcessingMode.Cloud,
    modelState: 'not_downloaded' as const,
    downloadProgress: 0,
};

/**
 * Lets background work land before the test ends. Settings writes are fired without awaiting, and a write
 * started under the fake clock needs the fake clock to finish: if the clock is restored first, the write never
 * completes and the next test's DB reset waits on it forever. This must run BEFORE the setup's own afterEach
 * (which restores real timers), which is why every test sits inside a describe: a nested afterEach runs first.
 */
async function settleBackgroundWork() {
    if ('clock' in (setTimeout as unknown as object)) await jest.advanceTimersByTimeAsync(200);
    else await new Promise((r) => setTimeout(r, 25));
    await database.write(async () => {});
}

describe('Mera Protocol settings', () => {
    beforeAll(async () => {
        await initI18nEn();
    });

    beforeEach(() => {
        mockTotalMemory = undefined;
        resetFileSystem();
        resetToastQueue();
        useMeraProtocolStore.setState(initialProtocol);
        useUserStore.setState({ userId: null });
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await settleBackgroundWork();
    });

    // ---------------------------------------------------------------------------------------------
    describe('loading', () => {
        beforeEach(async () => {
            await signInFixtureAccount();
        });

        it('a persona on-device with the model on disk: on-device and "downloaded"', async () => {
            putModelsOnDisk();
            serverMode(ProcessingMode.OnDevice);

            const { result } = await mountLoaded();

            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);
            expect(protocol().modelState).toBe('downloaded');
            expect(result.current.onDeviceIntent).toBe(true);
            expect(toastTitles()).toEqual([]);
        });

        it('a persona on-device WITHOUT the model: the mode stays cloud, the intent is kept', async () => {
            serverMode(ProcessingMode.OnDevice);

            const { result } = await mountLoaded();

            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(protocol().modelState).toBe('not_downloaded');
            // Kept, so the picker and the download section show.
            expect(result.current.onDeviceIntent).toBe(true);
        });

        it('a persona on cloud: cloud, no intent', async () => {
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(false);
        });

        it('a failing persona read shows "Load Failed" and still ends loading', async () => {
            server.use(mockGqlError('GetUserPersona', 'INTERNAL_SERVER_ERROR'));
            const { result } = await mountLoaded();
            expect(result.current.isLoading).toBe(false);
            expect(toastTitles()).toEqual(['Load Failed']);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('selectMode', () => {
        beforeEach(async () => {
            await signInFixtureAccount();
            putModelsOnDisk();
            serverMode(ProcessingMode.OnDevice);
        });

        it('cloud: sends UpdateProcessingMode with the account id and the mode, updates the store and says so', async () => {
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);

            await act(async () => {
                await result.current.selectMode(ProcessingMode.Cloud);
            });

            expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, mode: 'CLOUD' }]);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(false);
            expect(toastTitles()).toEqual(['Switched to cloud']);
        });

        it('a server error leaves the store unchanged and says so', async () => {
            const { result } = await mountLoaded();
            server.use(mockGqlError('UpdateProcessingMode', 'INTERNAL_SERVER_ERROR'));

            await act(async () => {
                await result.current.selectMode(ProcessingMode.Cloud);
            });

            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);
            expect(toastTitles()).toEqual(['Update Failed']);
            expect(result.current.isUpdatingMode).toBe(false);
        });

        it('choosing the mode already in force sends nothing', async () => {
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();

            await act(async () => {
                await result.current.selectMode(ProcessingMode.OnDevice);
            });

            expect(sent).toEqual([]);
        });

        it('on-device with no model yet: only the intent is recorded, nothing is sent and no toast', async () => {
            resetFileSystem();
            serverMode(ProcessingMode.Cloud);
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();

            await act(async () => {
                await result.current.selectMode(ProcessingMode.OnDevice);
            });

            expect(result.current.onDeviceIntent).toBe(true);
            expect(sent).toEqual([]);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(toastTitles()).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('the download', () => {
        let started: Array<{ promote?: boolean } | undefined>;
        beforeEach(async () => {
            await signInFixtureAccount();
            serverMode(ProcessingMode.OnDevice);
            started = [];
            jest.spyOn(downloadService, 'startModelDownloads').mockImplementation((opts) => {
                started.push(opts);
            });
        });

        it('with neither file on disk: the whole pair is missing and the reader\'s on-device intent is passed as promote', async () => {
            const { result } = await mountLoaded();
            expect(result.current.bothOnDisk).toBe(false);
            expect(result.current.anyOnDisk).toBe(false);
            expect(result.current.missingBytes).toBe(MODEL_CATALOG[0].sizeBytes + MODEL_CATALOG[1].sizeBytes);

            await act(async () => {
                await result.current.handleDownload();
            });

            expect(started).toEqual([{ promote: true }]);
        });

        it('with one file on disk: the button size is only what is still missing, and the row is ready', async () => {
            placeDownloadedModel(TEXT_ID);
            const { result } = await mountLoaded();

            expect(result.current.onDisk).toEqual({ [TEXT_ID]: true, [KEV_ID]: false });
            expect(result.current.missingBytes).toBe(MODEL_CATALOG[1].sizeBytes);
            expect(result.current.anyOnDisk).toBe(true);
            expect(result.current.bothOnDisk).toBe(false);
            // One file is not enough: the persona stays on Private cloud.
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
        });

        it('with both files on disk: nothing is missing', async () => {
            putModelsOnDisk();
            const { result } = await mountLoaded();
            expect(result.current.onDisk).toEqual({ [TEXT_ID]: true, [KEV_ID]: true });
            expect(result.current.missingBytes).toBe(0);
            expect(result.current.bothOnDisk).toBe(true);
        });

        it('a cloud reader downloads without promote', async () => {
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            await act(async () => {
                await result.current.handleDownload();
            });
            expect(started).toEqual([{ promote: false }]);
        });

        it('picking Private cloud mid-download tells the download not to promote', async () => {
            const promoteFlag = jest.spyOn(downloadService, 'setPromoteWhenDone');
            const { result } = await mountLoaded();

            await act(async () => {
                await result.current.selectMode(ProcessingMode.Cloud);
            });

            expect(promoteFlag).toHaveBeenLastCalledWith(false);
        });

        it('on mobile data: asks first, and a "Wait for Wi-Fi" starts nothing', async () => {
            jest.spyOn(NetInfo, 'fetch').mockResolvedValue({ type: 'cellular', isConnected: true } as never);
            useDialogQueue.setState({ queue: [] });
            const { result } = await mountLoaded();

            let pending!: Promise<void>;
            act(() => {
                pending = result.current.handleDownload();
            });
            await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
            const dialog = useDialogQueue.getState().queue[0];
            expect(dialog.title).toBe('Download on mobile data?');
            expect(dialog.body).toBe('This uses 5.8 GB of data.');
            expect(dialog.confirmLabel).toBe('Download');
            expect(dialog.cancelLabel).toBe('Wait for Wi-Fi');

            await act(async () => {
                settleDialog(dialog.id, false);
                await pending;
            });
            expect(started).toEqual([]);
        });

        it('on mobile data: "Download" starts it', async () => {
            jest.spyOn(NetInfo, 'fetch').mockResolvedValue({ type: 'cellular', isConnected: true } as never);
            useDialogQueue.setState({ queue: [] });
            const { result } = await mountLoaded();

            let pending!: Promise<void>;
            act(() => {
                pending = result.current.handleDownload();
            });
            await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
            await act(async () => {
                settleDialog(useDialogQueue.getState().queue[0].id, true);
                await pending;
            });
            expect(started).toEqual([{ promote: true }]);
        });

        it('on Wi-Fi: no question', async () => {
            jest.spyOn(NetInfo, 'fetch').mockResolvedValue({ type: 'wifi', isConnected: true } as never);
            useDialogQueue.setState({ queue: [] });
            const { result } = await mountLoaded();
            await act(async () => {
                await result.current.handleDownload();
            });
            expect(useDialogQueue.getState().queue).toEqual([]);
            expect(started).toHaveLength(1);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('storage and support', () => {
        beforeEach(async () => {
            await signInFixtureAccount();
            serverMode(ProcessingMode.OnDevice);
        });
        afterEach(() => {
            mockFreeBytes = 100e9;
        });

        it('too little free space: the row stays enabled, Download is blocked, and the shortfall is named', async () => {
            mockFreeBytes = 3e9;
            const { result } = await mountLoaded();
            await waitFor(() => expect(result.current.storageShort).toBe(true));

            // Not "this phone can't run it".
            expect(result.current.deviceSupported).toBe(true);
            const needed = result.current.missingBytes + STORAGE_MARGIN_BYTES;
            expect(result.current.freeUpSize).toBe(`${(Math.ceil((needed - 3e9) / 1e8) / 10).toFixed(1)} GB`);
        });

        it('an unsupported phone (RAM) is not supported, with no storage message', async () => {
            mockTotalMemory = 2 * 1024 * 1024 * 1024;
            const { result } = await mountLoaded();
            await waitFor(() => expect(result.current.deviceSupported).toBe(false));
            expect(result.current.storageShort).toBe(false);
        });

        it('an unsupported device is never switched to on-device', async () => {
            mockTotalMemory = 2 * 1024 * 1024 * 1024;
            putModelsOnDisk();
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();
            await waitFor(() => expect(result.current.deviceSupported).toBe(false));
            await act(async () => {
                await result.current.selectMode(ProcessingMode.OnDevice);
            });
            expect(sent).toEqual([]);
        });

        it('a failed download reads its kind from the error', async () => {
            const { result } = await mountLoaded();
            act(() => protocol().setModelError('Download failed: checksum mismatch'));
            expect(result.current.failureKind).toBe('damaged');
            act(() => protocol().setModelError('HTTP status 503'));
            expect(result.current.failureKind).toBe('server');
            act(() => protocol().setModelError('ENOSPC: no space left'));
            expect(result.current.failureKind).toBe('space');
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('deleting the models', () => {
        beforeEach(async () => {
            await signInFixtureAccount();
            putModelsOnDisk();
            serverMode(ProcessingMode.OnDevice);
            useDialogQueue.setState({ queue: [] });
        });

        /** Starts the delete, answers its confirm, and waits for it to finish. */
        async function deleteAnswering(result: { current: { handleDeleteModels: () => Promise<void> } }, confirmed: boolean) {
            let pending!: Promise<void>;
            act(() => {
                pending = result.current.handleDeleteModels();
            });
            await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
            const dialog = useDialogQueue.getState().queue[0];
            await act(async () => {
                settleDialog(dialog.id, confirmed);
                await pending;
            });
            return dialog;
        }

        it('confirms in words, then switches to Private cloud BEFORE removing both files', async () => {
            // The state of the disk at the moment the server hears "CLOUD".
            const diskAtSwitch: boolean[] = [];
            server.use(
                graphql.mutation('UpdateProcessingMode', async ({ variables }) => {
                    const input = (variables as { input: { userId: string; mode: string } }).input;
                    diskAtSwitch.push(
                        (await isModelDownloaded(TEXT_ID)) && (await isModelDownloaded(KEV_ID)),
                    );
                    return HttpResponse.json({
                        data: { updateProcessingMode: personaFor(Date.now(), { userId: input.userId, processingMode: input.mode as ProcessingMode }) },
                    });
                }),
            );
            const { result } = await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);

            const dialog = await deleteAnswering(result, true);

            expect(dialog.body).toBe('This removes the AI models (5.8 GB) from this phone. Mera will use Private cloud.');
            expect(dialog.destructive).toBe(true);
            expect(diskAtSwitch).toEqual([true]);
            await expect(isModelDownloaded(TEXT_ID)).resolves.toBe(false);
            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(false);
            expect(protocol().modelState).toBe('not_downloaded');
            expect(protocol().downloadProgress).toBe(0);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(false);
            expect(result.current.anyOnDisk).toBe(false);
        });

        it('cancelling the confirm changes nothing', async () => {
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();

            await deleteAnswering(result, false);

            expect(sent).toEqual([]);
            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);
            await expect(isModelDownloaded(TEXT_ID)).resolves.toBe(true);
            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(true);
        });

        it('falls back to cloud locally even when the mutation fails', async () => {
            const { result } = await mountLoaded();
            server.use(mockGqlError('UpdateProcessingMode', 'INTERNAL_SERVER_ERROR'));

            await deleteAnswering(result, true);

            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            await expect(isModelDownloaded(TEXT_ID)).resolves.toBe(false);
            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(false);
        });

        it('while on cloud: both files leave the disk and no mutation is sent', async () => {
            serverMode(ProcessingMode.Cloud);
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();

            await deleteAnswering(result, true);

            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(false);
            expect(sent).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('B5: the screen after the session is gone', () => {
        // Invariant 4: screens gate on LOCAL identity (userStore / cached_user_id), the session is only a fallback.
        // Here the cookie is gone but the device still knows who it is and the model is on disk.
        async function loadWithoutSession() {
            await setSetting('cached_user_id', FIXTURE_ACCOUNT.userId);
            useUserStore.setState({ userId: FIXTURE_ACCOUNT.userId });
            putModelsOnDisk();
            protocol().setModelState('not_downloaded');
            return mountLoaded();
        }

        test('B5 Mera Protocol settings load from the local identity when the session is gone', async () => {
            await loadWithoutSession();
            expect(protocol().modelState).toBe('downloaded');
        });
    });
});
