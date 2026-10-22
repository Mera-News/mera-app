/* eslint-disable @typescript-eslint/no-require-imports */
// You > Settings > Mera Protocol through `useMeraProtocolSettings`: loading the persona's processing mode,
// switching it, the Kev row and its download, the built-in model's status row per platform (D37), Skip notes
// (D42), and deleting Kev. Real hook, stores, Apollo over MSW, auth client, in-memory DB, the REAL modelManager on
// chat's in-memory file system (the model "on disk" is a manifest the manager reads) and the real toast queue.
// Mocked: the file system module (an expo-* edge), the built-in model module (scripted per platform) and the
// llama.rn / device natives from the setup.
import { act, configure, renderHook, waitFor } from '@testing-library/react-native';
import {
    MODELS_SECTION_KEYS,
    NATIVE_REASON_KEYS,
    useMeraProtocolSettings,
} from '@/components/custom/config-mera/useMeraProtocolSettings';
import { resetInferenceStats } from '@/lib/mera-protocol-toolkit/core/inference-stats';
import i18n from '@/lib/i18n';
import database from '@/lib/database';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
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
import { installOnDeviceLlm, setOnDeviceLlmAvailability } from '@/test/helpers/on-device-llm';
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
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

// MSW answers on real I/O while the fake clock ticks, so the default one-second wait is too tight.
configure({ asyncUtilTimeout: 20_000 });

const protocol = () => useMeraProtocolStore.getState();

const KEV_ID = MODEL_CATALOG[0].modelId;
const available = { available: true, reason: null } as const;

/** Puts the on-device model (Kev) on disk the way a finished download leaves it. */
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
        // Apple Intelligence, available, unless a test installs otherwise.
        installOnDeviceLlm({ platformModel: 'afm', availability: available });
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
            expect(result.current.onDeviceIntent).toBe(true);
            expect(toastTitles()).toEqual([]);
        });

        it('a persona on-device WITHOUT the model: the mode stays cloud, the intent is kept', async () => {
            serverMode(ProcessingMode.OnDevice);

            const { result } = await mountLoaded();

            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            // Kept, so the picker and the download rows show.
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
            // The built-in model not ready: the phone is on Private cloud locally while the server keeps the intent.
            installOnDeviceLlm({ availability: { available: false, reason: 'modelNotReady' } });
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
            installOnDeviceLlm({ availability: { available: false, reason: 'modelNotReady' } });
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

        it('looking at On this phone and back at Private cloud, with no model: nothing is sent and no toast', async () => {
            resetFileSystem();
            serverMode(ProcessingMode.Cloud);
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();

            await act(async () => {
                await result.current.selectMode(ProcessingMode.OnDevice);
            });
            await act(async () => {
                await result.current.selectMode(ProcessingMode.Cloud);
            });

            expect(result.current.onDeviceIntent).toBe(false);
            expect(sent).toEqual([]);
            expect(toastTitles()).toEqual([]);
        });

        it('back at Private cloud while a promoting download runs: CLOUD is written, since the download saved On this phone', async () => {
            resetFileSystem();
            serverMode(ProcessingMode.Cloud);
            const sent = recordModeUpdates();
            jest.spyOn(downloadService, 'willPromoteWhenDone').mockReturnValue(true);
            const { result } = await mountLoaded();
            expect(result.current.onDeviceIntent).toBe(true);

            await act(async () => {
                await result.current.selectMode(ProcessingMode.Cloud);
            });

            expect(sent.map((s) => s.mode)).toEqual(['CLOUD']);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('the model rows and their downloads', () => {
        let started: Array<{ modelIds?: string[]; promote?: boolean } | undefined>;
        beforeEach(async () => {
            await signInFixtureAccount();
            serverMode(ProcessingMode.OnDevice);
            started = [];
            jest.spyOn(downloadService, 'startModelDownloads').mockImplementation((opts) => {
                started.push(opts);
            });
        });

        it('one download row, Kev, with its size and state, Beta; the built-in model is a status row with no download', async () => {
            placeDownloadedModel(KEV_ID);
            const { result } = await mountLoaded();
            const { relevanceModel, builtInStatus } = result.current;
            expect(MODEL_CATALOG).toHaveLength(1);
            expect(relevanceModel).toMatchObject({ modelId: KEV_ID, sizeBytes: MODEL_CATALOG[0].sizeBytes, onDisk: true, download: null, beta: true });
            expect(builtInStatus).toEqual({ name: 'Apple Intelligence', available: true, reason: null, beta: true });
            expect(result.current).not.toHaveProperty('textOptions');
            expect(result.current).not.toHaveProperty('selectEngine');
        });

        it('Download on a row downloads that model only, with the reader\'s on-device intent as promote', async () => {
            const { result } = await mountLoaded();
            await act(async () => {
                await result.current.handleDownload(KEV_ID);
            });
            expect(started).toEqual([{ modelIds: [KEV_ID], promote: true }]);
        });

        it('a cloud reader downloads without promote', async () => {
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            await act(async () => {
                await result.current.handleDownload(KEV_ID);
            });
            expect(started).toEqual([{ modelIds: [KEV_ID], promote: false }]);
        });

        it('a row follows its own download: queued, downloading, failed, and back to idle', async () => {
            (downloadService.startModelDownloads as jest.Mock).mockRestore();
            const resolveDownload = jest.spyOn(require('@/lib/mera-protocol-toolkit/core/modelManager'), 'downloadBaseModel')
                .mockImplementation(() => new Promise(() => {}));
            const { result } = await mountLoaded();
            act(() => downloadService.startModelDownloads({ modelIds: [KEV_ID] }));
            await waitFor(() => expect(result.current.relevanceModel.download?.status).toBe('downloading'));
            await act(async () => {
                await downloadService.cancelModelDownload();
            });
            expect(result.current.relevanceModel.download).toBeNull();
            resolveDownload.mockRestore();
        });

        it('a load failure of a model on disk is not a download failure', async () => {
            putModelsOnDisk();
            const { result } = await mountLoaded();
            act(() => protocol().setModelError('Failed to load model'));
            expect(result.current.relevanceModel.download).toBeNull();
        });

        it('picking Private cloud mid-download tells the download not to promote', async () => {
            const promoteFlag = jest.spyOn(downloadService, 'setPromoteWhenDone');
            const { result } = await mountLoaded();
            await act(async () => {
                await result.current.selectMode(ProcessingMode.Cloud);
            });
            expect(promoteFlag).toHaveBeenLastCalledWith(false);
        });

        it('on mobile data: asks first with that model\'s size, and "Wait for Wi-Fi" starts nothing', async () => {
            jest.spyOn(NetInfo, 'fetch').mockResolvedValue({ type: 'cellular', isConnected: true } as never);
            useDialogQueue.setState({ queue: [] });
            const { result } = await mountLoaded();

            let pending!: Promise<void>;
            act(() => {
                pending = result.current.handleDownload(KEV_ID);
            });
            await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
            const dialog = useDialogQueue.getState().queue[0];
            expect(dialog.title).toBe('Download on mobile data?');
            expect(dialog.body).toBe('This uses 3.0 GB of data.');
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
                pending = result.current.handleDownload(KEV_ID);
            });
            await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
            expect(useDialogQueue.getState().queue[0].body).toBe('This uses 3.0 GB of data.');
            await act(async () => {
                settleDialog(useDialogQueue.getState().queue[0].id, true);
                await pending;
            });
            expect(started).toEqual([{ modelIds: [KEV_ID], promote: true }]);
        });

        it('on Wi-Fi: no question', async () => {
            jest.spyOn(NetInfo, 'fetch').mockResolvedValue({ type: 'wifi', isConnected: true } as never);
            useDialogQueue.setState({ queue: [] });
            const { result } = await mountLoaded();
            await act(async () => {
                await result.current.handleDownload(KEV_ID);
            });
            expect(useDialogQueue.getState().queue).toEqual([]);
            expect(started).toHaveLength(1);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('the built-in model status row, per platform (no picker, D37)', () => {
        beforeEach(async () => {
            await signInFixtureAccount();
        });

        it('iOS: Apple Intelligence, ready, Beta', async () => {
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            expect(result.current.builtInStatus).toEqual({ name: 'Apple Intelligence', available: true, reason: null, beta: true });
        });

        it('Android: Gemini Nano', async () => {
            installOnDeviceLlm({ platformModel: 'nano', availability: available });
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            expect(result.current.builtInStatus?.name).toBe('Gemini Nano');
        });

        it('a phone with neither: no row, and the phone cannot run On this phone', async () => {
            installOnDeviceLlm({ platformModel: null, availability: { available: false, reason: 'unsupportedPlatform' } });
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            expect(result.current.builtInStatus).toBeNull();
            await waitFor(() => expect(result.current.deviceSupported).toBe(false));
            expect(result.current.requirementsResult?.failedCheck).toBe('built_in');
        });

        it('unsupportedPlatform hides the row too', async () => {
            installOnDeviceLlm({ platformModel: 'afm', availability: { available: false, reason: 'unsupportedPlatform' } });
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            expect(result.current.builtInStatus).toBeNull();
        });

        it.each(Object.entries(NATIVE_REASON_KEYS))('%s: the row shows its reason, naming that model', async (code, key) => {
            installOnDeviceLlm({ platformModel: 'nano', availability: { available: false, reason: code as never } });
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            const nano = result.current.builtInStatus!;
            expect(nano.available).toBe(false);
            expect(nano.reason).toBe(i18n.t(key, { name: 'Gemini Nano' }));
            expect(nano.reason).toContain('Gemini Nano');
        });

        it('a reason the phone can fix (switched off) is not "this phone can\'t run it"; one it cannot (not eligible) is', async () => {
            installOnDeviceLlm({ availability: { available: false, reason: 'appleIntelligenceNotEnabled' } });
            serverMode(ProcessingMode.Cloud);
            const first = await mountLoaded();
            await waitFor(() => expect(first.result.current.deviceSupported).toBe(true));
            first.unmount();

            installOnDeviceLlm({ availability: { available: false, reason: 'deviceNotEligible' } });
            const second = await mountLoaded();
            await waitFor(() => expect(second.result.current.deviceSupported).toBe(false));
        });

        it('the reason lines read as designed, on either platform', () => {
            const line = (code: keyof typeof NATIVE_REASON_KEYS, name = 'Apple Intelligence') => i18n.t(NATIVE_REASON_KEYS[code], { name });
            expect(line('deviceNotEligible')).toBe("This phone doesn't support Apple Intelligence.");
            expect(line('appleIntelligenceNotEnabled')).toBe('Turn on Apple Intelligence in Settings to use it.');
            expect(line('modelNotReady', 'Gemini Nano')).toBe('Gemini Nano is still getting ready. Try again later.');
            expect(line('appLanguageNotSupported')).toBe("Apple Intelligence doesn't support Mera's current language yet.");
            expect(line('deviceLanguageNotSupported', 'Gemini Nano')).toBe("Gemini Nano doesn't support this phone's language yet.");
            expect(line('osTooOld')).toBe("Apple Intelligence needs a newer version of this phone's software.");
            expect(line('needsSystemUpdate', 'Gemini Nano')).toBe('Gemini Nano needs a system update. Check for updates in Settings.');
            expect(line('unknown')).toBe("Apple Intelligence isn't available right now.");
        });

        it('a refresh follows the built-in model going away and coming back, locally only', async () => {
            placeDownloadedModel(KEV_ID);
            serverMode(ProcessingMode.OnDevice);
            const sent = recordModeUpdates();
            const promote = jest.spyOn(downloadService, 'promoteToOnDevice').mockResolvedValue(true);
            const { result } = await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);

            setOnDeviceLlmAvailability({ available: false, reason: 'appleIntelligenceNotEnabled' });
            await act(async () => {
                await result.current.refresh();
            });
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(true);
            // Everything needed is on disk, yet it cannot run: the section says Mera is on Private cloud.
            expect(result.current.waitingForNative).toBe(true);
            expect(result.current.waitingLine).toBe('Mera uses Private cloud until Apple Intelligence is ready.');
            expect(sent).toEqual([]);
            expect(promote).not.toHaveBeenCalled();

            setOnDeviceLlmAvailability(available);
            await act(async () => {
                await result.current.refresh();
            });
            expect(promote).toHaveBeenCalledTimes(1);
            expect(result.current.waitingForNative).toBe(false);
        });

        it('a phone that can run stays on On this phone while a download runs', async () => {
            placeDownloadedModel(KEV_ID);
            serverMode(ProcessingMode.OnDevice);
            jest.spyOn(downloadService, 'isDownloadInProgress').mockReturnValue(true);
            const { result } = await mountLoaded();
            await act(async () => {
                await result.current.refresh();
            });
            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);
        });

        it('coming back to the app re-reads the built-in model', async () => {
            let onChange: ((state: string) => void) | undefined;
            jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, cb: (state: string) => void) => {
                onChange = cb;
                return { remove: jest.fn() };
            }) as never);
            installOnDeviceLlm({ platformModel: 'afm', availability: { available: false, reason: 'appleIntelligenceNotEnabled' } });
            serverMode(ProcessingMode.Cloud);
            const { result } = await mountLoaded();
            expect(result.current.nativeAvailable).toBe(false);

            setOnDeviceLlmAvailability(available);
            await act(async () => {
                onChange?.('active');
            });
            await waitFor(() => expect(result.current.nativeAvailable).toBe(true));
        });

    });

    // ---------------------------------------------------------------------------------------------
    describe('names and Beta', () => {
        it('no string the model sections can show names a downloaded model; only Apple Intelligence or Gemini Nano', () => {
            const forbidden = /kev|qwen|two models|2 models/i;
            for (const name of ['Apple Intelligence', 'Gemini Nano']) {
                const args = { name, size: '3.0 GB', done: '1.1', total: '3.0', seconds: '1.2', tokPerSec: 20, count: 3 };
                for (const key of MODELS_SECTION_KEYS) {
                    expect({ key, text: i18n.t(key, args) }).toEqual({ key, text: expect.not.stringMatching(forbidden) });
                }
            }
        });

        it('the declined-request line names the built-in model and reads in the singular for one', () => {
            expect(i18n.t('meraProtocol.speedRefused', { name: 'Gemini Nano', count: 1 })).toBe('Gemini Nano declined 1 request');
            expect(i18n.t('meraProtocol.speedRefused', { name: 'Apple Intelligence', count: 3 })).toBe('Apple Intelligence declined 3 requests');
        });

        it('the delete and cellular confirms name no downloaded model', async () => {
            await signInFixtureAccount();
            putModelsOnDisk();
            serverMode(ProcessingMode.OnDevice);
            jest.spyOn(NetInfo, 'fetch').mockResolvedValue({ type: 'cellular', isConnected: true } as never);
            jest.spyOn(downloadService, 'startModelDownloads').mockImplementation(() => {});
            useDialogQueue.setState({ queue: [] });
            const { result } = await mountLoaded();
            const wording = (d: { title: string; body?: string; confirmLabel?: string; cancelLabel?: string }) =>
                `${d.title} ${d.body} ${d.confirmLabel} ${d.cancelLabel}`;
            for (const run of [() => result.current.handleDownload(KEV_ID), () => result.current.handleDeleteModel(KEV_ID)]) {
                let pending!: Promise<void>;
                act(() => {
                    pending = run();
                });
                await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
                const dialog = useDialogQueue.getState().queue[0];
                expect(wording(dialog)).not.toMatch(/kev|qwen|two models/i);
                await act(async () => {
                    settleDialog(dialog.id, false);
                    await pending;
                });
            }
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('Skip notes (D42), shown in both modes', () => {
        beforeEach(async () => {
            await signInFixtureAccount();
        });
        afterEach(() => {
            protocol().setSkipNotes(false);
        });

        it.each([ProcessingMode.OnDevice, ProcessingMode.Cloud])(
            '%s: off by default; on flips the store and re-pends nothing; off re-pends rows finalised without a note',
            async (mode) => {
                serverMode(mode);
                putModelsOnDisk();
                const scoring = require('@/lib/mera-protocol/scoring-service') as typeof import('@/lib/mera-protocol/scoring-service');
                const pipeline = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');
                const repend = jest.spyOn(scoring, 'rependSkippedNotes').mockResolvedValue(2);
                const sweep = jest.spyOn(pipeline, 'enqueueOrphanedReasons').mockResolvedValue();
                const { result } = await mountLoaded();
                expect(protocol().processingMode).toBe(mode);
                expect(result.current.skipNotes).toBe(false);

                act(() => result.current.toggleSkipNotes());
                expect(protocol().skipNotes).toBe(true);
                expect(repend).not.toHaveBeenCalled();

                act(() => result.current.toggleSkipNotes());
                expect(protocol().skipNotes).toBe(false);
                await waitFor(() => expect(repend).toHaveBeenCalledTimes(1));
                // The cloud's orphaned-reasons sweep is kicked now; on this phone the next pass's notes sweep writes them.
                if (mode === ProcessingMode.Cloud) await waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
                else expect(sweep).not.toHaveBeenCalled();
            },
        );

        it('the switch is stored under its own row, and a stored on survives a hydrate', async () => {
            protocol().setSkipNotes(true);
            await waitFor(async () => expect(await getSetting('mera_skip_notes')).toBe('true'));
            useMeraProtocolStore.setState({ skipNotes: false });
            await protocol().hydrateFromDb();
            expect(protocol().skipNotes).toBe(true);
        });

        it('an absent row is off', async () => {
            useMeraProtocolStore.setState({ skipNotes: true });
            await protocol().hydrateFromDb();
            expect(protocol().skipNotes).toBe(false);
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

        it('too little free space for one model: only that row is blocked, with its shortfall named', async () => {
            mockFreeBytes = 3.4e9;
            const { result } = await mountLoaded();
            await waitFor(() => expect(result.current.requirementsResult).not.toBeNull());

            // Not "this phone can't run it".
            expect(result.current.deviceSupported).toBe(true);
            // 3.0 GB + margin does not fit.
            expect(result.current.relevanceModel.storageShort).toBe(true);
            const needed = MODEL_CATALOG[0].sizeBytes + STORAGE_MARGIN_BYTES;
            expect(result.current.relevanceModel.freeUpSize).toBe(`${(Math.ceil((needed - 3.4e9) / 1e8) / 10).toFixed(1)} GB`);
        });

        it('a model already on disk is never short of space', async () => {
            mockFreeBytes = 0.1e9;
            putModelsOnDisk();
            const { result } = await mountLoaded();
            await waitFor(() => expect(result.current.requirementsResult).not.toBeNull());
            expect(result.current.relevanceModel.storageShort).toBe(false);
            expect(result.current.deviceSupported).toBe(true);
        });

        it('an unsupported phone (RAM) is not supported', async () => {
            mockTotalMemory = 2 * 1024 * 1024 * 1024;
            const { result } = await mountLoaded();
            await waitFor(() => expect(result.current.deviceSupported).toBe(false));
        });

        it('an unsupported device is never switched to on-device', async () => {
            mockTotalMemory = 2 * 1024 * 1024 * 1024;
            putModelsOnDisk();
            serverMode(ProcessingMode.Cloud);
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();
            await waitFor(() => expect(result.current.deviceSupported).toBe(false));
            await act(async () => {
                await result.current.selectMode(ProcessingMode.OnDevice);
            });
            expect(sent).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('deleting a model', () => {
        beforeEach(async () => {
            await signInFixtureAccount();
            putModelsOnDisk();
            serverMode(ProcessingMode.OnDevice);
            useDialogQueue.setState({ queue: [] });
        });

        /** Starts the delete, answers its confirm, and waits for it to finish. */
        async function deleteAnswering(
            result: { current: { handleDeleteModel: (id: string) => Promise<void> } },
            modelId: string,
            confirmed: boolean,
        ) {
            let pending!: Promise<void>;
            act(() => {
                pending = result.current.handleDeleteModel(modelId);
            });
            await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
            const dialog = useDialogQueue.getState().queue[0];
            await act(async () => {
                settleDialog(dialog.id, confirmed);
                await pending;
            });
            return dialog;
        }

        it('the relevance model: confirms in words, switches to Private cloud BEFORE removing only its file, and clears the intent', async () => {
            const diskAtSwitch: boolean[] = [];
            server.use(
                graphql.mutation('UpdateProcessingMode', async ({ variables }) => {
                    const input = (variables as { input: { userId: string; mode: string } }).input;
                    diskAtSwitch.push(await isModelDownloaded(KEV_ID));
                    return HttpResponse.json({
                        data: { updateProcessingMode: personaFor(Date.now(), { userId: input.userId, processingMode: input.mode as ProcessingMode }) },
                    });
                }),
            );
            const { result } = await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);

            const dialog = await deleteAnswering(result, KEV_ID, true);

            expect(dialog.title).toBe('Delete Mera relevance model?');
            expect(dialog.body).toBe('This removes it (3.0 GB) from this phone. Mera will use Private cloud.');
            expect(dialog.destructive).toBe(true);
            expect(diskAtSwitch).toEqual([true]);
            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(false);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(false);
            expect(result.current.relevanceModel.onDisk).toBe(false);
        });

        it('a refresh while the relevance delete runs does not promote the phone', async () => {
            installOnDeviceLlm({ availability: { available: false, reason: 'modelNotReady' } });
            const promote = jest.spyOn(downloadService, 'promoteToOnDevice').mockResolvedValue(true);
            resetFileSystem();
            placeDownloadedModel(KEV_ID);
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
                pending = result.current.handleDeleteModel(KEV_ID);
            });
            await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
            await act(async () => {
                settleDialog(useDialogQueue.getState().queue[0].id, true);
            });
            await waitFor(() => expect(result.current.isDeletingModel).toBe(true));

            setOnDeviceLlmAvailability(available);
            await act(async () => {
                await result.current.refresh();
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

            await deleteAnswering(result, KEV_ID, false);

            expect(sent).toEqual([]);
            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);
            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(true);
        });

        it('the cached persona follows the Private cloud fallback, but not a failed write', async () => {
            recordModeUpdates();
            const { result } = await mountLoaded();
            cachePersonaMode(ProcessingMode.OnDevice);
            await deleteAnswering(result, KEV_ID, true);
            expect(cachedMode()).toBe(ProcessingMode.Cloud);

            putModelsOnDisk();
            serverMode(ProcessingMode.OnDevice);
            server.use(mockGqlError('UpdateProcessingMode', 'INTERNAL_SERVER_ERROR'));
            const again = await mountLoaded();
            cachePersonaMode(ProcessingMode.OnDevice);
            await deleteAnswering(again.result, KEV_ID, true);
            // The server never heard CLOUD, so the cache still says what the server holds.
            expect(cachedMode()).toBe(ProcessingMode.OnDevice);
            // And the phone still falls back locally.
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
        });

        it('with the phone on Private cloud only because it cannot run: the server still hears CLOUD', async () => {
            installOnDeviceLlm({ availability: { available: false, reason: 'modelNotReady' } });
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(result.current.onDeviceIntent).toBe(true);

            await deleteAnswering(result, KEV_ID, true);

            expect(sent.map((s) => s.mode)).toEqual(['CLOUD']);
            await expect(isModelDownloaded(KEV_ID)).resolves.toBe(false);
            expect(result.current.onDeviceIntent).toBe(false);
        });

        it('while on cloud: the file leaves the disk and no mutation is sent', async () => {
            serverMode(ProcessingMode.Cloud);
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();

            await deleteAnswering(result, KEV_ID, true);

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
            return mountLoaded();
        }

        test('B5 Mera Protocol settings load from the local identity when the session is gone', async () => {
            const { result } = await loadWithoutSession();
            expect(toastTitles()).toEqual([]);
            expect(result.current.relevanceModel.onDisk).toBe(true);
        });
    });
});
