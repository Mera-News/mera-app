/* eslint-disable @typescript-eslint/no-require-imports */
// The Apple Intelligence plus Kev path end to end: the reader asks for On this phone while Apple
// Intelligence is still getting ready, the relevance model download lands, and the phone stays on
// Private cloud locally. Once Apple Intelligence is ready, the next return to the foreground moves
// the phone to OnDevice, with no settings screen open. Real useModelLifecycle, download service,
// modelManager and stores; the download task, the native module, llama.rn and the server (MSW) are
// faked. The server persona echoes the last mode written, so the restore proves the intent was saved.
import { renderHook, waitFor } from '@testing-library/react-native';
import { useModelLifecycle } from '@/lib/hooks/useModelLifecycle';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import {
    cancelModelDownload,
    isDownloadInProgress,
    setPromoteWhenDone,
    startModelDownloads,
} from '@/lib/mera-protocol-toolkit/core/downloadService';
import { __resetTextEngineForTests, setTextEngine } from '@/lib/mera-protocol-toolkit/core/text-engine';
import { useAppStateStore } from '@/lib/stores/app-state-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { FIXTURE_ACCOUNT, graphql, HttpResponse, server, setAppState, signInFixtureAccount } from '@/test/helpers';
import { installOnDeviceLlm, setOnDeviceLlmAvailability } from '@/test/helpers/on-device-llm';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';
import { installLlama, resetFileSystem, setProcessingMode, until } from '@/test/integration/chat/_helpers';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);
jest.mock('@/lib/mera-protocol-toolkit/core/model-catalog', () => {
    const actual = jest.requireActual('@/lib/mera-protocol-toolkit/core/model-catalog');
    const TEXT = { ...actual.TEXT_MODEL, sizeBytes: 4 };
    const KEV = { ...actual.RELEVANCE_MODEL, sizeBytes: 4 };
    return { ...actual, TEXT_MODEL: TEXT, RELEVANCE_MODEL: KEV, MODEL_CATALOG: [TEXT, KEV] };
});
// Every download lands at once with a valid 4-byte file.
jest.mock('expo-file-system/legacy', () => ({
    FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
    createDownloadResumable: (_url: string, path: string) => ({
        downloadAsync: async () => {
            await new (require('@/test/helpers/fs').fileSystemModule.File)(path).write('GGUF');
            return { status: 200, uri: path };
        },
        cancelAsync: async () => {},
    }),
}));

const protocol = () => useMeraProtocolStore.getState();
let serverMode: ProcessingMode;

beforeEach(async () => {
    resetFileSystem();
    installLlama(['unused']);
    serverMode = ProcessingMode.Cloud;
    server.use(
        graphql.mutation('UpdateProcessingMode', ({ variables }) => {
            const input = (variables as { input: { userId: string; mode: ProcessingMode } }).input;
            serverMode = input.mode;
            return HttpResponse.json({ data: { updateProcessingMode: personaFor(Date.now(), { userId: input.userId, processingMode: serverMode }) } });
        }),
        graphql.query('GetUserPersona', () =>
            HttpResponse.json({ data: { userPersonaByUserId: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode: serverMode }) } }),
        ),
    );
    useUserStore.setState({
        userId: FIXTURE_ACCOUNT.userId,
        userPersona: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode: ProcessingMode.Cloud }),
    });
    await signInFixtureAccount();
    await setTextEngine('afm');
    installOnDeviceLlm({ availability: { available: false, reason: 'modelNotReady' } });
    await setProcessingMode('cloud');
    protocol().setModelState('not_downloaded');
    setAppState('active');
    useAppStateStore.getState().setAppInitialized(true);
});

afterEach(async () => {
    await cancelModelDownload();
    setPromoteWhenDone(false);
    await setTextEngine('qwen');
    __resetTextEngineForTests();
    useUserStore.setState({ userPersona: null });
    useAppStateStore.getState().setAppInitialized(false);
    await inferenceQueue.stop();
});

it('a download that lands before Apple Intelligence is ready moves the phone to OnDevice on the first foreground after it is', async () => {
    renderHook(() => useModelLifecycle());
    startModelDownloads({ promote: true });
    await until(() => protocol().modelState === 'downloaded' && !isDownloadInProgress(), 20_000, 'download landed');

    // Landed, but On this phone cannot run yet: Private cloud locally, the intent saved.
    expect(protocol().processingMode).toBe(ProcessingMode.Cloud);
    expect(serverMode).toBe(ProcessingMode.OnDevice);

    setOnDeviceLlmAvailability({ available: true, reason: null });
    setAppState('background');
    setAppState('active');

    await waitFor(() => expect(protocol().processingMode).toBe(ProcessingMode.OnDevice), { timeout: 10_000 });
}, 60_000);
