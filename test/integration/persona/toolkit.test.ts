/* eslint-disable @typescript-eslint/no-require-imports */
// The on-device toolkit's public entry (`lib/mera-protocol-toolkit/index.ts`, kept as the one import path callers
// use): every documented name is exported and is the very function its module defines, and the two-model lifecycle
// works when driven through the barrel alone. Real modelManager, inference, lock, store and downloadService on the
// in-memory expo-file-system and scripted llama.rn.
import * as toolkit from '@/lib/mera-protocol-toolkit';
import * as downloadService from '@/lib/mera-protocol-toolkit/core/downloadService';
import * as inference from '@/lib/mera-protocol-toolkit/core/inference';
import * as modelCatalog from '@/lib/mera-protocol-toolkit/core/model-catalog';
import * as modelManager from '@/lib/mera-protocol-toolkit/core/modelManager';
import * as systemRequirements from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { placeDownloadedModel, resetFileSystem } from '@/test/helpers/fs';
import { decideCalls, installDecide, installLlama, llamaCalls, llamaLoads, llamaMaxLive, llamaReleases } from '@/test/helpers/llama';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);

const TEXT = modelCatalog.TEXT_MODEL.modelId;
const KEV = modelCatalog.RELEVANCE_MODEL.modelId;
const store = () => useMeraProtocolStore.getState();
const REQUEST = { state: { article: { title: 't' } }, questions: { rel: { type: 'score' as const, instructions: 'q', criteria: ['a', 'b', 'c', 'd'] } } };

const EXPORTS: [string, Record<string, unknown>, string[]][] = [
    ['core inference', inference, ['infer', 'inferStream', 'decide']],
    [
        'base model lifecycle',
        modelManager,
        [
            'downloadBaseModel', 'initBaseModel', 'disposeModel', 'resetContext', 'getModelState', 'isModelDownloaded',
            'isTextModelResident', 'deleteBaseModel', 'deleteOnDeviceModels', 'purgeAllBaseModels', 'LocalModelsOffError',
        ],
    ],
    ['model catalogue', modelCatalog, ['MODEL_CATALOG', 'TEXT_MODEL', 'RELEVANCE_MODEL', 'DEFAULT_MODEL_ID', 'RETIRED_MODEL_IDS', 'isRetiredModelId']],
    ['download service', downloadService, ['startModelDownloads', 'cancelModelDownload', 'isDownloadInProgress']],
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
});

describe('the two-model lifecycle through the barrel', () => {
    beforeEach(async () => {
        resetFileSystem();
        jest.spyOn(logger, 'info').mockImplementation(() => {});
        await toolkit.disposeModel();
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice, modelState: 'downloaded', modelError: null });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('refuses to load a model that is not on disk, and reports the error', async () => {
        await expect(toolkit.initBaseModel()).rejects.toThrow(`Model ${TEXT} not found on disk. Download it first.`);
        expect(toolkit.getModelState()).toBeNull();
        expect(store().modelState).toBe('error');
    });

    it('refuses to load anything outside on-device mode, and leaves the UI state alone', async () => {
        installLlama(['ok']);
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud, modelState: 'downloaded' });
        await expect(toolkit.initBaseModel()).rejects.toBeInstanceOf(toolkit.LocalModelsOffError);
        await expect(toolkit.infer({ prompt: 'p' })).rejects.toBeInstanceOf(toolkit.LocalModelsOffError);
        await expect(toolkit.decide(REQUEST)).rejects.toBeInstanceOf(toolkit.LocalModelsOffError);
        expect(llamaLoads()).toEqual([]);
        expect(store().modelState).toBe('downloaded');
    });

    it('initBaseModel loads the TEXT model, writes loading then ready, and unloads again', async () => {
        installLlama(['ok']);
        const seen: string[] = [];
        const unsub = useMeraProtocolStore.subscribe((s) => seen.push(s.modelState));
        const state = await toolkit.initBaseModel();
        unsub();
        expect(state).toMatchObject({ modelId: TEXT, loaded: true });
        expect(seen).toEqual(['loading', 'ready']);
        expect(toolkit.isTextModelResident()).toBe(true);

        // Already resident: no second load.
        await toolkit.initBaseModel();
        expect(llamaLoads()).toEqual([TEXT]);

        await toolkit.disposeModel();
        expect(toolkit.getModelState()).toBeNull();
        expect(toolkit.isTextModelResident()).toBe(false);
        expect(llamaReleases()).toBe(1);
    });

    it('decide loads Kev, infer swaps back to the text model, never two in memory, and swaps leave modelState alone', async () => {
        installLlama(['Paris']);
        installDecide({ scores: { rel: 3 } });
        useMeraProtocolStore.setState({ modelState: 'ready' });
        const seen: string[] = [];
        const unsub = useMeraProtocolStore.subscribe((s) => seen.push(s.modelState));

        const answer = await toolkit.decide(REQUEST);
        expect(answer.answers.rel).toMatchObject({ type: 'score', score: 3 });
        expect(toolkit.getModelState()?.modelId).toBe(KEV);
        expect(toolkit.isTextModelResident()).toBe(false);

        const out = await toolkit.infer({ prompt: 'capital?' });
        expect(out.output).toBe('Paris');
        expect(toolkit.isTextModelResident()).toBe(true);

        await toolkit.decide(REQUEST);
        unsub();

        expect(llamaLoads()).toEqual([KEV, TEXT, KEV]);
        expect(llamaReleases()).toBe(2);
        expect(llamaMaxLive()).toBe(1);
        expect(decideCalls()).toHaveLength(2);
        expect(llamaCalls()).toHaveLength(1);
        expect(seen).toEqual([]);
    });

    it('a Kev request queued behind a chat completion waits for it, then swaps', async () => {
        installLlama({ tokens: ['a', 'b', 'c'], tokenDelayMs: 0 });
        const order: string[] = [];
        const chat = (async () => {
            for await (const t of toolkit.inferStream({ prompt: 'hi' })) order.push(`token:${t}`);
        })();
        const kev = toolkit.decide(REQUEST).then(() => order.push('decided'));
        await Promise.all([chat, kev]);
        expect(order).toEqual(['token:a', 'token:b', 'token:c', 'decided']);
        expect(llamaLoads()).toEqual([TEXT, KEV]);
        expect(llamaMaxLive()).toBe(1);
    });

    it('a stream aborted while its model loads starts no completion', async () => {
        installLlama(['x']);
        await toolkit.decide(REQUEST); // Kev resident: the stream must swap first.
        const ac = new AbortController();
        const tokens: string[] = [];
        const run = (async () => {
            for await (const t of toolkit.inferStream({ prompt: 'p' }, ac.signal)) tokens.push(t);
        })();
        ac.abort();
        await run;
        expect(tokens).toEqual([]);
        expect(llamaCalls()).toHaveLength(0);
    });

    it('a file that is not a Kev decision model is released and refused', async () => {
        installLlama(['x']);
        const llama = jest.requireMock('llama.rn') as Record<string, jest.Mock>;
        let releasedWrong = false;
        llama.initLlama.mockImplementationOnce(async () => ({
            gpu: false,
            model: { size: 1 },
            release: async () => {
                releasedWrong = true;
            },
        }));
        await expect(toolkit.decide(REQUEST)).rejects.toThrow(`Model ${KEV} is not a Kev decision model`);
        expect(releasedWrong).toBe(true);
        expect(toolkit.getModelState()).toBeNull();
    });

    it('isModelDownloaded() with no argument needs BOTH models on disk', async () => {
        expect(await toolkit.isModelDownloaded()).toBe(false);
        placeDownloadedModel(TEXT);
        expect(await toolkit.isModelDownloaded(TEXT)).toBe(true);
        expect(await toolkit.isModelDownloaded()).toBe(false);
        placeDownloadedModel(KEV);
        expect(await toolkit.isModelDownloaded()).toBe(true);
    });

    it('refuses to delete or purge a loaded model; deleteOnDeviceModels releases and removes both', async () => {
        installLlama(['ok']);
        placeDownloadedModel(TEXT);
        placeDownloadedModel(KEV);
        await toolkit.initBaseModel();
        await expect(toolkit.deleteBaseModel(TEXT)).rejects.toThrow('currently loaded');
        await expect(toolkit.purgeAllBaseModels()).rejects.toThrow('while one is loaded');

        await toolkit.deleteOnDeviceModels();
        expect(toolkit.getModelState()).toBeNull();
        expect(await toolkit.isModelDownloaded(TEXT)).toBe(false);
        expect(await toolkit.isModelDownloaded(KEV)).toBe(false);
    });

    it('reports an idle download service', () => {
        expect(toolkit.isDownloadInProgress()).toBe(false);
    });
});
