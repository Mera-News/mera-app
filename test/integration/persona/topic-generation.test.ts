// lib/mera-protocol/topic-generation-service through the real on-device engine: completeLocalStructured,
// modelManager and the inference queue run for real, with only llama.rn (scripted), the built-in
// model module (scripted) and expo-file-system (in-memory) faked. The parser is the harness one that
// every topic path shares.
//
// The service is LOCAL ONLY since ux2 F5 (cloud topics come from the skill core's topic-gen handler
// in lib/mera-harness) and FACT ONLY (on-device has no combination pass), so the cloud half is the
// test that nothing reaches the gateway.
import logger from '@/lib/logger';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { __resetTextEngineForTests, setTextEngine } from '@/lib/mera-protocol-toolkit/core/text-engine';
import { generateTopicsForFact } from '@/lib/mera-protocol/topic-generation-service';
import { parseTopicsFromOutput } from '@/lib/news-harness/persona-management/topic-generation';
import { TOPIC_GEN_SYSTEM } from '@/lib/news-harness/on-device/topic-gen/prompt';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { gatewayCalls } from '@/test/helpers';
import { installLlama, llamaCalls, type LlamaCall } from '@/test/helpers/llama';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { resetFileSystem } from '@/test/helpers/fs';
import { resetChatModules } from '@/test/integration/chat/_helpers';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

jest.setTimeout(30_000);

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await disposeModel();
  installOnDeviceLlm({ platformModel: null });
  useMeraProtocolStore.getState().setModelState('downloaded');
  useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.OnDevice);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
});

const systemOf = (c: LlamaCall) => c.messages.find((m) => m.role === 'system')?.content ?? '';
const userOf = (c: LlamaCall) => c.messages.find((m) => m.role === 'user')?.content ?? '';
const inputs = (over: Partial<Parameters<typeof generateTopicsForFact>[0]> = {}) => ({
  factStatement: 'Works in AI',
  userLocation: null,
  otherFacts: [],
  useCloud: false,
  ...over,
});
const topicsReply = (...topics: string[]) => [JSON.stringify({ topics })];

// ===========================================================================
// parseTopicsFromOutput (shared by every topic path)
// ===========================================================================

describe('parseTopicsFromOutput', () => {
  const fact = 'Lives in Amsterdam';
  const warn = jest.fn();
  const parse = (output: string) => parseTopicsFromOutput(output, fact, { ...console, warn } as never);
  beforeEach(() => warn.mockReset());

  it('parses a valid JSON array of strings', () => {
    expect(parse('["Amsterdam news", "Dutch politics"]')).toEqual(['Amsterdam news', 'Dutch politics']);
  });

  it('filters out non-string elements, empty strings and whitespace-only strings', () => {
    expect(parse('["AI news", 42, null, "tech policy"]')).toEqual(['AI news', 'tech policy']);
    expect(parse('["AI news", "", "  ", "tech"]')).toEqual(['AI news', 'tech']);
  });

  it('trims whitespace from each topic', () => {
    expect(parse('["  AI news  ", " tech "]')).toEqual(['AI news', 'tech']);
  });

  it('caps results at 20 topics', () => {
    const arr = Array.from({ length: 25 }, (_, i) => `topic ${i}`);
    expect(parse(JSON.stringify(arr))).toHaveLength(20);
  });

  it.each([
    ['text around the array', 'Here are the topics: ["Amsterdam news", "EU regulation"] , end', ['Amsterdam news', 'EU regulation']],
    ['a markdown code fence', '```json\n["Amsterdam news", "EU tech"]\n```', ['Amsterdam news', 'EU tech']],
    ['trailing text after the bracket', '["Amsterdam news", "EU regulation"] some note', ['Amsterdam news', 'EU regulation']],
    ['a bracket inside a topic', 'Topics: ["Rail [strike] news", "EU tech"]', ['Rail [strike] news', 'EU tech']],
  ])('finds the array in %s', (_label, output, expected) => {
    expect(parse(output)).toEqual(expected);
  });

  it.each([
    ['the object form', '{"topics": ["Amsterdam news", "EU tech"]}'],
    ['the object form in a code fence', '```json\n{"topics": ["Amsterdam news", "EU tech"]}\n```'],
    ['the object form after prose', 'Sure. {"topics": ["Amsterdam news", "EU tech"]}'],
  ])('reads %s', (_label, output) => {
    expect(parse(output)).toEqual(['Amsterdam news', 'EU tech']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns [] and warns for an object with no topics list (another key\'s list is not topics), or no JSON at all', () => {
    expect(parse('{"items": ["a"]}')).toEqual([]);
    expect(parse('```json\n{"rejected": ["a"], "kept": ["b"]}\n```')).toEqual([]);
    expect(parse('no json here')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it.each([[''], ['[]'], ['{"topics": []}']])('returns [] for %j', (output) => {
    expect(parse(output)).toEqual([]);
  });
});

// ===========================================================================
// generateTopicsForFact - the downloaded text model (llama.rn, json_schema grammar)
// ===========================================================================

describe('generateTopicsForFact on the downloaded text model', () => {
  it('asks once, under a json_schema grammar for {topics}, with the on-device prompt, and keeps the clean topics', async () => {
    installLlama(topicsReply('AI news', '  ML research ', ''));

    const result = await generateTopicsForFact(inputs());

    expect(result).toEqual(['AI news', 'ML research']);
    expect(llamaCalls()).toHaveLength(1);
    const [call] = llamaCalls();
    expect(systemOf(call)).toBe(TOPIC_GEN_SYSTEM);
    expect(userOf(call)).toContain('Fact: "Works in AI"');
    expect(userOf(call)).toMatch(/Generate 10 topics\.$/);
    expect(call.params).toMatchObject({
      n_predict: 1024,
      temperature: 0.3,
      response_format: {
        type: 'json_schema',
        json_schema: { schema: { type: 'object', required: ['topics'], properties: { topics: { type: 'array', maxItems: 10 } } } },
      },
    });
  });

  it('sends the fact alone: no other facts and no location line (no combination pass on this phone)', async () => {
    installLlama(topicsReply('AI news'));

    await generateTopicsForFact(inputs({ userLocation: 'Lives in a city', otherFacts: ['another fact'] }));

    expect(llamaCalls()).toHaveLength(1);
    expect(userOf(llamaCalls()[0])).not.toMatch(/User location|Lives in a city|another fact/);
  });

  it('respects a custom totalCount, raising the ceiling only past 1024 tokens', async () => {
    installLlama(topicsReply('topic a', 'topic b', 'topic c'));
    await generateTopicsForFact(inputs({ totalCount: 3 }));
    expect(userOf(llamaCalls()[0])).toContain('Generate 3 topics.');
    expect(llamaCalls()[0].params.n_predict).toBe(1024);

    installLlama(topicsReply('x'));
    await generateTopicsForFact(inputs({ totalCount: 40 }));
    expect(llamaCalls()[0].params.n_predict).toBe(1200);
  });

  it('cuts a list longer than the count asked for', async () => {
    installLlama(topicsReply('a', 'b', 'c', 'd'));
    expect(await generateTopicsForFact(inputs({ totalCount: 2 }))).toEqual(['a', 'b']);
  });

  it('tells the model which topics not to repeat when asked for more', async () => {
    installLlama(topicsReply('fresh topic'));

    await generateTopicsForFact(inputs({ excludeTopics: ['old topic'] }));

    expect(userOf(llamaCalls()[0])).toContain('Do NOT repeat these existing topics:\n- old topic');
  });

  it('retries a reply that does not fit the schema once, then answers [] with a warning', async () => {
    installLlama(['not valid json']);

    expect(await generateTopicsForFact(inputs())).toEqual([]);
    expect(llamaCalls()).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith('[topic-gen] local generation failed', expect.anything());
  });

  it('answers [] with a warning when the call fails', async () => {
    installLlama({ tokens: [], error: 'local fail' });

    expect(await generateTopicsForFact(inputs())).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('[topic-gen] local generation failed', { error: 'local fail' });
  });
});

// ===========================================================================
// generateTopicsForFact - the built-in model (Apple Intelligence / Gemini Nano)
// ===========================================================================

describe('generateTopicsForFact on the built-in model', () => {
  beforeEach(async () => {
    installLlama([]);
    installOnDeviceLlm();
    await setTextEngine('afm');
  });
  afterEach(async () => {
    await setTextEngine('qwen');
    __resetTextEngineForTests();
  });

  it('asks through respondStructured with the {topics} schema and reads a fenced reply', async () => {
    installOnDeviceLlm({ reply: '```json\n{"topics": ["Chess openings", "Chess tournaments"]}\n```' });

    expect(await generateTopicsForFact(inputs({ factStatement: 'Plays chess' }))).toEqual(['Chess openings', 'Chess tournaments']);

    const [call] = onDeviceLlmCalls();
    expect(onDeviceLlmCalls()).toHaveLength(1);
    expect(call).toMatchObject({ kind: 'structured', instructions: TOPIC_GEN_SYSTEM });
    expect(JSON.parse(call.schemaJson ?? '')).toMatchObject({ required: ['topics'] });
    expect(llamaCalls()).toHaveLength(0);
  });

  it.each(['ERR_AFM_BUSY', 'ERR_AFM_UNAVAILABLE'] as const)('%s reaches the caller, so the queue defers the job', async (code) => {
    installOnDeviceLlm({ reply: { error: code } });

    await expect(generateTopicsForFact(inputs())).rejects.toMatchObject({ code });
    expect(onDeviceLlmCalls()).toHaveLength(1);
  });
});

describe('ux2 F5: the cloud branch is retired', () => {
  it('a useCloud input never reaches the cloud: the local engine runs', async () => {
    installLlama(topicsReply('nurse staffing'));

    const result = await generateTopicsForFact(inputs({ factStatement: 'Works as a nurse', useCloud: true }));

    expect(result).toEqual(['nurse staffing']);
    expect(gatewayCalls()).toHaveLength(0);
    expect(llamaCalls()).toHaveLength(1);
  });
});
