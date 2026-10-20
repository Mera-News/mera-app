/* eslint-disable @typescript-eslint/no-require-imports */
// Boot-time retirement of on-device models (`retireLegacyModels`, `purgeAllBaseModels`): the retired ids' files,
// the Qwen text model among them (D37), are deleted for EVERY reader; a retired selection is remapped at hydrate;
// an OnDevice user whose phone cannot run On this phone (Kev on disk AND the built-in model available) falls back to
// Cloud LOCALLY ONLY with a visible notice, never silently (the server persona keeps the on-device intent); and the
// boot purge leaves the current files alone while that intent stands. Real modelManager over chat's in-memory
// expo-file-system, real store, settings rows, notifications table, user store and Apollo over MSW; the built-in
// model is the scripted native module. Faults: a one-call spy on the real deleteBaseModel (R23).
import { waitFor } from '@testing-library/react-native';
import { localModeFor, retireLegacyModels } from '@/lib/mera-protocol-toolkit/core/retire-models';
import { installOnDeviceLlm } from '@/test/helpers/on-device-llm';
import { getAll as getNotifications } from '@/lib/database/services/notification-service';
import * as modelManager from '@/lib/mera-protocol-toolkit/core/modelManager';
import { DEFAULT_MODEL_ID, RELEVANCE_MODEL, RETIRED_MODEL_IDS } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { fileSystemModule, placeModelFile, resetFileSystem } from '@/test/integration/chat/_helpers';
import { FIXTURE_ACCOUNT, graphql, HttpResponse, server, signInFixtureAccount } from '@/test/helpers';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

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

const QWEN = 'mera-qwen3.5-4b-instruct';
const KEV = RELEVANCE_MODEL.modelId;
/** The fallback notices in the notifications inbox. */
const notices = async () => (await getNotifications()).filter((n) => n.type === 'on-device-fallback');

let captured: jest.SpyInstance;

beforeEach(async () => {
    installOnDeviceLlm({ availability: { available: true, reason: null } });
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
    it('deletes the directory of every retired id, the Qwen text model included, and leaves Kev alone', async () => {
        expect(RETIRED_MODEL_IDS).toContain(QWEN);
        for (const id of RETIRED_MODEL_IDS) placeModelFile(id);
        await putModelOnDisk(KEV);
        await retireLegacyModels();
        for (const id of RETIRED_MODEL_IDS) expect(modelDirExists(id)).toBe(false);
        expect(modelDirExists(KEV)).toBe(true);
    });

    it('a selection on a retired id (the Qwen text model) is remapped to the default at hydrate and the row rewritten', async () => {
        await setSetting('mera_selected_model_id', QWEN);
        await store().hydrateFromDb();
        expect(store().selectedModelId).toBe(DEFAULT_MODEL_ID);
        // The rewrite is fired without awaiting.
        await waitFor(async () => expect(await getSetting('mera_selected_model_id')).toBe(DEFAULT_MODEL_ID));
    });

    it('sweeps the retired text-engine choice row', async () => {
        await setSetting('mera_text_engine', 'qwen');
        await putModelOnDisk(KEV);
        await retireLegacyModels();
        await waitFor(async () => expect(await getSetting('mera_text_engine')).toBeNull());
    });

    it('a failed delete is reported and does not stop the mode check', async () => {
        jest.spyOn(modelManager, 'deleteBaseModel').mockRejectedValueOnce(new Error('busy'));
        await retireLegacyModels();
        expect(captured).toHaveBeenCalledTimes(1);
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
    });
});

describe('the Qwen file is deleted for every reader, whatever the mode', () => {
    const personaMode = (processingMode: ProcessingMode) =>
        useUserStore.setState({ userPersona: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode }) });

    it('OnDevice: the boot retirement deletes it', async () => {
        await putModelOnDisk(QWEN);
        await putModelOnDisk(KEV);
        await retireLegacyModels();
        expect(modelDirExists(QWEN)).toBe(false);
        expect(modelDirExists(KEV)).toBe(true);
    });

    it('Cloud locally with the on-device intent: the purge deletes the retired files only, Kev stays', async () => {
        await putModelOnDisk(QWEN);
        await putModelOnDisk(KEV);
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
        personaMode(ProcessingMode.OnDevice);
        await modelManager.purgeAllBaseModels();
        expect(modelDirExists(QWEN)).toBe(false);
        expect(modelDirExists(KEV)).toBe(true);
    });

    it('Cloud with no on-device intent: the purge wipes every model file', async () => {
        await putModelOnDisk(QWEN);
        await putModelOnDisk(KEV);
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
        personaMode(ProcessingMode.Cloud);
        await modelManager.purgeAllBaseModels();
        expect(modelDirExists(QWEN)).toBe(false);
        expect(modelDirExists(KEV)).toBe(false);
    });
});

describe('the OnDevice rule: Kev on disk AND the built-in model available', () => {
    it('keeps OnDevice, sends nothing and shows no notice when it can run', async () => {
        await putModelOnDisk(KEV);
        const sent = recordModeUpdates();
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.OnDevice);
        expect(store().modelState).toBe('downloaded');
        expect(sent).toEqual([]);
        expect(await notices()).toEqual([]);
    });

    it('a former Qwen user on a phone with no built-in model: Cloud locally, server untouched, and a visible notice', async () => {
        installOnDeviceLlm({ platformModel: null, availability: { available: false, reason: 'unsupportedPlatform' } });
        await putModelOnDisk(QWEN);
        await putModelOnDisk(KEV);
        const sent = recordModeUpdates();

        await retireLegacyModels();

        expect(modelDirExists(QWEN)).toBe(false);
        expect(store()).toMatchObject({ processingMode: ProcessingMode.Cloud, modelState: 'not_downloaded', downloadProgress: 0 });
        expect(sent).toEqual([]);
        const shown = await notices();
        expect(shown).toHaveLength(1);
        expect(shown[0]).toMatchObject({
            title: 'meraProtocol.fallbackNoticeTitle',
            body: 'meraProtocol.fallbackNoticeBody',
            source: 'mera-protocol',
        });
        // The settings write is fired without awaiting.
        await waitFor(async () => expect(await getSetting('mera_processing_mode')).toBe(ProcessingMode.Cloud));
    });

    it('Apple Intelligence switched off: Cloud locally with the notice, once a day', async () => {
        installOnDeviceLlm({ availability: { available: false, reason: 'appleIntelligenceNotEnabled' } });
        await putModelOnDisk(KEV);
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
        // A second boot the same day falls back again but adds no second inbox row.
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
        await retireLegacyModels();
        expect(await notices()).toHaveLength(1);
    });

    it('Kev missing: Cloud locally with the notice', async () => {
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
        expect(await notices()).toHaveLength(1);
    });

    it('treats a manifest it cannot read as no model on disk', async () => {
        placeModelFile(KEV);
        await new File(Paths.cache, 'mera-models', KEV, 'manifest.json').write('not json');
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
    });

    it('does nothing to the mode of a Cloud user, and shows no notice', async () => {
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud, modelState: 'not_downloaded' });
        const sent = recordModeUpdates();
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.Cloud);
        expect(sent).toEqual([]);
        expect(await notices()).toEqual([]);
    });
});

describe('the boot purge (purgeAllBaseModels) after a local Cloud fallback', () => {
    const personaMode = (processingMode: ProcessingMode) =>
        useUserStore.setState({ userPersona: personaFor(Date.now(), { userId: FIXTURE_ACCOUNT.userId, processingMode }) });

    it('keeps Kev while the persona keeps the on-device intent', async () => {
        installOnDeviceLlm({ availability: { available: false, reason: 'modelNotReady' } });
        await putModelOnDisk(KEV);
        personaMode(ProcessingMode.OnDevice);
        // Boot N: the built-in model not ready falls back to Cloud locally. Boot N+1 runs the purge for local Cloud.
        await retireLegacyModels();
        expect(store().processingMode).toBe(ProcessingMode.Cloud);

        await modelManager.purgeAllBaseModels();

        expect(modelDirExists(KEV)).toBe(true);
    });
});

describe('localModeFor: the local copy of a server persona mode', () => {
    it('Kev on disk plus an available built-in model is OnDevice; Cloud passes through', async () => {
        await putModelOnDisk(KEV);
        await expect(localModeFor(ProcessingMode.OnDevice)).resolves.toBe(ProcessingMode.OnDevice);
        await expect(localModeFor(ProcessingMode.Cloud)).resolves.toBe(ProcessingMode.Cloud);
    });

    it('the built-in model unavailable, or Kev missing, is Cloud', async () => {
        await expect(localModeFor(ProcessingMode.OnDevice)).resolves.toBe(ProcessingMode.Cloud);
        await putModelOnDisk(KEV);
        installOnDeviceLlm({ availability: { available: false, reason: 'modelNotReady' } });
        await expect(localModeFor(ProcessingMode.OnDevice)).resolves.toBe(ProcessingMode.Cloud);
    });
});
