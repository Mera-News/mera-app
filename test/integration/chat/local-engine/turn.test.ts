
import { __setJobHandlerForTests, inferenceQueue } from '@/lib/inference/InferenceQueue';
import { decide, disposeModel, RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import '@/test/helpers';
import { llamaLoads } from '@/test/helpers/llama';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import {
  installLlama,
  llamaCalls,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
} from '@/test/integration/chat/_helpers';
import {
  attachLocal,
  expectNothingLeftTheDevice,
  lastAssistant,
  local,
  samplePhases,
  settle,
  turnDone,
} from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

/** Scripts the built-in model's replies. */
const text = (reply: NonNullable<Parameters<typeof installOnDeviceLlm>[0]>['reply']) => installOnDeviceLlm({ reply });

jest.setTimeout(30_000);

afterEach(async () => {
  await settle();
  __setJobHandlerForTests('topic_gen', undefined);
  await inferenceQueue.stop();
});

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await setProcessingMode('on-device');
  // Kev on disk; a llama.rn completion fails the test.
  installLlama(() => ({ tokens: [], error: 'llama.rn completion on Kev' }));
});

describe('the wait line', () => {
  it('preparing, then thinking, then released: the built-in model loads nothing and chat writes no model state', async () => {
    text(['Hello', ' there', '.']);
    await disposeModel();
    const states: string[] = [];
    const unsub = useMeraProtocolStore.subscribe((s) => states.push(s.modelState));
    const phases = samplePhases();
    const { engine } = await attachLocal();

    engine.send('hi');
    await turnDone();
    unsub();
    phases.stop();

    expect(phases.seen).toEqual(['devicePreparing', 'deviceThinking', 'released']);
    expect(llamaLoads()).toEqual([]);
    expect(states).toEqual([]);
    expect(lastAssistant()?.content).toBe('Hello there.');
    expectNothingLeftTheDevice();
  });
});

describe('Kev resident between turns', () => {
  beforeEach(async () => {
    await disposeModel();
  });

  it('a scoring pass between two turns leaves Kev loaded; the turns never touch llama.rn', async () => {
    text(['Hello', ' there', '.']);
    const { engine } = await attachLocal();
    engine.send('hi');
    await turnDone();
    expect(llamaLoads()).toEqual([]);

    await decide({ state: {}, questions: { rel: { type: 'score' } } } as never);
    engine.send('again');
    await turnDone();

    expect(local().error).toBeNull();
    expect(lastAssistant()?.content).toBe('Hello there.');
    expect(onDeviceLlmCalls()).toHaveLength(2);
    expect(llamaCalls()).toHaveLength(0);
    expect(llamaLoads()).toEqual([RELEVANCE_MODEL.modelId]);
  });
});
