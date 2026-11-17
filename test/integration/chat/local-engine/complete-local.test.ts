// completeLocal (lib/llm/completeLocal.ts) against the real toolkit: the inference lock and the
// built-in model path run for real, with only the built-in model module (scripted) and llama.rn
// (scripted: Kev only, never asked for text since D37) faked.
import { activeHolds } from '@/lib/app-restart';
import { completeLocal } from '@/lib/llm/completeLocal';
import { decide, disposeModel, RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import '@/test/helpers';
import { llamaLoads } from '@/test/helpers/llama';
import { installOnDeviceLlm } from '@/test/helpers/on-device-llm';
import { installLlama, llamaCalls, resetChatModules, resetFileSystem } from '@/test/integration/chat/_helpers';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

const ask = (extra: Partial<Parameters<typeof completeLocal>[0]> = {}) =>
  completeLocal({ systemPrompt: 'sys', prompt: 'user', ...extra });

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await disposeModel();
  // Kev on disk and on-device mode; any text call on llama.rn fails the test.
  installLlama(() => ({ tokens: [], error: 'llama.rn completion on Kev' }));
  installOnDeviceLlm({ reply: 'ok' });
});

describe('the built-in model writes the text', () => {
  it('answers through the built-in model, loads nothing on llama.rn and writes no model state', async () => {
    installOnDeviceLlm({ reply: 'hello world' });
    const states: string[] = [];
    const unsub = useMeraProtocolStore.subscribe((s) => states.push(s.modelState));

    await expect(ask()).resolves.toBe('hello world');
    unsub();

    expect(llamaLoads()).toEqual([]);
    expect(llamaCalls()).toHaveLength(0);
    expect(states).toEqual([]);
  });

  it('with Kev resident, the text call swaps nothing out: Kev stays loaded', async () => {
    await decide({ state: {}, questions: { rel: { type: 'score' } } } as never);
    await expect(ask()).resolves.toBe('ok');
    expect(llamaLoads()).toEqual([RELEVANCE_MODEL.modelId]);
  });
});

describe('errors', () => {
  it('propagates a failure from the built-in model and releases the restart hold', async () => {
    installOnDeviceLlm({ reply: { error: 'ERR_AFM_CONTEXT' } });
    await expect(ask()).rejects.toMatchObject({ code: 'ERR_AFM_CONTEXT' });
    expect(activeHolds()).not.toContain('local-inference');
  });
});
