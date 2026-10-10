/* eslint-disable @typescript-eslint/no-require-imports */
// The on-device toolkit's public entry (`lib/mera-protocol-toolkit/index.ts`, kept as the one import path callers
// use): every documented name is exported and is the very function its module defines, and the model lifecycle
// works when driven through the barrel alone. Real modelManager, store and downloadService on chat's in-memory
// expo-file-system and scripted llama.rn.
import * as toolkit from '@/lib/mera-protocol-toolkit';
import * as downloadService from '@/lib/mera-protocol-toolkit/core/downloadService';
import * as inference from '@/lib/mera-protocol-toolkit/core/inference';
import * as modelCatalog from '@/lib/mera-protocol-toolkit/core/model-catalog';
import * as modelManager from '@/lib/mera-protocol-toolkit/core/modelManager';
import * as systemRequirements from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { installLlama, llamaReleases, resetFileSystem } from '@/test/integration/chat/_helpers';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);

const EXPORTS: [string, Record<string, unknown>, string[]][] = [
    ['core inference', inference, ['infer', 'inferStream']],
    [
        'base model lifecycle',
        modelManager,
        ['downloadBaseModel', 'initBaseModel', 'disposeModel', 'resetContext', 'getModelState', 'isModelDownloaded', 'deleteBaseModel', 'purgeAllBaseModels'],
    ],
    ['model catalogue', modelCatalog, ['MODEL_CATALOG', 'DEFAULT_MODEL_ID', 'RETIRED_MODEL_IDS', 'catalogEntry', 'isRetiredModelId']],
    ['download service', downloadService, ['startModelDownload', 'cancelModelDownload', 'isDownloadInProgress']],
    ['system requirements', systemRequirements, ['checkRequirements']],
];

describe('the barrel', () => {
    it.each(EXPORTS.flatMap(([group, source, names]) => names.map((name) => [group, name, source] as const)))(
        '%s: exports %s as the module defines it',
        (_group, name, source) => {
            const exported = (toolkit as Record<string, unknown>)[name];
            expect(exported).toBeDefined();
            expect(exported).toBe(source[name]);
        },
    );

    it('exports the functions as functions and the catalogue as data', () => {
        expect(typeof toolkit.infer).toBe('function');
        expect(typeof toolkit.inferStream).toBe('function');
        expect(Array.isArray(toolkit.MODEL_CATALOG)).toBe(true);
        expect(toolkit.MODEL_CATALOG.map((m) => m.modelId)).toContain(toolkit.DEFAULT_MODEL_ID);
    });
});

describe('the model lifecycle through the barrel', () => {
    beforeEach(async () => {
        resetFileSystem();
        jest.spyOn(logger, 'info').mockImplementation(() => {});
        await toolkit.disposeModel();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('refuses to load a model that is not on disk', async () => {
        const id = useMeraProtocolStore.getState().selectedModelId;
        expect(await toolkit.isModelDownloaded()).toBe(false);
        await expect(toolkit.initBaseModel()).rejects.toThrow(`Model ${id} not found on disk. Download it first.`);
        expect(toolkit.getModelState()).toBeNull();
    });

    it('loads the selected model, reports it, and unloads it again', async () => {
        installLlama(['ok']);
        const state = await toolkit.initBaseModel();
        expect(state).toMatchObject({ modelId: useMeraProtocolStore.getState().selectedModelId, loaded: true });
        expect(toolkit.getModelState()).toBe(state);

        const releasedBefore = llamaReleases();
        await toolkit.disposeModel();
        expect(toolkit.getModelState()).toBeNull();
        expect(llamaReleases()).toBe(releasedBefore + 1);
    });

    it('refuses to delete or purge a model while one is loaded', async () => {
        installLlama(['ok']);
        const { modelId } = await toolkit.initBaseModel();
        await expect(toolkit.deleteBaseModel(modelId)).rejects.toThrow('currently loaded');
        await expect(toolkit.purgeAllBaseModels()).rejects.toThrow('while one is loaded');
        await toolkit.disposeModel();
        await expect(toolkit.deleteBaseModel(modelId)).resolves.toBeUndefined();
        expect(await toolkit.isModelDownloaded(modelId)).toBe(false);
    });

    it('reports an idle download service', () => {
        expect(toolkit.isDownloadInProgress()).toBe(false);
    });
});
