/* eslint-disable @typescript-eslint/no-require-imports */
// Boot-time retirement of on-device models (`retireLegacyModels`): the retired ids' files are deleted, a retired
// selection is remapped at hydrate, and an OnDevice user without BOTH models on disk falls back to Cloud LOCALLY
// ONLY (the server persona keeps the on-device intent). Real modelManager over chat's in-memory expo-file-system, real store, settings
// rows, user store and Apollo over MSW. Faults: a one-call spy on the real deleteBaseModel (R23) and a GraphQL error.
import { waitFor } from '@testing-library/react-native';
import { retireLegacyModels } from '@/lib/mera-protocol-toolkit/core/retire-models';
import * as modelManager from '@/lib/mera-protocol-toolkit/core/modelManager';
import { DEFAULT_MODEL_ID, RELEVANCE_MODEL, RETIRED_MODEL_IDS, TEXT_MODEL } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { fileSystemModule, placeModelFile, resetFileSystem } from '@/test/integration/chat/_helpers';
import { FIXTURE_ACCOUNT, graphql, HttpResponse, server, signInFixtureAccount } from '@/test/helpers';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);

const { Directory, File, Paths } = fileSystemModule;
const modelDirExists = (id: string) => new Directory(Paths.cache, 'mera-models', id).exists;
const store = () => useMeraProtocolStore.getState();
const SELECTED = DEFAULT_MODEL_ID;

/** Puts the model on disk the way a finished download leaves it: the file and the ready manifest. */
async function putModelOnDisk(modelId: string): Promise<void> {
    placeModelFile(modelId);
    await new File(Paths.cache, 'mera-models', modelId, 'manifest.json').write(
        JSON.stringify({ modelId, version: '1.0.0', sizeBytes: 4, quantization: 'Q4_K_M', downloadedAt: '2026-10-09T00:00:00Z', ready: true }),
    );
}

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

let captured: jest.SpyInstance;

beforeEach(async () => {
    resetFileSystem();
    useMeraProtocolStore.setState({
        processingMode: ProcessingMode.OnDevice,
        selectedModelId: SELECTED,
        modelState: 'downloaded',
        downloadProgress: 100,
    });
    useUserStore.setState({ userId: FIXTURE_ACCOUNT.userId });
    await signInFixtureAccount();
    captured = jest.spyOn(logger, 'captureException').mockReturnValue('');
});

afterEach(async () => {
    // Settings writes are fired without awaiting; let them land before the DB resets.
    await new Promise((r) => setTimeout(r, 25));
    jest.restoreAllMocks();
});

/** Both on-device models on disk, as a finished download pair leaves them. */
async function putBothOnDisk(): Promise<void> {
    await putModelOnDisk(TEXT_MODEL.modelId);
    await putModelOnDisk(RELEVANCE_MODEL.modelId);
}

describe('retired model files', () => {
    it('deletes the directory of every retired id and leaves the on-device models alone', async () => {
        for (const id of RETIRED_MODEL_IDS) placeModelFile(id);
        await putBothOnDisk();
        await retireLegacyModels();
        for (const id of RETIRED_MODEL_IDS) expect(modelDirExists(id)).toBe(false);
        expect(modelDirExists(TEXT_MODEL.modelId)).toBe(true);
        expect(modelDirExists(RELEVANCE_MODEL.modelId)).toBe(true);
    });

    it('a selection on a retired id is remapped to the default at hydrate and the row rewritten', async () => {
        const retired = 'mera-qwen3.5-2b';
        await setSetting('mera_selected_model_id', retired);
        await store().hydrateFromDb();
        expect(store().selectedModelId).toBe(DEFAULT_MODEL_ID);
        // The rewrite is fired without awaiting.
        await waitFor(async () => expect(await getSetting('mera_selected_model_id')).toBe(DEFAULT_MODEL_ID));
    });

    it('a phone on the old single-model catalogue ends on Cloud locally, retired files gone, server untouched', async () => {
        const retired = 'mera-lfm2-2.6b';
        await putModelOnDisk(retired);
        await setSetting('mera_selected_model_id', retired);
        await setSetting('mera_processing_mode', ProcessingMode.OnDevice);
        await store().hydrateFromDb();
        const sent = recordModeUpdates();

        await retireLegacyModels();

        expect(modelDirExists(retired)).toBe(false);
        expect(store().selectedModelId).toBe(DEFAULT_MODEL_ID);
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
        expect(sent).toEqual([]);
    });

    it('a failed delete is reported and does not stop the mode check', async () => {
        jest.spyOn(modelManager, 'deleteBaseModel').mockRejectedValueOnce(new Error('busy'));
        await retireLegacyModels();
        expect(captured).toHaveBeenCalledTimes(1);
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
    });
});

describe('the OnDevice rule: both models on disk', () => {
    it('keeps OnDevice and sends nothing when both models are on disk', async () => {
        await putBothOnDisk();
        const sent = recordModeUpdates();
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.OnDevice);
        expect(store().modelState).toBe('downloaded');
        expect(sent).toEqual([]);
    });

    it('one model alone is not enough: Cloud locally, nothing sent', async () => {
        await putModelOnDisk(TEXT_MODEL.modelId);
        const sent = recordModeUpdates();
        await retireLegacyModels();
        expect(store()).toMatchObject({ processingMode: ProcessingMode.Cloud, modelState: 'not_downloaded', downloadProgress: 0 });
        expect(sent).toEqual([]);
        // The settings write is fired without awaiting.
        await waitFor(async () => expect(await getSetting('mera_processing_mode')).toBe(ProcessingMode.Cloud));
    });

    it('treats a manifest it cannot read as no model on disk', async () => {
        await putModelOnDisk(TEXT_MODEL.modelId);
        placeModelFile(RELEVANCE_MODEL.modelId);
        await new File(Paths.cache, 'mera-models', RELEVANCE_MODEL.modelId, 'manifest.json').write('not json');
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
    });

    it('does nothing to the mode of a Cloud user', async () => {
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud, modelState: 'not_downloaded' });
        const sent = recordModeUpdates();
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
        expect(sent).toEqual([]);
    });
});
