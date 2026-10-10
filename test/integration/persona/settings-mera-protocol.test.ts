/* eslint-disable @typescript-eslint/no-require-imports */
// You > Settings > Mera Protocol through `useMeraProtocolSettings`: loading the persona's processing mode,
// switching it, promoting an on-device intent once the model lands, and deleting the model. Real hook,
// stores, Apollo over MSW, auth client, in-memory DB, the REAL modelManager on chat's in-memory file system
// (the model "on disk" is a manifest the manager reads) and the real toast queue. Mocked: the file system
// module (an expo-* edge) and the llama.rn / device natives from the setup.
import { act, configure, renderHook, waitFor } from '@testing-library/react-native';
import { useMeraProtocolSettings } from '@/components/custom/config-mera/useMeraProtocolSettings';
import database from '@/lib/database';
import { setSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { isModelDownloaded } from '@/lib/mera-protocol-toolkit/core/modelManager';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { resetToastQueue, useToastQueue } from '@/lib/toast/toast-queue';
import {
    fileSystemModule,
    placeModelFile,
    resetFileSystem,
} from '@/test/integration/chat/_helpers';
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
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

// MSW answers on real I/O while the fake clock ticks, so the default one-second wait is too tight.
configure({ asyncUtilTimeout: 20_000 });

const protocol = () => useMeraProtocolStore.getState();

/** Puts the selected model on disk the way a finished download leaves it: the file and the ready manifest. */
async function putModelOnDisk(): Promise<void> {
    const id = protocol().selectedModelId;
    placeModelFile(id);
    await new fileSystemModule.File(fileSystemModule.Paths.cache, 'mera-models', id, 'manifest.json').write(
        JSON.stringify({ modelId: id, ready: true }),
    );
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
            await putModelOnDisk();
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
            await putModelOnDisk();
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
    describe('auto-promote', () => {
        beforeEach(async () => {
            await signInFixtureAccount();
            serverMode(ProcessingMode.OnDevice);
        });

        it('intent on-device + supported device + the model lands: UpdateProcessingMode(ON_DEVICE) is sent ONCE', async () => {
            const sent = recordModeUpdates();
            // No model yet: the mode stays cloud, the intent is kept.
            await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(sent).toEqual([]);

            // The download service reports completion.
            await putModelOnDisk();
            act(() => protocol().setModelState('downloaded'));

            await waitFor(() => expect(protocol().processingMode).toBe(ProcessingMode.OnDevice));
            expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, mode: 'ON_DEVICE' }]);
            // Settled: no further sends.
            await new Promise((r) => setTimeout(r, 50));
            expect(sent).toHaveLength(1);
        });

        it('an unsupported device is never promoted', async () => {
            // 2 GB of RAM fails the 6 GB requirement.
            mockTotalMemory = 2 * 1024 * 1024 * 1024;
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();
            await waitFor(() => expect(result.current.deviceSupported).toBe(false));

            await putModelOnDisk();
            act(() => protocol().setModelState('downloaded'));
            await new Promise((r) => setTimeout(r, 100));

            expect(sent).toEqual([]);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
        });

        it('a failing promotion leaves the mode as it was', async () => {
            server.use(mockGqlError('UpdateProcessingMode', 'INTERNAL_SERVER_ERROR'));
            await mountLoaded();

            await putModelOnDisk();
            act(() => protocol().setModelState('downloaded'));
            await new Promise((r) => setTimeout(r, 100));

            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('deleting the model', () => {
        beforeEach(async () => {
            await signInFixtureAccount();
            await putModelOnDisk();
            serverMode(ProcessingMode.OnDevice);
        });

        it('while on-device: the model leaves the disk, the store and the server fall back to cloud', async () => {
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();
            expect(protocol().processingMode).toBe(ProcessingMode.OnDevice);

            await act(async () => {
                await result.current.confirmDeleteModel();
            });

            await expect(isModelDownloaded(protocol().selectedModelId)).resolves.toBe(false);
            expect(protocol().modelState).toBe('not_downloaded');
            expect(protocol().downloadProgress).toBe(0);
            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, mode: 'CLOUD' }]);
            expect(result.current.onDeviceIntent).toBe(false);
            expect(toastTitles()).toEqual(['Model Deleted']);
        });

        it('falls back to cloud locally even when the mutation fails', async () => {
            const { result } = await mountLoaded();
            server.use(mockGqlError('UpdateProcessingMode', 'INTERNAL_SERVER_ERROR'));

            await act(async () => {
                await result.current.confirmDeleteModel();
            });

            expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
            expect(protocol().modelState).toBe('not_downloaded');
            await expect(isModelDownloaded(protocol().selectedModelId)).resolves.toBe(false);
        });

        it('while on cloud: the model leaves the disk and no mutation is sent', async () => {
            serverMode(ProcessingMode.Cloud);
            const sent = recordModeUpdates();
            const { result } = await mountLoaded();

            await act(async () => {
                await result.current.confirmDeleteModel();
            });

            await expect(isModelDownloaded(protocol().selectedModelId)).resolves.toBe(false);
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
            await putModelOnDisk();
            protocol().setModelState('not_downloaded');
            return mountLoaded();
        }

        test('B5 Mera Protocol settings load from the local identity when the session is gone', async () => {
            await loadWithoutSession();
            expect(protocol().modelState).toBe('downloaded');
        });
    });
});
