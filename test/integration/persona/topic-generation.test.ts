// lib/mera-protocol/topic-generation-service through the real on-device engine: completeLocal,
// modelManager and the inference queue run for real, with only llama.rn (scripted) and
// expo-file-system (in-memory) faked. Replaces topic-generation-service.test.ts.
//
// The service is LOCAL ONLY since ux2 F5 (generateTopicsForFact ignores `useCloud`; cloud topics
// come from the skill core's topic-gen handler in lib/mera-harness), so there is no gateway path
// to drive here: the cloud half of the old file is the test that nothing reaches the gateway.
import { LocalTruncatedReasoningError } from '@/lib/llm/completeLocal';
import logger from '@/lib/logger';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import {
  generateRealTopicsForFact,
  generateTopicsForFact,
  generateTopicsFromFact,
  mergeRealOutputsForFact,
  parseTopicsFromOutput,
} from '@/lib/mera-protocol/topic-generation-service';
import {
  LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT,
} from '@/lib/news-harness/prompts/prompts';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { gatewayCalls } from '@/test/helpers';
import { installLlama, llamaCalls, type LlamaCall, type LlamaScript } from '@/test/helpers/llama';
import { resetFileSystem } from '@/test/helpers/fs';
import { resetChatModules } from '@/test/integration/chat/_helpers';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);

jest.setTimeout(30_000);

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await disposeModel();
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

/** The factOnly prompt answers with `first`, the combo prompt with `second`. */
function byPrompt(first: LlamaScript, second: LlamaScript = []): (c: LlamaCall) => LlamaScript {
  return (c) => (systemOf(c) === LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT ? second : first);
}

// ===========================================================================
// parseTopicsFromOutput
// ===========================================================================

describe('parseTopicsFromOutput', () => {
  const fact = 'Lives in Amsterdam';

  it('parses a valid JSON array of strings', () => {
    expect(parseTopicsFromOutput('["Amsterdam news", "Dutch politics"]', fact)).toEqual(['Amsterdam news', 'Dutch politics']);
  });

  it('filters out non-string elements, empty strings and whitespace-only strings', () => {
    expect(parseTopicsFromOutput('["AI news", 42, null, "tech policy"]', fact)).toEqual(['AI news', 'tech policy']);
    expect(parseTopicsFromOutput('["AI news", "", "  ", "tech"]', fact)).toEqual(['AI news', 'tech']);
  });

  it('trims whitespace from each topic', () => {
    expect(parseTopicsFromOutput('["  AI news  ", " tech "]', fact)).toEqual(['AI news', 'tech']);
  });

  it('caps results at 20 topics', () => {
    const arr = Array.from({ length: 25 }, (_, i) => `topic ${i}`);
    expect(parseTopicsFromOutput(JSON.stringify(arr), fact)).toHaveLength(20);
  });

  it.each([
    ['text around the array', 'Here are the topics: ["Amsterdam news", "EU regulation"] , end', ['Amsterdam news', 'EU regulation']],
    ['a markdown code fence', '```json\n["Amsterdam news", "EU tech"]\n```', ['Amsterdam news', 'EU tech']],
    ['trailing text after the bracket', '["Amsterdam news", "EU regulation"] some note', ['Amsterdam news', 'EU regulation']],
  ])('uses the bracket fallback for %s', (_label, output, expected) => {
    expect(parseTopicsFromOutput(output, fact)).toEqual(expected);
  });

  it('returns [] and logs a warning when the output is completely unparseable', () => {
    expect(parseTopicsFromOutput('no json here', fact)).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each([[''], ['[]']])('returns [] for %j', (output) => {
    expect(parseTopicsFromOutput(output, fact)).toEqual([]);
  });
});

// ===========================================================================
// mergeRealOutputsForFact
// ===========================================================================

describe('mergeRealOutputsForFact', () => {
  const fact = 'Works in AI';

  it('merges factOnly and combo outputs with factOnly first', () => {
    expect(mergeRealOutputsForFact('["AI news", "ML research"]', '["DeepMind news", "AI startups"]', fact)).toEqual([
      'AI news',
      'ML research',
      'DeepMind news',
      'AI startups',
    ]);
  });

  it('deduplicates case-insensitively and keeps the casing of the first occurrence', () => {
    const result = mergeRealOutputsForFact('["AI News", "ML research"]', '["ai news", "AI startups"]', fact);
    expect(result).toEqual(['AI News', 'ML research', 'AI startups']);
  });

  it('deduplicates topics that differ only in trailing spaces', () => {
    expect(mergeRealOutputsForFact('["AI news"]', '["AI news  "]', fact)).toHaveLength(1);
  });

  it('handles a null output on either side, and both', () => {
    expect(mergeRealOutputsForFact(null, '["combo topic"]', fact)).toEqual(['combo topic']);
    expect(mergeRealOutputsForFact('["factOnly topic"]', null, fact)).toEqual(['factOnly topic']);
    expect(mergeRealOutputsForFact(null, null, fact)).toEqual([]);
  });
});

// ===========================================================================
// generateTopicsFromFact (local-only wrapper)
// ===========================================================================

describe('generateTopicsFromFact', () => {
  it('asks the local model once, as JSON, and returns the parsed topics', async () => {
    installLlama(['["Amsterdam news", "Dutch politics"]']);

    const result = await generateTopicsFromFact('Lives in Amsterdam');

    expect(result).toEqual(['Amsterdam news', 'Dutch politics']);
    expect(llamaCalls()).toHaveLength(1);
    const [call] = llamaCalls();
    expect(systemOf(call)).toBe(LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT);
    expect(userOf(call)).toContain('Fact: "');
    expect(userOf(call)).toContain('Lives in Amsterdam');
    expect(userOf(call)).toContain('Generate 14 topics.');
    // The on-device output ceiling, the topic-gen temperature and the JSON grammar.
    expect(call.params).toMatchObject({ n_predict: 1024, temperature: 0.3, response_format: { type: 'json_object' } });
  });

  it('returns [] when the model returns unparseable output', async () => {
    installLlama(['not valid json']);
    expect(await generateTopicsFromFact('some fact')).toEqual([]);
    expect(llamaCalls()).toHaveLength(1);
  });

  it('rejects, rather than reporting an empty answer, when the model ran out of budget mid-reasoning', async () => {
    installLlama({ tokens: ['<think>let me think'], truncated: true });

    await expect(generateTopicsFromFact('some fact')).rejects.toBeInstanceOf(LocalTruncatedReasoningError);
  });
});

// ===========================================================================
// generateTopicsForFact - local path
// ===========================================================================

describe('generateTopicsForFact - local path', () => {
  it('asks for factOnly and then combo when other facts exist, splitting the default 10 as 6 and 4', async () => {
    installLlama(byPrompt(['["AI news"]'], ['["AI Amsterdam combo"]']));

    const result = await generateTopicsForFact(inputs({ userLocation: 'Amsterdam', otherFacts: ['another fact'] }));

    expect(result).toEqual(['AI news', 'AI Amsterdam combo']);
    const [factOnly, combo] = llamaCalls();
    expect(llamaCalls()).toHaveLength(2);
    expect(systemOf(factOnly)).toBe(LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT);
    expect(userOf(factOnly)).toContain('Fact: "Works in AI"');
    expect(userOf(factOnly)).toContain('User location: Amsterdam');
    expect(userOf(factOnly)).not.toContain('another fact');
    expect(userOf(factOnly)).toContain('Generate 6 topics.');
    expect(systemOf(combo)).toBe(LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT);
    expect(userOf(combo)).toContain('- another fact');
    expect(userOf(combo)).toContain('Generate at most 4 topics');
  });

  it('asks once when otherFacts is empty, for the whole count', async () => {
    installLlama(['["AI news"]']);

    await generateTopicsForFact(inputs());

    expect(llamaCalls()).toHaveLength(1);
    expect(userOf(llamaCalls()[0])).toContain('Generate 10 topics.');
  });

  it('continues with the factOnly result if the combo call fails locally', async () => {
    installLlama(byPrompt(['["AI news"]'], { tokens: [], error: 'local combo fail' }));

    const result = await generateTopicsForFact(inputs({ otherFacts: ['other fact'] }));

    expect(result).toEqual(['AI news']);
    expect(logger.warn).toHaveBeenCalledWith('[topic-gen] local combo failed', { error: 'local combo fail' });
  });

  it('continues with the combo result if the factOnly call fails locally', async () => {
    installLlama(byPrompt({ tokens: [], error: 'local factOnly fail' }, ['["Combo topic"]']));

    const result = await generateTopicsForFact(inputs({ otherFacts: ['other fact'] }));

    expect(result).toEqual(['Combo topic']);
    expect(logger.warn).toHaveBeenCalledWith('[topic-gen] local factOnly failed', { error: 'local factOnly fail' });
  });

  it('returns [] when all local calls fail', async () => {
    installLlama({ tokens: [], error: 'fail' });

    expect(await generateTopicsForFact(inputs())).toEqual([]);
    expect(llamaCalls()).toHaveLength(1);
  });

  it('respects a custom totalCount, and raises the ceiling only past 1024 tokens', async () => {
    installLlama(['["topic a", "topic b", "topic c"]']);

    await generateTopicsForFact(inputs({ totalCount: 3 }));
    expect(userOf(llamaCalls()[0])).toContain('Generate 3 topics');
    expect(llamaCalls()[0].params.n_predict).toBe(1024);

    installLlama(['["x"]']);
    await generateTopicsForFact(inputs({ totalCount: 40 }));
    expect(llamaCalls()[0].params.n_predict).toBe(1200);
  });

  it('tells the model which topics not to repeat when asked for more', async () => {
    installLlama(['["fresh topic"]']);

    await generateTopicsForFact(inputs({ excludeTopics: ['old topic'] }));

    expect(userOf(llamaCalls()[0])).toContain('Do NOT repeat these existing topics:\n- old topic');
  });
});

// ===========================================================================
// generateRealTopicsForFact / ux2 F5
// ===========================================================================

describe('generateRealTopicsForFact', () => {
  it('delegates to generateTopicsForFact (the local engine)', async () => {
    installLlama(['["AI news"]']);
    expect(await generateRealTopicsForFact(inputs())).toEqual(['AI news']);
  });
});

describe('ux2 F5: the cloud branch is retired', () => {
  it('a useCloud input never reaches the cloud, even in cloud mode: the local engine runs', async () => {
    useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.Cloud);
    installLlama(['["nurse staffing"]']);

    const result = await generateTopicsForFact(inputs({ factStatement: 'Works as a nurse', useCloud: true }));

    expect(result).toEqual(['nurse staffing']);
    expect(gatewayCalls()).toHaveLength(0);
    expect(llamaCalls()).toHaveLength(1);
  });
});
