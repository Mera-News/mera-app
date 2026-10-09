/* eslint-disable @typescript-eslint/no-require-imports */
// Boot-time retirement of on-device models (`retireLegacyModels`): the retired ids' files are deleted, a retired
// selection is remapped at hydrate, and an OnDevice user with no model on disk falls back to Cloud locally plus a
// best-effort UpdateProcessingMode. Real modelManager over chat's in-memory expo-file-system, real store, settings
// rows, user store and Apollo over MSW. Faults: a one-call spy on the real deleteBaseModel (R23) and a GraphQL error.
import { waitFor } from '@testing-library/react-native';
import { retireLegacyModels } from '@/lib/mera-protocol-toolkit/core/retire-models';
import * as modelManager from '@/lib/mera-protocol-toolkit/core/modelManager';
import { DEFAULT_MODEL_ID, RETIRED_MODEL_IDS } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { fileSystemModule, placeModelFile, resetFileSystem } from '@/test/integration/chat/_helpers';
import { FIXTURE_ACCOUNT, graphql, HttpResponse, mockGqlError, server, signInFixtureAccount } from '@/test/helpers';
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

describe('retired model files', () => {
    it('deletes the directory of every retired id and leaves the selected model alone', async () => {
        for (const id of RETIRED_MODEL_IDS) placeModelFile(id);
        await putModelOnDisk(SELECTED);
        await retireLegacyModels();
        for (const id of RETIRED_MODEL_IDS) expect(modelDirExists(id)).toBe(false);
        expect(modelDirExists(SELECTED)).toBe(true);
    });

    it('a selection on a retired id is remapped to the default at hydrate and the row rewritten', async () => {
        const retired = RETIRED_MODEL_IDS[0];
        await setSetting('mera_selected_model_id', retired);
        await store().hydrateFromDb();
        expect(store().selectedModelId).toBe(DEFAULT_MODEL_ID);
        // The rewrite is fired without awaiting.
        await waitFor(async () => expect(await getSetting('mera_selected_model_id')).toBe(DEFAULT_MODEL_ID));
    });

    it('a user who was on a retired model ends on Cloud, with the retired files gone', async () => {
        const retired = RETIRED_MODEL_IDS[0];
        await putModelOnDisk(retired);
        await setSetting('mera_selected_model_id', retired);
        await setSetting('mera_processing_mode', ProcessingMode.OnDevice);
        await store().hydrateFromDb();
        recordModeUpdates();

        await retireLegacyModels();

        expect(modelDirExists(retired)).toBe(false);
        expect(store().selectedModelId).toBe(DEFAULT_MODEL_ID);
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
    });

    it('a failed delete is reported and does not stop the mode check', async () => {
        jest.spyOn(modelManager, 'deleteBaseModel').mockRejectedValueOnce(new Error('busy'));
        recordModeUpdates();
        await retireLegacyModels();
        expect(captured).toHaveBeenCalledTimes(1);
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
    });
});

describe('the OnDevice rule', () => {
    it('keeps OnDevice and sends nothing when the selected model is on disk', async () => {
        await putModelOnDisk(SELECTED);
        const sent = recordModeUpdates();
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.OnDevice);
        expect(store().modelState).toBe('downloaded');
        expect(sent).toEqual([]);
    });

    it('moves an OnDevice user with no model on disk to Cloud, locally and on the server', async () => {
        const sent = recordModeUpdates();
        await retireLegacyModels();
        expect(store()).toMatchObject({ processingMode: ProcessingMode.Cloud, modelState: 'not_downloaded', downloadProgress: 0 });
        expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, mode: 'CLOUD' }]);
        expect(await getSetting('mera_processing_mode')).toBe(ProcessingMode.Cloud);
    });

    it('treats a manifest it cannot read as no model on disk', async () => {
        placeModelFile(SELECTED);
        await new File(Paths.cache, 'mera-models', SELECTED, 'manifest.json').write('not json');
        recordModeUpdates();
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

    it('keeps the local fall-back to Cloud when the server write fails (boot must not fail on it)', async () => {
        server.use(mockGqlError('UpdateProcessingMode', 'INTERNAL_SERVER_ERROR', { httpStatus: 500 }));
        await expect(retireLegacyModels()).resolves.toBeUndefined();
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
        expect(captured).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ tags: { component: 'retire-models', method: 'update-processing-mode' } }),
        );
    });

    it('skips the server write without a local identity', async () => {
        useUserStore.setState({ userId: null });
        const sent = recordModeUpdates();
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
        expect(sent).toEqual([]);
    });
});
