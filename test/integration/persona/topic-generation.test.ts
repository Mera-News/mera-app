// lib/mera-protocol/topic-generation-service through the real on-device engine: completeLocalStructured,
// modelManager and the inference queue run for real, with only the built-in model module (scripted; the
// only on-device text engine since D37), llama.rn (scripted, never asked for text) and expo-file-system
// (in-memory) faked. The on-device reply is read by
// topicsFromReply; parseTopicsFromOutput is the cloud parser (combo pass, top-up), pinned here as is.
//
// The service is LOCAL ONLY since ux2 F5 (cloud topics come from the skill core's topic-gen handler
// in lib/mera-harness) and FACT ONLY (on-device has no combination pass), so the cloud half is the
// test that nothing reaches the gateway.
import logger from '@/lib/logger';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { generateTopicsForFact } from '@/lib/mera-protocol/topic-generation-service';
import { parseTopicsFromOutput } from '@/lib/news-harness/persona-management/topic-generation';
import { TOPIC_GEN_SYSTEM } from '@/lib/news-harness/on-device/topic-gen/prompt';
import { countTokens } from '@/lib/news-harness/on-device/shared';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { gatewayCalls } from '@/test/helpers';
import { installLlama, llamaCalls } from '@/test/helpers/llama';
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
  installLlama(() => ({ tokens: [], error: 'llama.rn completion on Kev' }));
  installOnDeviceLlm();
  useMeraProtocolStore.getState().setModelState('downloaded');
  useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.OnDevice);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
});

const userOf = (c: { prompt: string }) => c.prompt;
const inputs = (over: Partial<Parameters<typeof generateTopicsForFact>[0]> = {}) => ({
  factStatement: 'Works in AI',
  userLocation: null,
  otherFacts: [],
  useCloud: false,
  ...over,
});
const topicsReply = (...topics: string[]) => ({ reply: JSON.stringify({ topics }) });

// ===========================================================================
// parseTopicsFromOutput (the cloud parser, unchanged)
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
  ])('uses the bracket fallback for %s', (_label, output, expected) => {
    expect(parse(output)).toEqual(expected);
  });

  it('returns [] and warns when the output is completely unparseable', () => {
    expect(parse('no json here')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([[''], ['[]']])('returns [] for %j', (output) => {
    expect(parse(output)).toEqual([]);
  });
});

// ===========================================================================
// generateTopicsForFact - the request it builds (on the built-in model)
// ===========================================================================

describe('generateTopicsForFact: the request', () => {
  it('asks once, with the {topics} schema and the on-device prompt, and keeps the clean topics', async () => {
    installOnDeviceLlm(topicsReply('AI news', '  ML research ', ''));

    const result = await generateTopicsForFact(inputs());

    expect(result).toEqual(['AI news', 'ML research']);
    expect(onDeviceLlmCalls()).toHaveLength(1);
    const [call] = onDeviceLlmCalls();
    expect(call.instructions).toBe(TOPIC_GEN_SYSTEM);
    expect(userOf(call)).toContain('Fact: "Works in AI"');
    expect(userOf(call)).toMatch(/Generate 10 topics\.$/);
    expect(call.options).toMatchObject({ maxTokens: 1024, temperature: 0.3 });
    expect(JSON.parse(call.schemaJson ?? '')).toMatchObject({ type: 'object', required: ['topics'], properties: { topics: { type: 'array', maxItems: 10 } } });
    expect(llamaCalls()).toHaveLength(0);
  });

  it('sends the fact alone: no other facts and no location line (no combination pass on this phone)', async () => {
    installOnDeviceLlm(topicsReply('AI news'));

    await generateTopicsForFact(inputs({ userLocation: 'Lives in a city', otherFacts: ['another fact'] }));

    expect(onDeviceLlmCalls()).toHaveLength(1);
    expect(userOf(onDeviceLlmCalls()[0])).not.toMatch(/User location|Lives in a city|another fact/);
  });

  it('respects a custom totalCount, raising the ceiling only past 1024 tokens', async () => {
    installOnDeviceLlm(topicsReply('topic a', 'topic b', 'topic c'));
    await generateTopicsForFact(inputs({ totalCount: 3 }));
    expect(userOf(onDeviceLlmCalls()[0])).toContain('Generate 3 topics.');
    expect(onDeviceLlmCalls()[0].options.maxTokens).toBe(1024);

    installOnDeviceLlm(topicsReply('x'));
    await generateTopicsForFact(inputs({ totalCount: 40 }));
    expect(onDeviceLlmCalls()[0].options.maxTokens).toBe(1200);
  });

  it('cuts a list longer than the count asked for', async () => {
    installOnDeviceLlm(topicsReply('a', 'b', 'c', 'd'));
    expect(await generateTopicsForFact(inputs({ totalCount: 2 }))).toEqual(['a', 'b']);
  });

  it('tells the model which topics not to repeat when asked for more', async () => {
    installOnDeviceLlm(topicsReply('fresh topic'));

    await generateTopicsForFact(inputs({ excludeTopics: ['old topic'] }));

    expect(userOf(onDeviceLlmCalls()[0])).toContain('Do NOT repeat these existing topics:\n- old topic');
  });

  it('retries a reply that does not fit the schema once, then answers [] with a warning', async () => {
    installOnDeviceLlm({ reply: 'not valid json' });

    expect(await generateTopicsForFact(inputs())).toEqual([]);
    expect(onDeviceLlmCalls()).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith('[topic-gen] local generation failed', expect.anything());
  });

  it('answers [] with a warning when the call fails for good (a refusal, not busy)', async () => {
    installOnDeviceLlm({ reply: { error: 'ERR_AFM_GUARDRAIL' } });

    expect(await generateTopicsForFact(inputs())).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('[topic-gen] local generation failed', expect.anything());
  });
});

// ===========================================================================
// generateTopicsForFact - the built-in model (Apple Intelligence / Gemini Nano)
// ===========================================================================

describe('generateTopicsForFact on the built-in model', () => {
  beforeEach(async () => {
    installOnDeviceLlm();
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

  it('a long exclusion list is cut to fit the model input: own topics first, one call, topics back', async () => {
    // Gemini Nano refuses 4000 input tokens or more, and that refusal is not deferrable: an uncut
    // list of every declined topic would fail this fact on every retry.
    installOnDeviceLlm({ platformModel: 'nano', contextSize: 4000, reply: '{"topics": ["Chess clubs"]}' });
    const declined = Array.from({ length: 600 }, (_, i) => `declined topic number ${i} about something`);

    const topics = await generateTopicsForFact(inputs({ factStatement: 'Plays chess', excludeTopics: ['Chess openings', ...declined] }));

    expect(topics).toEqual(['Chess clubs']);
    expect(onDeviceLlmCalls()).toHaveLength(1);
    const [call] = onDeviceLlmCalls();
    const input = countTokens(call.instructions ?? '') + countTokens(call.prompt) + countTokens(call.schemaJson ?? '');
    expect(input).toBeLessThan(4000 - 1024);
    expect(call.prompt).toContain('- Chess openings\n- declined topic number 0 about something');
    expect(call.prompt).not.toContain('declined topic number 599');
  });

  it.each(['ERR_AFM_BUSY', 'ERR_AFM_UNAVAILABLE'] as const)('%s reaches the caller, so the queue defers the job', async (code) => {
    installOnDeviceLlm({ reply: { error: code } });

    await expect(generateTopicsForFact(inputs())).rejects.toMatchObject({ code });
    expect(onDeviceLlmCalls()).toHaveLength(1);
  });
});

describe('ux2 F5: the cloud branch is retired', () => {
  it('a useCloud input never reaches the cloud: the local engine runs', async () => {
    installOnDeviceLlm(topicsReply('nurse staffing'));

    const result = await generateTopicsForFact(inputs({ factStatement: 'Works as a nurse', useCloud: true }));

    expect(result).toEqual(['nurse staffing']);
    expect(gatewayCalls()).toHaveLength(0);
    expect(onDeviceLlmCalls()).toHaveLength(1);
  });
});
