// inference.ts wraps llama.rn context. We mock _getContext and _updateInferenceSpeed.
// jest.mock() is hoisted above variable declarations, so the factory must be
// self-contained. We grab the mock fn refs from the module after import.

jest.mock('../modelManager', () => ({
  __esModule: true,
  _getContext: jest.fn(),
  _updateInferenceSpeed: jest.fn(),
  // Provide all other exports from modelManager so transitive imports don't crash
  getModelState: jest.fn(() => null),
  initBaseModel: jest.fn(),
  disposeModel: jest.fn(),
  downloadBaseModel: jest.fn(),
  deleteBaseModel: jest.fn(),
  purgeAllBaseModels: jest.fn(),
  cancelActiveDownload: jest.fn(),
  isModelDownloaded: jest.fn(),
  resetContext: jest.fn(),
  _getActiveAdapterId: jest.fn(() => null),
  _setActiveAdapterId: jest.fn(),
}));

import { infer, inferStream } from '../inference';
import type { InferParams } from '../../types';
import type { LlamaContext } from 'llama.rn';
import * as modelManager from '../modelManager';

// Grab typed mock refs from the hoisted mock — safe to do after imports.
const mockGetContext = modelManager._getContext as jest.MockedFunction<typeof modelManager._getContext>;
const mockUpdateInferenceSpeed = modelManager._updateInferenceSpeed as jest.MockedFunction<typeof modelManager._updateInferenceSpeed>;

// Completion mock lives on the context object returned by _getContext.
const mockCompletion = jest.fn();
const mockContext = { completion: mockCompletion } as unknown as LlamaContext;

const BASE_PARAMS: InferParams = {
  prompt: 'What is the capital of France?',
};

describe('infer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContext.mockReturnValue(mockContext);
  });

  it('throws when no model is loaded', async () => {
    mockGetContext.mockReturnValueOnce(null);
    await expect(infer(BASE_PARAMS)).rejects.toThrow('No model loaded. Call initBaseModel() first.');
  });

  it('calls context.completion with system prompt and user message', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'Paris',
      tokens_predicted: 5,
      tokens_evaluated: 20,
      truncated: false,
      timings: { predicted_per_second: 25 },
    });

    await infer({ ...BASE_PARAMS, systemPrompt: 'You are a helpful assistant.' });

    expect(mockCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: BASE_PARAMS.prompt },
        ],
      }),
    );
  });

  it('calls context.completion without system message when systemPrompt is absent', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'Paris',
      tokens_predicted: 5,
      tokens_evaluated: 20,
      truncated: false,
      timings: null,
    });

    await infer(BASE_PARAMS);

    const [opts] = mockCompletion.mock.calls[0];
    expect(opts.messages).toEqual([{ role: 'user', content: BASE_PARAMS.prompt }]);
  });

  it('uses default maxTokens=512 when not specified', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'Paris',
      tokens_predicted: 5,
      tokens_evaluated: 20,
      truncated: false,
      timings: null,
    });

    await infer(BASE_PARAMS);
    expect(mockCompletion).toHaveBeenCalledWith(expect.objectContaining({ n_predict: 512 }));
  });

  it('uses custom maxTokens when provided', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'A',
      tokens_predicted: 1,
      tokens_evaluated: 5,
      truncated: false,
      timings: null,
    });

    await infer({ ...BASE_PARAMS, maxTokens: 256 });
    expect(mockCompletion).toHaveBeenCalledWith(expect.objectContaining({ n_predict: 256 }));
  });

  it('uses default temperature=0.3', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'x',
      tokens_predicted: 1,
      tokens_evaluated: 2,
      truncated: false,
      timings: null,
    });

    await infer(BASE_PARAMS);
    expect(mockCompletion).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.3 }));
  });

  it('uses custom temperature when provided', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'x',
      tokens_predicted: 1,
      tokens_evaluated: 2,
      truncated: false,
      timings: null,
    });

    await infer({ ...BASE_PARAMS, temperature: 0.9 });
    expect(mockCompletion).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.9 }));
  });

  it('sets enable_thinking to false by default', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'x',
      tokens_predicted: 1,
      tokens_evaluated: 2,
      truncated: false,
      timings: null,
    });

    await infer(BASE_PARAMS);
    expect(mockCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ enable_thinking: false }),
    );
  });

  it('passes enable_thinking: true when requested', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'x',
      tokens_predicted: 1,
      tokens_evaluated: 2,
      truncated: false,
      timings: null,
    });

    await infer({ ...BASE_PARAMS, enableThinking: true });
    expect(mockCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ enable_thinking: true }),
    );
  });

  it('adds response_format json_object when responseFormat="json"', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: '{}',
      tokens_predicted: 2,
      tokens_evaluated: 5,
      truncated: false,
      timings: null,
    });

    await infer({ ...BASE_PARAMS, responseFormat: 'json' });
    expect(mockCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: 'json_object' },
      }),
    );
  });

  it('does NOT add response_format for text mode', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'answer',
      tokens_predicted: 1,
      tokens_evaluated: 4,
      truncated: false,
      timings: null,
    });

    await infer({ ...BASE_PARAMS, responseFormat: 'text' });
    const [opts] = mockCompletion.mock.calls[0];
    expect(opts.response_format).toBeUndefined();
  });

  it('returns the correct InferResult shape', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'Paris',
      tokens_predicted: 5,
      tokens_evaluated: 20,
      truncated: false,
      timings: { predicted_per_second: 30 },
    });

    const result = await infer(BASE_PARAMS);
    expect(result.output).toBe('Paris');
    expect(result.tokensUsed).toBe(25); // 5 + 20
    expect(result.truncated).toBe(false);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('calls _updateInferenceSpeed when timings.predicted_per_second is present', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'answer',
      tokens_predicted: 10,
      tokens_evaluated: 5,
      truncated: false,
      timings: { predicted_per_second: 42.7 },
    });

    await infer(BASE_PARAMS);
    expect(mockUpdateInferenceSpeed).toHaveBeenCalledWith(43); // Math.round(42.7)
  });

  it('does NOT call _updateInferenceSpeed when timings is null', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'answer',
      tokens_predicted: 10,
      tokens_evaluated: 5,
      truncated: false,
      timings: null,
    });

    await infer(BASE_PARAMS);
    expect(mockUpdateInferenceSpeed).not.toHaveBeenCalled();
  });

  it('passes stopSequences to context.completion', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: 'done',
      tokens_predicted: 1,
      tokens_evaluated: 2,
      truncated: false,
      timings: null,
    });

    await infer({ ...BASE_PARAMS, stopSequences: ['</s>', '\n\n'] });
    expect(mockCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ stop: ['</s>', '\n\n'] }),
    );
  });
});

describe('inferStream', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContext.mockReturnValue(mockContext);
  });

  it('throws when no model is loaded', async () => {
    mockGetContext.mockReturnValueOnce(null);
    const gen = inferStream(BASE_PARAMS);
    await expect(gen.next()).rejects.toThrow('No model loaded. Call initBaseModel() first.');
  });

  it('yields tokens from the completion callback in order', async () => {
    // completion calls the callback with tokens then resolves
    mockCompletion.mockImplementation(async (_opts: any, callback: (data: { token: string }) => void) => {
      callback({ token: 'Tok1' });
      callback({ token: 'Tok2' });
      callback({ token: 'Tok3' });
      return { text: 'Tok1Tok2Tok3', tokens_predicted: 3, tokens_evaluated: 5, truncated: false };
    });

    const tokens: string[] = [];
    for await (const tok of inferStream(BASE_PARAMS)) {
      tokens.push(tok);
    }
    expect(tokens).toEqual(['Tok1', 'Tok2', 'Tok3']);
  });

  it('yields no tokens when completion callback is never called', async () => {
    mockCompletion.mockImplementation(async () => ({
      text: '',
      tokens_predicted: 0,
      tokens_evaluated: 0,
      truncated: false,
    }));

    const tokens: string[] = [];
    for await (const tok of inferStream(BASE_PARAMS)) {
      tokens.push(tok);
    }
    expect(tokens).toEqual([]);
  });

  it('propagates errors from the completion promise', async () => {
    mockCompletion.mockImplementation(async (_opts: any, _cb: any) => {
      throw new Error('inference error');
    });

    const gen = inferStream(BASE_PARAMS);
    const results: string[] = [];
    let caught: Error | null = null;
    try {
      for await (const tok of gen) {
        results.push(tok);
      }
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toBe('inference error');
  });

  it('passes system prompt when provided', async () => {
    mockCompletion.mockImplementation(async (_opts: any, _cb: any) => ({
      text: '',
      tokens_predicted: 0,
      tokens_evaluated: 0,
      truncated: false,
    }));

    const gen = inferStream({ ...BASE_PARAMS, systemPrompt: 'System: be concise.' });
    // Drain the generator
    for await (const _ of gen) { /* noop */ }

    expect(mockCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: 'system', content: 'System: be concise.' },
        ]),
      }),
      expect.any(Function),
    );
  });

  it('adds json response_format in streaming mode when responseFormat="json"', async () => {
    mockCompletion.mockImplementation(async (_opts: any, _cb: any) => ({
      text: '{}',
      tokens_predicted: 2,
      tokens_evaluated: 3,
      truncated: false,
    }));

    const gen = inferStream({ ...BASE_PARAMS, responseFormat: 'json' });
    for await (const _ of gen) { /* noop */ }

    expect(mockCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: 'json_object' },
      }),
      expect.any(Function),
    );
  });
});

// llama.rn has ONE context and a completion mutates its KV cache in place, so
// overlapping calls corrupt each other's output and timings. These cover the
// serialisation itself rather than any single call's arguments.
describe('llama access is serialised', () => {
  const RESULT = {
    text: 'Paris',
    tokens_predicted: 5,
    tokens_evaluated: 20,
    truncated: false,
    timings: null,
  };

  // jest.clearAllMocks() only clears usage data, not implementations, and the
  // suites above install persistent ones with mockImplementation.
  beforeEach(() => {
    mockCompletion.mockReset();
    mockGetContext.mockReturnValue(mockContext);
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('does not start a second infer() until the first has settled', async () => {
    const first = deferred<typeof RESULT>();
    mockCompletion.mockReturnValueOnce(first.promise).mockResolvedValueOnce(RESULT);

    const a = infer(BASE_PARAMS);
    const b = infer(BASE_PARAMS);
    await flush();

    expect(mockCompletion).toHaveBeenCalledTimes(1);

    first.resolve(RESULT);
    await Promise.all([a, b]);
    expect(mockCompletion).toHaveBeenCalledTimes(2);
  });

  it('does not wedge the chain when a completion rejects', async () => {
    mockCompletion
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(RESULT);

    await expect(infer(BASE_PARAMS)).rejects.toThrow('boom');
    await expect(infer(BASE_PARAMS)).resolves.toMatchObject({ output: 'Paris' });
  });

  it('holds the lock for the whole of inferStream, not just its first await', async () => {
    const streamDone = deferred<typeof RESULT>();
    let emit: ((token: string) => void) | null = null;
    mockCompletion.mockImplementationOnce(async (_opts: any, cb: any) => {
      emit = (token: string) => cb({ token });
      return streamDone.promise;
    });

    const collected: string[] = [];
    const consume = (async () => {
      for await (const token of inferStream(BASE_PARAMS)) collected.push(token);
    })();
    await flush();

    mockCompletion.mockResolvedValueOnce(RESULT);
    const queued = infer(BASE_PARAMS);
    await flush();

    // The stream still holds the lock, so the queued infer has not begun.
    expect(mockCompletion).toHaveBeenCalledTimes(1);

    emit!('hi');
    streamDone.resolve(RESULT);
    await consume;
    await queued;

    expect(collected).toEqual(['hi']);
    expect(mockCompletion).toHaveBeenCalledTimes(2);
  });

  it('releases the lock when inferStream throws', async () => {
    mockCompletion.mockImplementationOnce(async () => {
      throw new Error('stream boom');
    });

    await expect(
      (async () => {
        for await (const _ of inferStream(BASE_PARAMS)) { /* noop */ }
      })(),
    ).rejects.toThrow('stream boom');

    mockCompletion.mockResolvedValueOnce(RESULT);
    await expect(infer(BASE_PARAMS)).resolves.toMatchObject({ output: 'Paris' });
  });
});
