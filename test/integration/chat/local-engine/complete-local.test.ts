// completeLocal (lib/llm/completeLocal.ts) against the real toolkit: the model manager, the
// inference lock and the lazy model load run for real, with only llama.rn (scripted) and
// expo-file-system (in-memory) faked. Replaces lib/llm/__tests__/completeLocal.test.ts, which
// mocked the toolkit and the protocol store.
import { activeHolds } from '@/lib/app-restart';
import { completeLocal, LocalTruncatedReasoningError } from '@/lib/llm/completeLocal';
import logger from '@/lib/logger';
import { disposeModel, initBaseModel } from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import '@/test/helpers';
import {
  installLlama,
  llamaCalls,
  resetChatModules,
  resetFileSystem,
  type LlamaScript,
} from '@/test/integration/chat/_helpers';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

const initLlama = () => (jest.requireMock('llama.rn') as { initLlama: jest.Mock }).initLlama;

/** Scripts one completion that answers `text` (one token), loaded and ready. */
async function ready(script: LlamaScript | string = 'ok'): Promise<void> {
  installLlama(typeof script === 'string' ? [script] : script);
  await initBaseModel();
  initLlama().mockClear();
}

const ask = (extra: Partial<Parameters<typeof completeLocal>[0]> = {}) =>
  completeLocal({ systemPrompt: 'sys', prompt: 'user', ...extra });

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await disposeModel();
  useMeraProtocolStore.getState().setModelState('downloaded');
});

describe('model initialization', () => {
  it('does NOT load the model when one is already loaded', async () => {
    await ready('hello world');
    useMeraProtocolStore.getState().setModelState('ready');
    const states: string[] = [];
    const unsub = useMeraProtocolStore.subscribe((s) => states.push(s.modelState));

    await ask();
    unsub();

    expect(initLlama()).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it('loads the model first when none is loaded: the model state goes loading then ready', async () => {
    installLlama(['hello world']);
    const states: string[] = [];
    const unsub = useMeraProtocolStore.subscribe((s) => {
      if (states.at(-1) !== s.modelState) states.push(s.modelState);
    });

    await expect(ask()).resolves.toBe('hello world');
    unsub();

    expect(initLlama()).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['loading', 'ready']);
  });
});

describe('output post-processing', () => {
  it('strips <think>...</think> blocks and trims whitespace', async () => {
    await ready('  <think>some reasoning here</think>  actual answer  ');
    await expect(ask()).resolves.toBe('actual answer');
  });

  it('strips multi-line <think> blocks', async () => {
    await ready('<think>\nline1\nline2\n</think>\nfinal answer');
    await expect(ask()).resolves.toBe('final answer');
  });

  it('strips multiple <think> blocks', async () => {
    await ready('<think>block1</think> text <think>block2</think> end');
    await expect(ask()).resolves.toBe('text  end');
  });

  it('returns trimmed output with no think blocks', async () => {
    await ready('   clean output   ');
    await expect(ask()).resolves.toBe('clean output');
  });

  it('returns an empty string when the output is only think blocks', async () => {
    await ready('<think>all reasoning</think>');
    await expect(ask()).resolves.toBe('');
  });

  it('joins tokens before stripping: a tag split across tokens is still a tag', async () => {
    await ready(['<thi', 'nk>reasoning</th', 'ink>answ', 'er']);
    await expect(ask()).resolves.toBe('answer');
  });
});

describe('request forwarding', () => {
  it('sends the system prompt and the prompt, with 512 tokens and temperature 0.3 by default', async () => {
    await ready('result');
    await ask({ prompt: 'u' });

    expect(llamaCalls()).toHaveLength(1);
    expect(llamaCalls()[0].messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ]);
    expect(llamaCalls()[0].params).toMatchObject({ n_predict: 512, temperature: 0.3, enable_thinking: false });
    expect(llamaCalls()[0].params).not.toHaveProperty('response_format');
  });

  it('forwards explicit maxTokens and temperature', async () => {
    await ready('');
    await ask({ maxTokens: 256, temperature: 0.7 });
    expect(llamaCalls()[0].params).toMatchObject({ n_predict: 256, temperature: 0.7 });
  });

  it('asks for the JSON grammar when responseFormat is json (a model that supports it)', async () => {
    await ready('{}');
    await ask({ responseFormat: 'json' });
    expect(llamaCalls()[0].params).toMatchObject({ response_format: { type: 'json_object' } });
  });

  it('sends no grammar for a model that does not support it, even for json', async () => {
    useMeraProtocolStore.getState().setSelectedModelId('mera-lfm2-2.6b');
    await ready('{}');
    await ask({ responseFormat: 'json' });
    expect(llamaCalls()[0].params).not.toHaveProperty('response_format');
  });

  it('maps responseFormat text to no grammar', async () => {
    await ready('text result');
    await ask({ responseFormat: 'text' });
    expect(llamaCalls()[0].params).not.toHaveProperty('response_format');
  });

  it('forwards the enableThinking flag', async () => {
    await ready('');
    await ask({ enableThinking: true });
    expect(llamaCalls()[0].params).toMatchObject({ enable_thinking: true });
  });
});

// A live production defect once: local topic generation runs with thinking on; when the reasoning
// trace used up the token budget the model stopped mid-<think>, the strip (which needs a CLOSING
// tag) matched nothing, and the raw trace came back as the answer. The caller's JSON parse then
// found no array and the user was told "no usable topics" for a fact that had generated fine.
describe('truncated reasoning', () => {
  it('throws on an unclosed <think> instead of returning the trace as output', async () => {
    await ready('<think>I should list topics about Bhopal, starting with loc');
    await expect(ask({ enableThinking: true })).rejects.toThrow(LocalTruncatedReasoningError);
  });

  it('names the budget in the error so the fix is obvious', async () => {
    await ready('<think>reasoning cut off');
    await expect(ask({ maxTokens: 400 })).rejects.toThrow(/maxTokens=400/);
  });

  it('throws when llama.rn reports truncation and nothing usable remains', async () => {
    await ready({ tokens: ['   '], truncated: true });
    await expect(ask()).rejects.toThrow(LocalTruncatedReasoningError);
  });

  it('returns a truncated-but-substantive answer rather than throwing, and warns', async () => {
    await ready({ tokens: ['["a","b"'], truncated: true });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(ask({ maxTokens: 300, enableThinking: true })).resolves.toBe('["a","b"');

    expect(warn).toHaveBeenCalledWith('[completeLocal] output truncated at the token ceiling', {
      maxTokens: 300,
      outputLength: 8,
      enableThinking: true,
    });
    warn.mockRestore();
  });

  it('does not warn when the answer was not truncated', async () => {
    await ready('["a"]');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await ask();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not throw for a well-formed think block (the normal case)', async () => {
    await ready('<think>done</think>["a"]');
    await expect(ask()).resolves.toBe('["a"]');
  });

  it('handles the chat-template PREFILL shape: a closer with no opener', async () => {
    // The Qwen3 template can inject the opening <think> into the PROMPT, so a successful
    // generation comes back as `reasoning</think>answer`. That is a success, not a truncation.
    await ready('let me think about this</think>\n["topic one"]');
    await expect(ask({ enableThinking: true })).resolves.toBe('["topic one"]');
  });

  it('uses the LAST closer when the reasoning mentions the tag', async () => {
    await ready('first</think>middle</think>["final"]');
    await expect(ask()).resolves.toBe('["final"]');
  });
});

describe('errors', () => {
  it('propagates a failure from the completion and releases the restart hold', async () => {
    await ready({ tokens: [], error: 'llama crash' });
    await expect(ask()).rejects.toThrow('llama crash');
    expect(activeHolds()).not.toContain('local-inference');
  });

  it('a failed completion does not wedge the lock: the next call runs', async () => {
    installLlama((call) => (llamaCalls().indexOf(call) === 0 ? { tokens: [], error: 'llama crash' } : ['fine']));
    await initBaseModel();
    await expect(ask()).rejects.toThrow('llama crash');
    await expect(ask()).resolves.toBe('fine');
  });

  it('propagates a failure to load the model', async () => {
    installLlama(['unused']);
    initLlama().mockRejectedValueOnce(new Error('load failed'));
    await expect(ask()).rejects.toThrow('load failed');
  });

  it('refuses a model that is not on disk', async () => {
    installLlama(['unused']);
    resetFileSystem();
    await expect(ask()).rejects.toThrow(/not found on disk/);
  });
});
