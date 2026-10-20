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
import * as retireModels from '@/lib/mera-protocol-toolkit/core/retire-models';
import * as systemRequirements from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import * as textEngine from '@/lib/mera-protocol-toolkit/core/text-engine';
import { getInferenceStats, resetInferenceStats } from '@/lib/mera-protocol-toolkit/core/inference-stats';
import { deleteSetting, getSetting, setSetting } from '@/lib/database/services/setting-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import {
    installOnDeviceLlm,
    onDeviceLlmAvailabilityReads,
    onDeviceLlmCalls,
    onDeviceLlmPrewarms,
    setOnDeviceLlmAvailability,
} from '@/test/helpers/on-device-llm';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { placeDownloadedModel, resetFileSystem } from '@/test/helpers/fs';
import { decideCalls, installDecide, installLlama, llamaCalls, llamaLoads, llamaMaxLive, llamaReleases } from '@/test/helpers/llama';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

const TEXT = modelCatalog.TEXT_MODEL.modelId;
const KEV = modelCatalog.RELEVANCE_MODEL.modelId;
const store = () => useMeraProtocolStore.getState();
const REQUEST = { state: { article: { title: 't' } }, questions: { rel: { type: 'score' as const, instructions: 'q', criteria: ['a', 'b', 'c', 'd'] } } };

const EXPORTS: [string, Record<string, unknown>, string[]][] = [
    ['core inference', inference, ['infer', 'inferStream', 'inferStructured', 'contextSize', 'decide', 'StructuredOutputError']],
    [
        'base model lifecycle',
        modelManager,
        [
            'downloadBaseModel', 'initBaseModel', 'disposeModel', 'resetContext', 'getModelState', 'isModelDownloaded',
            'isTextModelResident', 'requiredModels', 'deleteBaseModel', 'deleteOnDeviceModels', 'purgeAllBaseModels', 'LocalModelsOffError',
        ],
    ],
    ['model catalogue', modelCatalog, ['MODEL_CATALOG', 'TEXT_MODEL', 'RELEVANCE_MODEL', 'DEFAULT_MODEL_ID', 'RETIRED_MODEL_IDS', 'isRetiredModelId']],
    ['download service', downloadService, ['onDeviceModelsStatus', 'startModelDownloads', 'cancelModelDownload', 'isDownloadInProgress', 'restoreOnDeviceIfRunnable']],
    ['local mode rule', retireModels, ['localModeFor']],
    ['text engine', textEngine, ['getTextEngine', 'setTextEngine', 'peekTextEngine', 'useTextEngine', 'builtInEngine', 'builtInAvailability', 'isBuiltInEngine', 'DEFAULT_TEXT_ENGINE']],
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
        await textEngine.setTextEngine('qwen');
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

    it('deleteDownloadedModel releases the model when it is resident and removes only its files', async () => {
        installLlama(['ok']);
        placeDownloadedModel(TEXT);
        placeDownloadedModel(KEV);
        await toolkit.initBaseModel();
        expect(toolkit.getModelState()?.modelId).toBe(TEXT);

        await modelManager.deleteDownloadedModel(TEXT);
        expect(toolkit.getModelState()).toBeNull();
        expect(await toolkit.isModelDownloaded(TEXT)).toBe(false);
        expect(await toolkit.isModelDownloaded(KEV)).toBe(true);

        // A model that is not resident is deleted without touching the resident one.
        await toolkit.decide(REQUEST);
        placeDownloadedModel(TEXT);
        await modelManager.deleteDownloadedModel(TEXT);
        expect(toolkit.getModelState()?.modelId).toBe(KEV);
    });

    it('the boot purge deletes retired files for a phone that keeps the on-device intent (the purge trap)', async () => {
        const { useUserStore } = require('@/lib/stores/user-store') as typeof import('@/lib/stores/user-store');
        const { personaFor } = require('@/test/mock-backend/fixtures/graphql/persona') as typeof import('@/test/mock-backend/fixtures/graphql/persona');
        useUserStore.setState({ userPersona: personaFor(Date.now(), { processingMode: ProcessingMode.OnDevice }) as never });
        try {
            placeDownloadedModel(KEV);
            placeDownloadedModel('mera-qwen3.5-2b');
            await toolkit.purgeAllBaseModels();
            expect(await toolkit.isModelDownloaded('mera-qwen3.5-2b')).toBe(false);
            expect(await toolkit.isModelDownloaded(KEV)).toBe(true);
        } finally {
            useUserStore.setState({ userPersona: null });
        }
    });

    it('reports an idle download service', () => {
        expect(toolkit.isDownloadInProgress()).toBe(false);
    });
});

describe("the built-in text engine (Apple Foundation Models, Gemini Nano)", () => {
    beforeEach(async () => {
        resetFileSystem();
        jest.spyOn(logger, 'info').mockImplementation(() => {});
        await toolkit.disposeModel();
        await textEngine.setTextEngine('qwen');
        textEngine.__resetTextEngineForTests();
        resetInferenceStats();
        installOnDeviceLlm({ reply: 'From the phone.' });
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice, modelState: 'downloaded', modelError: null });
    });

    afterEach(async () => {
        await textEngine.setTextEngine('qwen');
        textEngine.__resetTextEngineForTests();
        jest.restoreAllMocks();
    });

    it('the choice is stored in its own settings row and read back', async () => {
        await toolkit.setTextEngine('afm');
        expect(toolkit.peekTextEngine()).toBe('afm');
        expect(await getSetting('mera_text_engine')).toBe('afm');
        textEngine.__resetTextEngineForTests();
        expect(await toolkit.getTextEngine()).toBe('afm');
    });

    describe('with no stored row', () => {
        beforeEach(async () => {
            await deleteSetting('mera_text_engine');
            textEngine.__resetTextEngineForTests();
        });

        // A built-in model that is only briefly unable (mid-download, switched off) stays the default, so
        // the default never flips to a text model that is not on disk; one that can never run here does not.
        it.each([
            ['the text model on disk', { qwenOnDisk: true, platformModel: 'afm' as const, reason: null }, 'qwen'],
            ['no text model, Apple Intelligence ready', { qwenOnDisk: false, platformModel: 'afm' as const, reason: null }, 'afm'],
            ['no text model, Gemini Nano ready', { qwenOnDisk: false, platformModel: 'nano' as const, reason: null }, 'nano'],
            ['no text model, built-in model still downloading', { qwenOnDisk: false, platformModel: 'afm' as const, reason: 'modelNotReady' as const }, 'afm'],
            ['no text model, Apple Intelligence switched off', { qwenOnDisk: false, platformModel: 'afm' as const, reason: 'appleIntelligenceNotEnabled' as const }, 'afm'],
            ['no text model, phone not eligible', { qwenOnDisk: false, platformModel: 'afm' as const, reason: 'deviceNotEligible' as const }, 'qwen'],
            ['no text model, OS too old', { qwenOnDisk: false, platformModel: 'afm' as const, reason: 'osTooOld' as const }, 'qwen'],
            ['no text model, Nano needs a system update', { qwenOnDisk: false, platformModel: 'nano' as const, reason: 'needsSystemUpdate' as const }, 'qwen'],
            ['no text model, no built-in model', { qwenOnDisk: false, platformModel: null, reason: null }, 'qwen'],
        ])('%s: %s -> %s', async (_label, c, expected) => {
            installOnDeviceLlm({
                platformModel: c.platformModel,
                availability: c.reason ? { available: false, reason: c.reason } : { available: true, reason: null },
            });
            if (c.qwenOnDisk) placeDownloadedModel(TEXT);
            expect(await toolkit.getTextEngine()).toBe(expected);
            // Derived, never stored.
            expect(await getSetting('mera_text_engine')).toBeNull();
        });

        it('a derived built-in default that is briefly not ready still needs only the relevance model', async () => {
            installOnDeviceLlm({ availability: { available: false, reason: 'modelNotReady' } });
            expect((await toolkit.requiredModels()).map((m) => m.modelId)).toEqual([KEV]);
            expect(await toolkit.isModelDownloaded()).toBe(false);
        });

        it('re-derives on every read: the text model landing switches a derived built-in default to it', async () => {
            expect(await toolkit.getTextEngine()).toBe('afm');
            placeDownloadedModel(TEXT);
            expect(await toolkit.getTextEngine()).toBe('qwen');
            expect(toolkit.peekTextEngine()).toBe('qwen');
        });

        it.each([
            ['mera', 'afm' as const, 'qwen'],
            ['native', 'afm' as const, 'afm'],
            ['native', 'nano' as const, 'nano'],
            ['afm', 'nano' as const, 'nano'],
        ])('migrates an old row %s on %s to %s', async (row, platformModel, expected) => {
            installOnDeviceLlm({ platformModel, availability: { available: false, reason: 'modelNotReady' } });
            await setSetting('mera_text_engine', row);
            textEngine.__resetTextEngineForTests();
            expect(await toolkit.getTextEngine()).toBe(expected);
        });
    });

    it('infer goes to the native model with the instructions, prompt and options, and loads no llama model', async () => {
        installLlama(['never']);
        await toolkit.setTextEngine('afm');
        const out = await toolkit.infer({ systemPrompt: 'Be brief.', prompt: 'Hi', maxTokens: 64, temperature: 0.2, label: 'reason' });
        expect(out).toMatchObject({ output: 'From the phone.', truncated: false });
        expect(onDeviceLlmCalls()).toEqual([
            expect.objectContaining({ kind: 'respond', instructions: 'Be brief.', prompt: 'Hi', options: { temperature: 0.2, maxTokens: 64 } }),
        ]);
        expect(llamaLoads()).toEqual([]);
        expect(getInferenceStats().reason.count).toBe(1);
    });

    it('switching to the native engine releases a resident downloaded text model, and Kev still runs on llama', async () => {
        installLlama(['x']);
        await toolkit.initBaseModel();
        expect(llamaLoads()).toEqual([TEXT]);
        await toolkit.setTextEngine('afm');
        await toolkit.infer({ prompt: 'p' });
        expect(toolkit.getModelState()).toBeNull();
        await toolkit.decide(REQUEST);
        expect(llamaLoads()).toEqual([TEXT, KEV]);
        await toolkit.infer({ prompt: 'p' });
        // Kev stays resident: the native engine needs no llama model.
        expect(toolkit.getModelState()?.modelId).toBe(KEV);
        expect(llamaMaxLive()).toBe(1);
    });

    it('streams native tokens in order', async () => {
        installOnDeviceLlm({ reply: ['Hel', 'lo', '.'] });
        await toolkit.setTextEngine('afm');
        const tokens: string[] = [];
        for await (const t of toolkit.inferStream({ prompt: 'p' })) tokens.push(t);
        expect(tokens).toEqual(['Hel', 'lo', '.']);
    });

    it('an abort cancels the native stream and ends it quietly', async () => {
        installOnDeviceLlm({ reply: ['a', 'b', 'c', 'd'] });
        await toolkit.setTextEngine('afm');
        const ac = new AbortController();
        const tokens: string[] = [];
        for await (const t of toolkit.inferStream({ prompt: 'p' }, ac.signal)) {
            tokens.push(t);
            ac.abort();
        }
        expect(tokens).toEqual(['a']);
        expect(onDeviceLlmCalls()[0].cancelled).toBe(true);
    });

    it('a guardrail or refusal is a failed call, never a crash, and is counted', async () => {
        installOnDeviceLlm({ reply: { error: 'ERR_AFM_GUARDRAIL' } });
        await toolkit.setTextEngine('afm');
        await expect(toolkit.infer({ prompt: 'p' })).rejects.toMatchObject({ code: 'ERR_AFM_GUARDRAIL' });
        await expect(
            (async () => {
                for await (const _ of toolkit.inferStream({ prompt: 'p' })) { /* noop */ }
            })(),
        ).rejects.toMatchObject({ code: 'ERR_AFM_GUARDRAIL' });
        expect(getInferenceStats().refused).toBe(2);

        // Any other failure is not a refusal.
        installOnDeviceLlm({ reply: { error: 'ERR_AFM_CONTEXT' } });
        await expect(toolkit.infer({ prompt: 'p' })).rejects.toMatchObject({ code: 'ERR_AFM_CONTEXT' });
        expect(getInferenceStats().refused).toBe(2);
    });

    it('refuses outside on-device mode, like the downloaded models', async () => {
        await toolkit.setTextEngine('afm');
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
        await expect(toolkit.infer({ prompt: 'p' })).rejects.toBeInstanceOf(toolkit.LocalModelsOffError);
        await expect(toolkit.initBaseModel()).rejects.toBeInstanceOf(toolkit.LocalModelsOffError);
        expect(onDeviceLlmCalls()).toEqual([]);
    });

    it('initBaseModel only prewarms the native model and reports ready; the text model counts as resident', async () => {
        installLlama(['x']);
        await toolkit.setTextEngine('afm');
        await toolkit.initBaseModel();
        expect(store().modelState).toBe('ready');
        expect(onDeviceLlmPrewarms()).toBe(1);
        expect(llamaLoads()).toEqual([]);
        expect(toolkit.isTextModelResident()).toBe(true);
    });

    it('On this phone needs only the relevance model plus an available native model, asked fresh every time', async () => {
        await toolkit.setTextEngine('afm');
        expect((await toolkit.requiredModels()).map((m) => m.modelId)).toEqual([KEV]);
        expect(await toolkit.isModelDownloaded()).toBe(false);

        placeDownloadedModel(KEV);
        expect(await toolkit.isModelDownloaded()).toBe(true);

        setOnDeviceLlmAvailability({ available: false, reason: 'appleIntelligenceNotEnabled' });
        expect(await toolkit.isModelDownloaded()).toBe(false);
        setOnDeviceLlmAvailability({ available: true, reason: null });
        expect(await toolkit.isModelDownloaded()).toBe(true);

        await toolkit.setTextEngine('qwen');
        expect(await toolkit.isModelDownloaded()).toBe(false);
    });

    it('availability is asked with the APP language, never the cached answer', async () => {
        useAppLanguageStore.setState({ appLanguage: 'de' });
        await toolkit.builtInAvailability();
        setOnDeviceLlmAvailability({ available: false, reason: 'modelNotReady' });
        expect(await toolkit.builtInAvailability()).toEqual({ available: false, reason: 'modelNotReady' });
        expect(onDeviceLlmAvailabilityReads()).toEqual(['de', 'de']);
        useAppLanguageStore.setState({ appLanguage: 'en' });
    });

    it('onDeviceModelsStatus: each model on disk or not with its size, and whether the chosen engine can run', async () => {
        const T = modelCatalog.TEXT_MODEL;
        const K = modelCatalog.RELEVANCE_MODEL;
        const status = (textOnDisk: boolean, kevOnDisk: boolean, runnable: boolean) => ({
            models: { [T.modelId]: { onDisk: textOnDisk, sizeBytes: T.sizeBytes }, [K.modelId]: { onDisk: kevOnDisk, sizeBytes: K.sizeBytes } },
            runnable,
        });
        expect(await toolkit.onDeviceModelsStatus()).toEqual(status(false, false, false));
        await toolkit.setTextEngine('afm');
        placeDownloadedModel(KEV);
        expect(await toolkit.onDeviceModelsStatus()).toEqual(status(false, true, true));
        await toolkit.setTextEngine('qwen');
        expect(await toolkit.onDeviceModelsStatus()).toEqual(status(false, true, false));
    });

    it('Gemini Nano follows the same rule: Kev on disk and Nano available', async () => {
        installOnDeviceLlm({ platformModel: 'nano' });
        await toolkit.setTextEngine('nano');
        placeDownloadedModel(KEV);
        expect(await toolkit.isModelDownloaded()).toBe(true);
        setOnDeviceLlmAvailability({ available: false, reason: 'needsSystemUpdate' });
        expect(await toolkit.isModelDownloaded()).toBe(false);
    });

    it('a call names its engine: the prompt built for the built-in model runs there whatever is stored', async () => {
        installLlama(['never']);
        await toolkit.setTextEngine('qwen');
        await toolkit.infer({ prompt: 'p', engine: 'afm' });
        expect(onDeviceLlmCalls()).toHaveLength(1);
        expect(llamaLoads()).toEqual([]);
    });

    it('contextSize: the built-in model reports its own window, Qwen runs at the local context size', async () => {
        installOnDeviceLlm({ contextSize: 3000 });
        await expect(toolkit.contextSize('afm')).resolves.toBe(3000);
        await expect(toolkit.contextSize('qwen')).resolves.toBe(4096);
        installOnDeviceLlm({ contextSize: null });
        await toolkit.setTextEngine('afm');
        await expect(toolkit.contextSize()).resolves.toBeNull();
    });

    describe('inferStructured', () => {
        const SCHEMA = {
            type: 'object' as const,
            properties: {
                reply: { type: 'string' as const },
                options: { type: 'array' as const, items: { type: 'string' as const }, minItems: 1, maxItems: 4 },
            },
            required: ['reply', 'options'],
        };
        const ask = (engine?: 'afm' | 'nano' | 'qwen') =>
            toolkit.inferStructured<{ reply: string; options: string[] }>({ system: 'S', prompt: 'P', schema: SCHEMA, engine });

        it('built-in: sends the schema as JSON text and reads the value out of fences and prose', async () => {
            installOnDeviceLlm({ reply: 'Sure:\n```json\n{"reply":"Hi","options":["a","b"]}\n```\nDone.' });
            await expect(ask('afm')).resolves.toEqual({ reply: 'Hi', options: ['a', 'b'] });
            expect(onDeviceLlmCalls()).toEqual([
                expect.objectContaining({ kind: 'structured', instructions: 'S', prompt: 'P', schemaJson: JSON.stringify(SCHEMA) }),
            ]);
        });

        it('a reply that misses the schema is retried once with a reminder', async () => {
            const replies = ['no json here', '{"reply":"Hi","options":["a"]}'];
            installOnDeviceLlm({ platformModel: 'nano', reply: () => replies.shift()! });
            await expect(ask('nano')).resolves.toEqual({ reply: 'Hi', options: ['a'] });
            const calls = onDeviceLlmCalls();
            expect(calls).toHaveLength(2);
            expect(calls[1].prompt).toMatch(/^P\n\nReply with only JSON/);
        });

        it('a missing required key counts as a miss; two misses throw a typed error that is not deferrable', async () => {
            installOnDeviceLlm({ reply: '{"reply":"Hi"}' });
            const err = await ask('afm').catch((e: unknown) => e);
            expect(err).toBeInstanceOf(toolkit.StructuredOutputError);
            expect(err).toMatchObject({ code: 'ERR_STRUCTURED_OUTPUT' });
            expect(onDeviceLlmCalls()).toHaveLength(2);
        });

        it('an engine error is never retried: busy reaches the caller as it is', async () => {
            installOnDeviceLlm({ reply: { error: 'ERR_AFM_BUSY' } });
            await expect(ask('afm')).rejects.toMatchObject({ code: 'ERR_AFM_BUSY' });
            expect(onDeviceLlmCalls()).toHaveLength(1);
        });

        it('qwen: runs llama.rn under a json_schema grammar of the same schema', async () => {
            installLlama(['{"reply":"Hi","options":["a"]}']);
            placeDownloadedModel(TEXT);
            await expect(ask('qwen')).resolves.toEqual({ reply: 'Hi', options: ['a'] });
            expect(llamaCalls()[0].params.response_format).toEqual({ type: 'json_schema', json_schema: { schema: SCHEMA } });
            expect(onDeviceLlmCalls()).toEqual([]);
        });
    });
});
