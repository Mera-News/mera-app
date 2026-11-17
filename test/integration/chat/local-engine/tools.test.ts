
import '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import {
  installLlama,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
} from '@/test/integration/chat/_helpers';
import {
  attachLocal,
  lastAssistant,
  local,
  personaAgent,
  settle,
  turnDone,
} from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

jest.setTimeout(30_000);

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await setProcessingMode('on-device');
  // Kev on disk; the text comes from the built-in model.
  installLlama(() => ({ tokens: [], error: 'llama.rn completion on Kev' }));
});

/** Scripts the built-in model's replies. */
const text = (reply: NonNullable<Parameters<typeof installOnDeviceLlm>[0]>['reply']) => installOnDeviceLlm({ reply });
const calls = onDeviceLlmCalls;

describe('the persona fields to the executors', () => {
  it('a reply that never fits the schema fails the turn after one retry; nothing runs', async () => {
    text(['Sure, I can help with that.']);
    const { engine } = await attachLocal(personaAgent());
    engine.send('hi');
    await turnDone();

    expect(calls()).toHaveLength(2);
    expect(local().error).toBe('Inference failed: On-device reply did not match its schema');
    expect(lastAssistant()?.toolCalls ?? []).toEqual([]);
    expect(local().turnBusy).toBe(false);
  });
});
