/* eslint-disable @typescript-eslint/no-require-imports */
// The on-device toolkit's public entry (`lib/mera-protocol-toolkit/index.ts`, kept as the one import path callers
// use): every documented name is exported and is the very function its module defines, and the lifecycle works when
// driven through the barrel alone: llama.rn holds Kev only, the phone's built-in model writes the text (D37). Real
// modelManager, inference, lock, store and downloadService on the in-memory expo-file-system, scripted llama.rn and
// the scripted built-in model.
import * as toolkit from '@/lib/mera-protocol-toolkit';
import * as downloadService from '@/lib/mera-protocol-toolkit/core/downloadService';
import * as inference from '@/lib/mera-protocol-toolkit/core/inference';
import * as modelCatalog from '@/lib/mera-protocol-toolkit/core/model-catalog';
import * as modelManager from '@/lib/mera-protocol-toolkit/core/modelManager';
import * as retireModels from '@/lib/mera-protocol-toolkit/core/retire-models';
import * as systemRequirements from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import * as textEngine from '@/lib/mera-protocol-toolkit/core/text-engine';
import { getInferenceStats, resetInferenceStats } from '@/lib/mera-protocol-toolkit/core/inference-stats';
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
import { decideCalls, installDecide, installLlama, KEV_GPU_FAILED, llamaCalls, llamaLoads, llamaMaxLive, llamaReleases } from '@/test/helpers/llama';
import { setAppState } from '@/test/helpers/app-state';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

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
            'deleteBaseModel', 'purgeAllBaseModels', 'LocalModelsOffError',
        ],
    ],
    ['model catalogue', modelCatalog, ['MODEL_CATALOG', 'RELEVANCE_MODEL', 'DEFAULT_MODEL_ID', 'RETIRED_MODEL_IDS', 'isRetiredModelId']],
    ['download service', downloadService, ['onDeviceModelsStatus', 'startModelDownloads', 'cancelModelDownload', 'isDownloadInProgress', 'restoreOnDeviceIfRunnable']],
    ['local mode rule', retireModels, ['localModeFor']],
    ['text engine', textEngine, ['getTextEngine', 'builtInEngine', 'builtInAvailability']],
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

    it('no longer exports the retired text model or the engine choice', () => {
        for (const name of ['TEXT_MODEL', 'setTextEngine', 'useTextEngine', 'isTextModelResident', 'requiredModels']) {
            expect((toolkit as Record<string, unknown>)[name]).toBeUndefined();
        }
    });
});

describe('Kev on llama.rn, the text on the built-in model, through the barrel', () => {
    beforeEach(async () => {
        resetFileSystem();
        jest.spyOn(logger, 'info').mockImplementation(() => {});
        await toolkit.disposeModel();
        resetInferenceStats();
        installOnDeviceLlm({ reply: 'From the phone.' });
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice, modelState: 'downloaded', modelError: null });
    });

    afterEach(() => {
        setAppState('active');
        jest.restoreAllMocks();
    });

    it('refuses to load anything outside on-device mode, and leaves the UI state alone', async () => {
        installLlama(['never']);
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud, modelState: 'downloaded' });
        await expect(toolkit.initBaseModel()).rejects.toBeInstanceOf(toolkit.LocalModelsOffError);
        await expect(toolkit.infer({ prompt: 'p' })).rejects.toBeInstanceOf(toolkit.LocalModelsOffError);
        await expect(toolkit.decide(REQUEST)).rejects.toBeInstanceOf(toolkit.LocalModelsOffError);
        expect(llamaLoads()).toEqual([]);
        expect(onDeviceLlmCalls()).toEqual([]);
        expect(store().modelState).toBe('downloaded');
    });

    it('initBaseModel only prewarms the built-in model and reports ready; llama.rn loads nothing', async () => {
        installLlama(['never']);
        await toolkit.initBaseModel();
        expect(store().modelState).toBe('ready');
        expect(onDeviceLlmPrewarms()).toBe(1);
        expect(llamaLoads()).toEqual([]);
    });

    it('decide loads Kev once and it stays resident across text calls: no swap, never a llama completion', async () => {
        installLlama(['never']);
        installDecide({ scores: { rel: 3 } });
        useMeraProtocolStore.setState({ modelState: 'ready' });
        const seen: string[] = [];
        const unsub = useMeraProtocolStore.subscribe((s) => seen.push(s.modelState));

        const answer = await toolkit.decide(REQUEST);
        expect(answer.answers.rel).toMatchObject({ type: 'score', score: 3 });
        expect(toolkit.getModelState()?.modelId).toBe(KEV);

        const out = await toolkit.infer({ prompt: 'capital?' });
        expect(out.output).toBe('From the phone.');
        await toolkit.decide(REQUEST);
        unsub();

        expect(llamaLoads()).toEqual([KEV]);
        expect(llamaReleases()).toBe(0);
        expect(llamaMaxLive()).toBe(1);
        expect(decideCalls()).toHaveLength(2);
        expect(llamaCalls()).toHaveLength(0);
        expect(getInferenceStats().loadMs).not.toBeNull();
        expect(seen).toEqual([]);
    });

    it('a Kev request queued behind a chat stream waits for it on the one lock', async () => {
        installLlama(['never']);
        installOnDeviceLlm({ reply: ['a', 'b', 'c'] });
        const order: string[] = [];
        const chat = (async () => {
            for await (const t of toolkit.inferStream({ prompt: 'hi' })) order.push(`token:${t}`);
        })();
        const kev = toolkit.decide(REQUEST).then(() => order.push('decided'));
        await Promise.all([chat, kev]);
        expect(order).toEqual(['token:a', 'token:b', 'token:c', 'decided']);
        expect(llamaLoads()).toEqual([KEV]);
    });

    describe('Kev and the GPU: iOS refuses GPU work in the background, and ggml-metal keeps that failure', () => {
        const BUSY = { code: 'ERR_AFM_BUSY' };

        it('refuses in the background without loading or calling Kev: a deferrable busy, never a native call', async () => {
            installLlama(['never']);
            setAppState('background');
            await expect(toolkit.decide(REQUEST)).rejects.toMatchObject(BUSY);
            expect(llamaLoads()).toEqual([]);
            expect(decideCalls()).toHaveLength(0);
        });

        it('a failed GPU backend is released and Kev reloaded, and the request answered once', async () => {
            installLlama(['never']);
            let n = 0;
            installDecide(() => (++n === 1 ? { error: KEV_GPU_FAILED } : { scores: { rel: 1 } }));

            const answer = await toolkit.decide(REQUEST);

            expect(answer.answers.rel).toMatchObject({ score: 1 });
            expect(llamaLoads()).toEqual([KEV, KEV]);
            expect(llamaReleases()).toBe(1);
            expect(llamaMaxLive()).toBe(1);
            // Later requests run on the fresh context.
            await toolkit.decide(REQUEST);
            expect(llamaLoads()).toEqual([KEV, KEV]);
        });

        it('a GPU failure that survives the reload is a deferrable busy, and the broken context is gone', async () => {
            installLlama(['never']);
            installDecide({ error: KEV_GPU_FAILED });

            await expect(toolkit.decide(REQUEST)).rejects.toMatchObject(BUSY);

            expect(decideCalls()).toHaveLength(2);
            expect(llamaLoads()).toEqual([KEV, KEV]);
            expect(llamaReleases()).toBe(2);
            expect(toolkit.getModelState()).toBeNull();
        });

        it('a decide the app backgrounded under releases the context and defers, with no retry in the background', async () => {
            installLlama(['never']);
            installDecide(() => {
                setAppState('background');
                return { error: KEV_GPU_FAILED };
            });

            await expect(toolkit.decide(REQUEST)).rejects.toMatchObject(BUSY);

            expect(decideCalls()).toHaveLength(1);
            expect(llamaReleases()).toBe(1);
            expect(toolkit.getModelState()).toBeNull();

            // Back on screen, the next request loads a fresh Kev and is answered.
            setAppState('active');
            installDecide({ scores: { rel: 2 } });
            await expect(toolkit.decide(REQUEST)).resolves.toMatchObject({ answers: { rel: { score: 2 } } });
        });

        it('an answer from a decide the app left the screen under is not trusted: busy, and the context released', async () => {
            // ggml-metal notices the refused GPU work only on the NEXT call (-3); this one returns
            // whatever the output buffers held.
            installLlama(['never']);
            installDecide(() => {
                setAppState('background');
                setAppState('active');
                return { scores: { rel: 3 } };
            });

            await expect(toolkit.decide(REQUEST)).rejects.toMatchObject(BUSY);

            expect(llamaReleases()).toBe(1);
            expect(toolkit.getModelState()).toBeNull();
        });

        it('any other Kev error reaches the caller as it is and keeps Kev resident', async () => {
            installLlama(['never']);
            installDecide({ error: 'failed to evaluate the decision prompt (error 1)' });

            await expect(toolkit.decide(REQUEST)).rejects.toThrow('(error 1)');

            expect(decideCalls()).toHaveLength(1);
            expect(llamaReleases()).toBe(0);
            expect(toolkit.getModelState()?.modelId).toBe(KEV);
        });
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

    it('isModelDownloaded() with no argument: Kev on disk AND the built-in model available, asked fresh every time', async () => {
        expect(await toolkit.isModelDownloaded()).toBe(false);
        placeDownloadedModel(KEV);
        expect(await toolkit.isModelDownloaded(KEV)).toBe(true);
        expect(await toolkit.isModelDownloaded()).toBe(true);

        setOnDeviceLlmAvailability({ available: false, reason: 'appleIntelligenceNotEnabled' });
        expect(await toolkit.isModelDownloaded()).toBe(false);
        setOnDeviceLlmAvailability({ available: true, reason: null });
        expect(await toolkit.isModelDownloaded()).toBe(true);
    });

    it('a phone with no built-in model can never run On this phone, Kev or not', async () => {
        installOnDeviceLlm({ platformModel: null, availability: { available: false, reason: 'unsupportedPlatform' } });
        placeDownloadedModel(KEV);
        expect(await toolkit.isModelDownloaded()).toBe(false);
    });

    it('Gemini Nano follows the same rule: Kev on disk and Nano available', async () => {
        installOnDeviceLlm({ platformModel: 'nano' });
        placeDownloadedModel(KEV);
        expect(await toolkit.getTextEngine()).toBe('nano');
        expect(await toolkit.isModelDownloaded()).toBe(true);
        setOnDeviceLlmAvailability({ available: false, reason: 'needsSystemUpdate' });
        expect(await toolkit.isModelDownloaded()).toBe(false);
    });

    it('the engine is this platform\'s built-in model, and its name even with no native module', async () => {
        expect(await toolkit.getTextEngine()).toBe('afm');
        expect(toolkit.builtInEngine()).toBe('afm');
        installOnDeviceLlm({ platformModel: null });
        expect(toolkit.builtInEngine()).toBeNull();
        expect(await toolkit.getTextEngine()).toBe('afm'); // the test platform is iOS
    });

    it('refuses to delete or purge a loaded Kev; deleteDownloadedModel releases it first', async () => {
        installLlama(['x']);
        placeDownloadedModel(KEV);
        await toolkit.decide(REQUEST);
        await expect(toolkit.deleteBaseModel(KEV)).rejects.toThrow('currently loaded');
        await expect(toolkit.purgeAllBaseModels()).rejects.toThrow('while one is loaded');

        await modelManager.deleteDownloadedModel(KEV);
        expect(toolkit.getModelState()).toBeNull();
        expect(await toolkit.isModelDownloaded(KEV)).toBe(false);
    });

    it('the boot purge deletes retired files for a phone that keeps the on-device intent (the purge trap)', async () => {
        const { useUserStore } = require('@/lib/stores/user-store') as typeof import('@/lib/stores/user-store');
        const { personaFor } = require('@/test/mock-backend/fixtures/graphql/persona') as typeof import('@/test/mock-backend/fixtures/graphql/persona');
        useUserStore.setState({ userPersona: personaFor(Date.now(), { processingMode: ProcessingMode.OnDevice }) as never });
        try {
            placeDownloadedModel(KEV);
            placeDownloadedModel('mera-qwen3.5-4b-instruct');
            await toolkit.purgeAllBaseModels();
            expect(await toolkit.isModelDownloaded('mera-qwen3.5-4b-instruct')).toBe(false);
            expect(await toolkit.isModelDownloaded(KEV)).toBe(true);
        } finally {
            useUserStore.setState({ userPersona: null });
        }
    });

    it('reports an idle download service', () => {
        expect(toolkit.isDownloadInProgress()).toBe(false);
    });

    it('infer goes to the built-in model with the instructions, prompt and options', async () => {
        const out = await toolkit.infer({ systemPrompt: 'Be brief.', prompt: 'Hi', maxTokens: 64, temperature: 0.2, label: 'reason' });
        expect(out).toMatchObject({ output: 'From the phone.', truncated: false });
        expect(onDeviceLlmCalls()).toEqual([
            expect.objectContaining({ kind: 'respond', instructions: 'Be brief.', prompt: 'Hi', options: { temperature: 0.2, maxTokens: 64 } }),
        ]);
        expect(getInferenceStats().reason.count).toBe(1);
    });

    it('streams native tokens in order', async () => {
        installOnDeviceLlm({ reply: ['Hel', 'lo', '.'] });
        const tokens: string[] = [];
        for await (const t of toolkit.inferStream({ prompt: 'p' })) tokens.push(t);
        expect(tokens).toEqual(['Hel', 'lo', '.']);
    });

    it('an abort cancels the native stream and ends it quietly', async () => {
        installOnDeviceLlm({ reply: ['a', 'b', 'c', 'd'] });
        const ac = new AbortController();
        const tokens: string[] = [];
        for await (const t of toolkit.inferStream({ prompt: 'p' }, ac.signal)) {
            tokens.push(t);
            ac.abort();
        }
        expect(tokens).toEqual(['a']);
        expect(onDeviceLlmCalls()[0].cancelled).toBe(true);
    });

    it('a stream aborted before it starts makes no call', async () => {
        const ac = new AbortController();
        ac.abort();
        const tokens: string[] = [];
        for await (const t of toolkit.inferStream({ prompt: 'p' }, ac.signal)) tokens.push(t);
        expect(tokens).toEqual([]);
        expect(onDeviceLlmCalls()).toEqual([]);
    });

    it('a guardrail or refusal is a failed call, never a crash, and is counted', async () => {
        installOnDeviceLlm({ reply: { error: 'ERR_AFM_GUARDRAIL' } });
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

    it('availability is asked with the APP language, never the cached answer', async () => {
        useAppLanguageStore.setState({ appLanguage: 'de' });
        await toolkit.builtInAvailability();
        setOnDeviceLlmAvailability({ available: false, reason: 'modelNotReady' });
        expect(await toolkit.builtInAvailability()).toEqual({ available: false, reason: 'modelNotReady' });
        expect(onDeviceLlmAvailabilityReads()).toEqual(['de', 'de']);
        useAppLanguageStore.setState({ appLanguage: 'en' });
    });

    it('onDeviceModelsStatus: Kev on disk or not with its size, and whether On this phone can run', async () => {
        const K = modelCatalog.RELEVANCE_MODEL;
        const status = (kevOnDisk: boolean, runnable: boolean) => ({
            models: { [K.modelId]: { onDisk: kevOnDisk, sizeBytes: K.sizeBytes } },
            runnable,
        });
        expect(await toolkit.onDeviceModelsStatus()).toEqual(status(false, false));
        placeDownloadedModel(KEV);
        expect(await toolkit.onDeviceModelsStatus()).toEqual(status(true, true));
        setOnDeviceLlmAvailability({ available: false, reason: 'modelNotReady' });
        expect(await toolkit.onDeviceModelsStatus()).toEqual(status(true, false));
    });

    it('contextSize is the built-in model\'s own window, null when it cannot say', async () => {
        installOnDeviceLlm({ contextSize: 3000 });
        await expect(toolkit.contextSize('afm')).resolves.toBe(3000);
        await expect(toolkit.contextSize()).resolves.toBe(3000);
        installOnDeviceLlm({ contextSize: null });
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
        const ask = (engine?: 'afm' | 'nano') =>
            toolkit.inferStructured<{ reply: string; options: string[] }>({ system: 'S', prompt: 'P', schema: SCHEMA, engine });

        it('sends the schema as JSON text and reads the value out of fences and prose', async () => {
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
    });
});
