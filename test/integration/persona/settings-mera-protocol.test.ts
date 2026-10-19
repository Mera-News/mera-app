/* eslint-disable @typescript-eslint/no-require-imports */
// You > Settings > Mera Protocol through `useMeraProtocolSettings`: loading the persona's processing mode,
// switching it, the one Mera AI models download, the Chat and notes engine choice, and deleting the files. Real hook,
// stores, Apollo over MSW, auth client, in-memory DB, the REAL modelManager on chat's in-memory file system
// (the model "on disk" is a manifest the manager reads) and the real toast queue. Mocked: the file system
// module (an expo-* edge) and the llama.rn / device natives from the setup.
import { act, configure, renderHook, waitFor } from '@testing-library/react-native';
import {
    MODELS_SECTION_KEYS,
    NATIVE_REASON_KEYS,
    useMeraProtocolSettings,
} from '@/components/custom/config-mera/useMeraProtocolSettings';
import * as textEngine from '@/lib/mera-protocol-toolkit/core/text-engine';
import {
    getInferenceStats,
    hasAnyStat,
    recordCompletion,
    recordModelLoad,
    resetInferenceStats,
} from '@/lib/mera-protocol-toolkit/core/inference-stats';
import i18n from '@/lib/i18n';
import database from '@/lib/database';
import { setSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import * as downloadService from '@/lib/mera-protocol-toolkit/core/downloadService';
import { MODEL_CATALOG } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { isModelDownloaded } from '@/lib/mera-protocol-toolkit/core/modelManager';
import { STORAGE_MARGIN_BYTES } from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
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

/** Seeds the cached server persona the boot purge and restoreOnDeviceIfRunnable read. */
function cachePersonaMode(mode: ProcessingMode): void {
    useUserStore.getState().setUserPersona(
        personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode: mode }) as never,
    );
}
const cachedMode = () => useUserStore.getState().userPersona?.processingMode;

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
        textEngine.__resetTextEngineForTests();
        resetToastQueue();
        useMeraProtocolStore.setState(initialProtocol);
        useUserStore.setState({ userId: null, userPersona: null });
        resetInferenceStats();
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

        it('reopened while a download that will promote runs: the on-device intent shows, though the server says cloud', async () => {
            serverMode(ProcessingMode.Cloud);
            jest.spyOn(downloadService, 'willPromoteWhenDone').mockReturnValue(true);
            const { result } = await mountLoaded();
            expect(result.current.onDeviceIntent).toBe(true);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
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

        it('cloud: the cached persona follows, so the boot purge and the restore read the truth', async () => {
            recordModeUpdates();
            const { result } = await mountLoaded();
            cachePersonaMode(ProcessingMode.OnDevice);

            await act(async () => {
                await result.current.selectMode(ProcessingMode.Cloud);
            });

            expect(cachedMode()).toBe(ProcessingMode.Cloud);
        });

        it('split state (server on-device, phone on Private cloud): picking Private cloud writes CLOUD, clears the intent and the promote flag', async () => {
            // Only one file on disk: the phone is on Private cloud locally while the server keeps the intent.
            resetFileSystem();
            placeDownloadedModel(KEV_ID);
            const sent = recordModeUpdates();
            const promoteFlag = jest.spyOn(downloadService, 'setPromoteWhenDone');
            const { result } = await mountLoaded();
            cachePersonaMode(ProcessingMode.OnDevice);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(true);

            await act(async () => {
                await result.current.selectMode(ProcessingMode.Cloud);
            });

            expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, mode: 'CLOUD' }]);
            expect(result.current.onDeviceIntent).toBe(false);
            expect(promoteFlag).toHaveBeenLastCalledWith(false);
            expect(cachedMode()).toBe(ProcessingMode.Cloud);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
        });

        it('a failed write in the split state keeps the on-device intent the server still holds', async () => {
            resetFileSystem();
            placeDownloadedModel(KEV_ID);
            const { result } = await mountLoaded();
            server.use(mockGqlError('UpdateProcessingMode', 'INTERNAL_SERVER_ERROR'));

            await act(async () => {
                await result.current.selectMode(ProcessingMode.Cloud);
            });

            expect(result.current.onDeviceIntent).toBe(true);
            expect(toastTitles()).toEqual(['Update Failed']);
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
            expect(result.current.runnable).toBe(false);
            expect(result.current.onDiskBytes).toBe(0);
            expect(result.current.missingBytes).toBe(MODEL_CATALOG[0].sizeBytes + MODEL_CATALOG[1].sizeBytes);

            await act(async () => {
                await result.current.handleDownload();
            });

            expect(started).toEqual([{ promote: true }]);
        });

        it('with one file on disk: the button size is only what is still missing, and the row is ready', async () => {
            placeDownloadedModel(TEXT_ID);
            const { result } = await mountLoaded();

            expect(result.current.onDiskBytes).toBe(MODEL_CATALOG[0].sizeBytes);
            expect(result.current.missingBytes).toBe(MODEL_CATALOG[1].sizeBytes);
            // One row: the size is what is still missing while something is.
            expect(result.current.modelsSizeBytes).toBe(MODEL_CATALOG[1].sizeBytes);
            expect(result.current.runnable).toBe(false);
            // One file is not enough: the persona stays on Private cloud.
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
        });

        it('with both files on disk: nothing is missing', async () => {
            putModelsOnDisk();
            const { result } = await mountLoaded();
            // Nothing missing: the Download button is hidden (it shows only for missingBytes > 0)
            // and the one row shows what the files take, checked.
            expect(result.current.missingBytes).toBe(0);
            expect(result.current.runnable).toBe(true);
            expect(result.current.modelsSizeBytes).toBe(MODEL_CATALOG[0].sizeBytes + MODEL_CATALOG[1].sizeBytes);
            expect(result.current.modelsSizeBytes).toBe(result.current.onDiskBytes);
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
    describe('Chat and notes engine', () => {
        const available = { available: true, reason: null } as const;
        const spyAvailability = (a: { available: boolean; reason: string | null }) =>
            jest.spyOn(textEngine, 'nativeEngineAvailability').mockResolvedValue(a as never);

        beforeEach(async () => {
            await signInFixtureAccount();
        });

        it('Apple Intelligence available and the reader wants On this phone: switching to it promotes when it can run', async () => {
            spyAvailability(available);
            placeDownloadedModel(KEV_ID);
            serverMode(ProcessingMode.OnDevice);
            const promote = jest.spyOn(downloadService, 'promoteToOnDevice').mockResolvedValue(true);
            const { result } = await mountLoaded();
            // Kev alone cannot run with the Mera engine: Private cloud locally, intent kept.
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(true);
            expect(result.current.missingBytes).toBe(MODEL_CATALOG[0].sizeBytes);

            await act(async () => {
                await result.current.selectEngine('native');
            });

            expect(textEngine.peekTextEngine()).toBe('native');
            expect(promote).toHaveBeenCalledTimes(1);
            // Kev is all that is left to fetch, and it is on disk.
            expect(result.current.missingBytes).toBe(0);
            expect(result.current.runnable).toBe(true);
        });

        it('switching to an engine that cannot run falls back to Private cloud locally only and keeps the intent', async () => {
            spyAvailability(available);
            placeDownloadedModel(KEV_ID);
            await textEngine.setTextEngine('native');
            serverMode(ProcessingMode.OnDevice);
            const sent = recordModeUpdates();
            const promote = jest.spyOn(downloadService, 'promoteToOnDevice');
            const { result } = await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);

            await act(async () => {
                await result.current.selectEngine('mera');
            });

            expect(textEngine.peekTextEngine()).toBe('mera');
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(true);
            expect(sent).toEqual([]);
            expect(promote).not.toHaveBeenCalled();
            // Setting the engine deleted nothing.
            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(true);
            // The text model shows as still to download.
            expect(result.current.missingBytes).toBe(MODEL_CATALOG[0].sizeBytes);
            expect(result.current.modelsSizeBytes).toBe(MODEL_CATALOG[0].sizeBytes);
            expect(result.current.runnable).toBe(false);
        });

        it('round trip: Apple Intelligence then Mera AI models again brings the text model download back', async () => {
            spyAvailability(available);
            placeDownloadedModel(KEV_ID);
            serverMode(ProcessingMode.Cloud);
            jest.spyOn(downloadService, 'promoteToOnDevice').mockResolvedValue(true);
            const { result } = await mountLoaded();
            expect(result.current.missingBytes).toBe(MODEL_CATALOG[0].sizeBytes);

            await act(async () => {
                await result.current.selectEngine('native');
            });
            expect(result.current.missingBytes).toBe(0);

            await act(async () => {
                await result.current.selectEngine('mera');
            });
            expect(result.current.missingBytes).toBe(MODEL_CATALOG[0].sizeBytes);
            expect(result.current.runnable).toBe(false);
        });

        it('a refresh follows Apple Intelligence going away and coming back, locally only', async () => {
            const availability = spyAvailability(available);
            placeDownloadedModel(KEV_ID);
            await textEngine.setTextEngine('native');
            serverMode(ProcessingMode.OnDevice);
            const sent = recordModeUpdates();
            const promote = jest.spyOn(downloadService, 'promoteToOnDevice').mockResolvedValue(true);
            const { result } = await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);

            availability.mockResolvedValue({ available: false, reason: 'appleIntelligenceNotEnabled' } as never);
            await act(async () => {
                await result.current.refresh();
            });
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(true);
            expect(result.current.nativeReasonKey).toBe(NATIVE_REASON_KEYS.appleIntelligenceNotEnabled);
            // Nothing is missing, yet it cannot run: the section says Mera is on Private cloud.
            expect(result.current.missingBytes).toBe(0);
            expect(result.current.waitingForNative).toBe(true);
            expect(i18n.t('meraProtocol.modelsWaitingNative')).toBe('Mera uses Private cloud until Apple Intelligence is ready.');
            expect(sent).toEqual([]);
            expect(promote).not.toHaveBeenCalled();

            availability.mockResolvedValue(available as never);
            await act(async () => {
                await result.current.refresh();
            });
            expect(promote).toHaveBeenCalledTimes(1);
            expect(result.current.waitingForNative).toBe(false);
        });

        it('coming back to the app re-reads Apple Intelligence', async () => {
            let onChange: ((state: string) => void) | undefined;
            jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, cb: (state: string) => void) => {
                onChange = cb;
                return { remove: jest.fn() };
            }) as never);
            const availability = spyAvailability({ available: false, reason: 'appleIntelligenceNotEnabled' });
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            expect(result.current.nativeAvailable).toBe(false);

            availability.mockResolvedValue(available as never);
            await act(async () => {
                onChange?.('active');
            });
            await waitFor(() => expect(result.current.nativeAvailable).toBe(true));
        });

        it.each(Object.entries(NATIVE_REASON_KEYS))('%s: the Apple Intelligence row is unavailable with its reason', async (code, key) => {
            spyAvailability({ available: false, reason: code });
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            expect(result.current.showEngineGroup).toBe(true);
            expect(result.current.nativeAvailable).toBe(false);
            expect(result.current.nativeReasonKey).toBe(key);
        });

        it('the reason lines read as designed', () => {
            const line = (code: keyof typeof NATIVE_REASON_KEYS) => i18n.t(NATIVE_REASON_KEYS[code]);
            expect(line('deviceNotEligible')).toBe("This iPhone doesn't support Apple Intelligence.");
            expect(line('appleIntelligenceNotEnabled')).toBe('Turn on Apple Intelligence in Settings to use it.');
            expect(line('modelNotReady')).toBe('Apple Intelligence is still getting ready. Try again later.');
            expect(line('appLanguageNotSupported')).toBe("Apple Intelligence doesn't support Mera's current language yet.");
            expect(line('deviceLanguageNotSupported')).toBe("Apple Intelligence doesn't support this iPhone's language yet.");
            expect(line('osTooOld')).toBe('Apple Intelligence needs iOS 26 or later.');
            expect(line('unknown')).toBe("Apple Intelligence isn't available right now.");
        });

        it('unsupportedPlatform hides the whole group', async () => {
            spyAvailability({ available: false, reason: 'unsupportedPlatform' });
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            expect(result.current.showEngineGroup).toBe(false);
            expect(result.current.nativeReasonKey).toBeNull();
        });

        it('available: no reason line, the group shows', async () => {
            spyAvailability(available);
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            expect(result.current.showEngineGroup).toBe(true);
            expect(result.current.nativeAvailable).toBe(true);
            expect(result.current.nativeReasonKey).toBeNull();
        });

        it('no string the section can show names a model or says there are two', () => {
            const forbidden = /kev|qwen|two models|2 models/i;
            const args = { size: '5.8 GB', done: '1.1', total: '5.8', seconds: '1.2', tokPerSec: 20, count: 3 };
            for (const key of MODELS_SECTION_KEYS) {
                expect({ key, text: i18n.t(key, args) }).toEqual({ key, text: expect.not.stringMatching(forbidden) });
            }
        });

        it('the delete confirm and the cellular confirm name no model', async () => {
            const wording = (d: { title: string; body?: string; confirmLabel?: string; cancelLabel?: string }) =>
                `${d.title} ${d.body} ${d.confirmLabel} ${d.cancelLabel}`;
            // The cellular confirm: raised by a download on mobile data with files still missing.
            jest.spyOn(NetInfo, 'fetch').mockResolvedValue({ type: 'cellular', isConnected: true } as never);
            const started = jest.spyOn(downloadService, 'startModelDownloads').mockImplementation(() => {});
            serverMode(ProcessingMode.OnDevice);
            useDialogQueue.setState({ queue: [] });
            const missing = await mountLoaded();
            let download!: Promise<void>;
            act(() => {
                download = missing.result.current.handleDownload();
            });
            await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
            const cellular = useDialogQueue.getState().queue[0];
            expect(cellular.title).toBe('Download on mobile data?');
            expect(wording(cellular)).not.toMatch(/kev|qwen|two models/i);
            await act(async () => {
                settleDialog(cellular.id, false);
                await download;
            });
            expect(started).not.toHaveBeenCalled();
            missing.unmount();

            // The delete confirm: raised with both files on disk.
            placeDownloadedModel(TEXT_ID);
            placeDownloadedModel(KEV_ID);
            useDialogQueue.setState({ queue: [] });
            const { result } = await mountLoaded();
            let pending!: Promise<void>;
            act(() => {
                pending = result.current.handleDeleteModels();
            });
            await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
            const dialog = useDialogQueue.getState().queue[0];
            expect(dialog.title).toBe('Delete Mera AI models?');
            expect(wording(dialog)).not.toMatch(/kev|qwen|two models/i);
            await act(async () => {
                settleDialog(dialog.id, false);
                await pending;
            });
        });

        it('the declined-request line reads in the singular for one', () => {
            expect(i18n.t('meraProtocol.speedRefused', { count: 1 })).toBe('Apple Intelligence declined 1 request');
            expect(i18n.t('meraProtocol.speedRefused', { count: 3 })).toBe('Apple Intelligence declined 3 requests');
        });

        it('the engine reason for a download names no model', () => {
            expect(i18n.t('meraProtocol.engineUnavailableDownloading')).toBe('Unavailable while Mera AI models download');
        });

        it('switching engines drops the figures measured on the previous one', async () => {
            spyAvailability(available);
            serverMode(ProcessingMode.Cloud);
            recordModelLoad('text', 1200);
            recordCompletion({ label: 'reason', latencyMs: 900, genTokPerSec: 20 });
            expect(hasAnyStat(getInferenceStats())).toBe(true);
            const { result } = await mountLoaded();

            await act(async () => {
                await result.current.selectEngine('native');
            });

            expect(hasAnyStat(getInferenceStats())).toBe(false);
            expect(result.current.inferenceStats.genTokPerSec).toBeNull();
        });

        it('choosing the engine already in force keeps the figures', async () => {
            spyAvailability(available);
            serverMode(ProcessingMode.Cloud);
            recordCompletion({ label: 'reason', latencyMs: 900, genTokPerSec: 20 });
            const { result } = await mountLoaded();

            await act(async () => {
                await result.current.selectEngine('mera');
            });

            expect(getInferenceStats().genTokPerSec).toBe(20);
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

            expect(dialog.title).toBe('Delete Mera AI models?');
            expect(dialog.body).toBe('This removes Mera AI models (5.8 GB) from this phone. Mera will use Private cloud.');
            expect(dialog.destructive).toBe(true);
            expect(diskAtSwitch).toEqual([true]);
            await expect(isModelDownloaded(TEXT_ID)).resolves.toBe(false);
            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(false);
            expect(protocol().modelState).toBe('not_downloaded');
            expect(protocol().downloadProgress).toBe(0);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(false);
            expect(result.current.onDiskBytes).toBe(0);
        });

        it('an engine tap while the delete runs does not promote the phone', async () => {
            jest.spyOn(textEngine, 'nativeEngineAvailability').mockResolvedValue({ available: true, reason: null } as never);
            const promote = jest.spyOn(downloadService, 'promoteToOnDevice').mockResolvedValue(true);
            // Only the Apple Intelligence file is on disk: the phone is on Private cloud, the intent is kept,
            // and picking Apple Intelligence would make it runnable (and promote) if the delete did not block it.
            resetFileSystem();
            placeDownloadedModel(KEV_ID);
            // Hold the server write so the delete is mid-flight.
            let release!: () => void;
            const gate = new Promise<void>((r) => { release = r; });
            server.use(
                graphql.mutation('UpdateProcessingMode', async ({ variables }) => {
                    await gate;
                    const input = (variables as { input: { userId: string; mode: string } }).input;
                    return HttpResponse.json({
                        data: { updateProcessingMode: personaFor(Date.now(), { userId: input.userId, processingMode: input.mode as ProcessingMode }) },
                    });
                }),
            );
            const { result } = await mountLoaded();
            let pending!: Promise<void>;
            act(() => {
                pending = result.current.handleDeleteModels();
            });
            await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
            await act(async () => {
                settleDialog(useDialogQueue.getState().queue[0].id, true);
            });
            await waitFor(() => expect(result.current.isDeletingModel).toBe(true));

            await act(async () => {
                await result.current.selectEngine('native');
            });
            expect(promote).not.toHaveBeenCalled();

            await act(async () => {
                release();
                await pending;
            });
            expect(promote).not.toHaveBeenCalled();
            expect(result.current.isDeletingModel).toBe(false);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
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

        it('the cached persona follows the Private cloud fallback, but not a failed write', async () => {
            recordModeUpdates();
            const { result } = await mountLoaded();
            cachePersonaMode(ProcessingMode.OnDevice);
            await deleteAnswering(result, true);
            expect(cachedMode()).toBe(ProcessingMode.Cloud);

            putModelsOnDisk();
            serverMode(ProcessingMode.OnDevice);
            server.use(mockGqlError('UpdateProcessingMode', 'INTERNAL_SERVER_ERROR'));
            const again = await mountLoaded();
            cachePersonaMode(ProcessingMode.OnDevice);
            await deleteAnswering(again.result, true);
            // The server never heard CLOUD, so the cache still says what the server holds.
            expect(cachedMode()).toBe(ProcessingMode.OnDevice);
        });

        it('falls back to cloud locally even when the mutation fails', async () => {
            const { result } = await mountLoaded();
            server.use(mockGqlError('UpdateProcessingMode', 'INTERNAL_SERVER_ERROR'));

            await deleteAnswering(result, true);

            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            await expect(isModelDownloaded(TEXT_ID)).resolves.toBe(false);
            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(false);
        });

        it('with the phone on Private cloud only because the models cannot run: the server still hears CLOUD', async () => {
            // Server OnDevice but only one of the two files on disk: local Cloud, intent kept, trash shown.
            resetFileSystem();
            placeDownloadedModel(KEV_ID);
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(true);
            expect(result.current.onDiskBytes).toBeGreaterThan(0);

            await deleteAnswering(result, true);

            expect(sent.map((s) => s.mode)).toEqual(['CLOUD']);
            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(false);
            expect(result.current.onDeviceIntent).toBe(false);
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
