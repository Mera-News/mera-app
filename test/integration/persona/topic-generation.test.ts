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
import { TOPIC_GEN_SYSTEM } from '@/lib/news-harness/on-device/topic-gen/prompt';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
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
const inputs = (over: Partial<Parameters<typeof generateTopicsForFact>[0]> = {}) => ({
  factStatement: 'Works in AI',
  userLocation: null,
  otherFacts: [],
  useCloud: false,
  ...over,
});
const topicsReply = (...topics: string[]) => ({ reply: JSON.stringify({ topics }) });

// ===========================================================================
// generateTopicsForFact - the request it builds (on the built-in model)
// ===========================================================================

describe('generateTopicsForFact: the request', () => {
  it('cuts a list longer than the count asked for', async () => {
    installOnDeviceLlm(topicsReply('a', 'b', 'c', 'd'));
    expect(await generateTopicsForFact(inputs({ totalCount: 2 }))).toEqual(['a', 'b']);
  });

  it('retries a reply that does not fit the schema once, then throws: an error is never an empty answer', async () => {
    installOnDeviceLlm({ reply: 'not valid json' });

    await expect(generateTopicsForFact(inputs())).rejects.toThrow();
    expect(onDeviceLlmCalls()).toHaveLength(2);
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
});
