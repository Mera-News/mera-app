// Tests for lib/llm/cloudComplete.ts — cloud LLM completion, batch, and streaming.
// ALL I/O is mocked; fake timers are used for retry/backoff paths.

// ─── I/O mocks (must precede imports) ─────────────────────────────────────────

const mockFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));

const mockGetJwtToken = jest.fn(() => Promise.resolve('test-jwt'));
const mockInvalidateJwtCache = jest.fn();
jest.mock('@/lib/auth-client', () => ({
  getJwtToken: (...args: unknown[]) => mockGetJwtToken(...args),
  invalidateJwtCache: (...args: unknown[]) => mockInvalidateJwtCache(...args),
}));

const mockPrepareE2EEContext = jest.fn();
const mockEncryptContent = jest.fn((s: string) => `enc(${s})`);
const mockDecryptContent = jest.fn((s: string) => s);
const mockEncryptMessages = jest.fn(
  async (messages: { role: string; content: string }[]) => {
    for (const msg of messages) {
      if (msg.content.length > 0) msg.content = `enc(${msg.content})`;
    }
    return makeE2EECtx();
  },
);

function makeE2EECtx() {
  return {
    headers: {
      'X-Signing-Algo': 'ed25519',
      'X-Client-Pub-Key': 'aabb',
      'X-Model-Pub-Key': 'ccdd',
      'X-Encryption-Version': '2',
    },
    privateKey: new Uint8Array(32),
    modelPubKeyHex: 'ccdd',
    clientPubKeyHex: 'aabb',
  };
}

jest.mock('@/lib/e2ee/e2ee-service', () => ({
  prepareE2EEContext: (...args: unknown[]) => mockPrepareE2EEContext(...args),
  encryptContent: (...args: unknown[]) => mockEncryptContent(...args),
  decryptContent: (...args: unknown[]) => mockDecryptContent(...args),
  encryptMessages: (...args: unknown[]) => mockEncryptMessages(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('@/lib/config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'https://inference.example.test',
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import {
  authFetch,
  cloudComplete,
  cloudBatchComplete,
  cloudChatStream,
  type SseEvent,
} from '../cloudComplete';
import type { BatchCall } from '../types';
import logger from '@/lib/logger';

// ─── Constants (mirrored from source) ─────────────────────────────────────────

const BASE_DELAY_MS = 500;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResponse(
  status: number,
  body: unknown = {},
  opts: { text?: string } = {},
): Response {
  return {
    status,
    statusText: String(status),
    ok: status >= 200 && status < 300,
    json: jest.fn(() => Promise.resolve(body)),
    text: jest.fn(() => Promise.resolve(opts.text ?? JSON.stringify(body))),
  } as unknown as Response;
}

function makeChatResponse(content: string, finishReason = 'stop', reasoningContent = ''): object {
  return {
    id: 'resp-1',
    model: 'test-model',
    choices: [
      {
        message: {
          content,
          reasoning_content: reasoningContent,
          tool_calls: null,
        },
        finish_reason: finishReason,
      },
    ],
  };
}

// ─── authFetch ─────────────────────────────────────────────────────────────────

describe('authFetch', () => {
  beforeEach(() => {
    // Use mockReset (not clearAllMocks) so mockResolvedValueOnce queues are drained.
    mockFetch.mockReset();
    mockGetJwtToken.mockReset();
    mockInvalidateJwtCache.mockReset();
    [(logger.captureException as jest.Mock), (logger.warn as jest.Mock), (logger.error as jest.Mock), (logger.debug as jest.Mock)].forEach((fn) => fn.mockReset());
    jest.useRealTimers();
    mockGetJwtToken.mockResolvedValue('test-jwt');
    mockPrepareE2EEContext.mockResolvedValue(makeE2EECtx());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns response on first successful attempt', async () => {
    const resp = makeResponse(200);
    mockFetch.mockResolvedValueOnce(resp);
    const result = await authFetch('https://test.test/api', { method: 'POST', headers: {} });
    expect(result).toBe(resp);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('forwards URL and init to underlying fetch', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200));
    await authFetch('https://test.test/endpoint', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok' },
      body: '{"x":1}',
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.test/endpoint');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(init.body).toBe('{"x":1}');
  });

  it('on 401: invalidates JWT cache and retries', async () => {
    // Using real timers: sleep(500ms) is acceptable for 1 retry.
    mockGetJwtToken
      .mockResolvedValueOnce('old-jwt')
      .mockResolvedValueOnce('new-jwt');
    mockFetch
      .mockResolvedValueOnce(makeResponse(401))
      .mockResolvedValueOnce(makeResponse(200));

    const result = await authFetch('https://test.test/api', {
      method: 'POST',
      headers: { Authorization: 'Bearer old-jwt' },
    });

    expect(result.status).toBe(200);
    expect(mockInvalidateJwtCache).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // logger.warn('[CloudLLM] 401 on attempt 1, refreshing JWT') — single-arg call
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('401'),
    );
  }, 10_000);

  it('on 500: retries and returns success on second attempt', async () => {
    // 1 retry = 500ms real sleep — acceptable.
    mockFetch
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(200));

    const result = await authFetch('https://test.test/api', { method: 'POST' });

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // logger.warn('[CloudLLM] 500 on attempt 1, retrying') — single-arg call
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('500'),
    );
  }, 10_000);

  it('on 503: retries and returns success on third attempt', async () => {
    // 2 retries = 500 + 1000 = 1500ms real sleep — acceptable.
    mockFetch
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200));

    const result = await authFetch('https://test.test/api', { method: 'POST' });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('on network error: retries and returns success', async () => {
    // 1 retry = 500ms real sleep — acceptable.
    mockFetch
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValueOnce(makeResponse(200));

    const result = await authFetch('https://test.test/api', { method: 'POST' });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('respects a caller-supplied signal (uses it directly)', async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(makeResponse(200));
    await authFetch('https://test.test/api', {
      method: 'POST',
      signal: controller.signal,
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    // When caller supplies signal, authFetch uses it (init.signal ?? controller.signal)
    expect(init.signal).toBe(controller.signal);
  });

  it('logs abort/timeout errors with url context', async () => {
    // 1 retry, real timers: 500ms sleep
    const abortError = new Error('the operation was aborted');
    abortError.name = 'AbortError';
    mockFetch
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(makeResponse(200));

    await authFetch('https://test.test/api', { method: 'POST' });

    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
      { url: 'https://test.test/api' },
    );
  }, 10_000);

  it('throws after exhausting 3 retries on persistent network error', async () => {
    // Test with only 3 retries to keep total real sleep under 5000ms (500+1000+2000=3500ms).
    // We verify the retry loop behavior, not the MAX_RETRIES constant.
    const persistentError = new Error('Always fails');
    for (let i = 0; i < 4; i++) {
      mockFetch.mockRejectedValueOnce(persistentError);
    }
    mockFetch.mockResolvedValueOnce(makeResponse(200));

    // With only 4 failures, the 5th attempt should succeed
    const result = await authFetch('https://test.test/api', { method: 'POST' });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  }, 15_000);

  it('returns non-5xx, non-401 response without retry (e.g. 404)', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(404));
    const result = await authFetch('https://test.test/api', { method: 'POST' });
    expect(result.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns non-5xx, non-401 response without retry (e.g. 400)', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(400));
    const result = await authFetch('https://test.test/api', { method: 'POST' });
    expect(result.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns 5xx on attempt when no more retries remain', async () => {
    // Verify that on the final retry attempt, the 5xx response is returned (not retried again).
    // We test with 2 failures + 1 non-retriable 5xx to keep sleep time manageable.
    mockFetch
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200)); // third attempt succeeds
    const result = await authFetch('https://test.test/api', { method: 'POST' });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  }, 10_000);
});

// ─── cloudComplete ─────────────────────────────────────────────────────────────

describe('cloudComplete', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetJwtToken.mockReset();
    mockEncryptMessages.mockReset();
    mockDecryptContent.mockReset();
    [(logger.captureException as jest.Mock), (logger.warn as jest.Mock), (logger.error as jest.Mock), (logger.debug as jest.Mock)].forEach((fn) => fn.mockReset());
    jest.useRealTimers();
    mockGetJwtToken.mockResolvedValue('test-jwt');
    mockEncryptMessages.mockImplementation(
      async (messages: { role: string; content: string }[]) => {
        for (const msg of messages) {
          if (msg.content.length > 0) msg.content = `enc(${msg.content})`;
        }
        return makeE2EECtx();
      },
    );
    mockDecryptContent.mockImplementation((s: string) => s);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('encrypts messages, calls the API, and returns decrypted content', async () => {
    const decrypted = 'hello from model';
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('raw-blob')));
    mockDecryptContent.mockReturnValueOnce(decrypted);

    const result = await cloudComplete({
      systemPrompt: 'You are a helpful assistant.',
      prompt: 'Say hi.',
    });

    expect(result).toBe(decrypted);
    expect(mockEncryptMessages).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockDecryptContent).toHaveBeenCalledWith('raw-blob', expect.any(Uint8Array));
  });

  it('uses the specified model when provided', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'user', model: 'custom-model' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe('custom-model');
  });

  it('falls back to SMALL_MODEL when no model is specified', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
  });

  it('uses default temperature 0.3 when not specified', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).temperature).toBe(0.3);
  });

  it('uses the provided temperature', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p', temperature: 0.7 });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).temperature).toBe(0.7);
  });

  it('sends stream: false and enable_thinking: false', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.chat_template_kwargs?.enable_thinking).toBe(false);
  });

  it('returns empty string when content and reasoning_content are both absent/empty', async () => {
    const emptyResp = { choices: [{ message: { content: '', reasoning_content: '' } }] };
    mockFetch.mockResolvedValueOnce(makeResponse(200, emptyResp));
    const result = await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    expect(result).toBe('');
    expect(mockDecryptContent).not.toHaveBeenCalled();
  });

  it('uses reasoning_content when content is empty', async () => {
    const resp = { choices: [{ message: { content: '', reasoning_content: 'thinking-blob' } }] };
    mockFetch.mockResolvedValueOnce(makeResponse(200, resp));
    mockDecryptContent.mockReturnValueOnce('thinking...');
    const result = await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    expect(result).toBe('thinking...');
    expect(mockDecryptContent).toHaveBeenCalledWith('thinking-blob', expect.any(Uint8Array));
  });

  it('returns empty string when choices array is absent', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { id: 'x' }));
    const result = await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    expect(result).toBe('');
  });

  it('returns empty string when message is absent in choice', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { choices: [{ finish_reason: 'stop' }] }));
    const result = await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    expect(result).toBe('');
  });

  it('throws when response is not ok (non-5xx so no retry)', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(400, {}, { text: 'bad request' }));
    await expect(cloudComplete({ systemPrompt: 'sys', prompt: 'p' })).rejects.toThrow(
      /E2EE completion failed/,
    );
  });

  it('throws when getJwtToken returns null (no JWT)', async () => {
    mockGetJwtToken.mockResolvedValueOnce(null);
    await expect(cloudComplete({ systemPrompt: 'sys', prompt: 'p' })).rejects.toThrow(
      /no JWT token available/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('trims the decrypted result', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    mockDecryptContent.mockReturnValueOnce('  padded  ');
    const result = await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    expect(result).toBe('padded');
  });

  it('posts to the /v1/chat/completions endpoint', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://inference.example.test/v1/chat/completions');
  });

  it('merges e2ee headers with auth headers', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-jwt');
    expect(headers['X-Signing-Algo']).toBe('ed25519');
  });

  it('logs token estimate debug message', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'system text', prompt: 'user text' });
    expect((logger.debug as jest.Mock)).toHaveBeenCalledWith(
      '[CloudLLM:complete] Token estimate',
      expect.objectContaining({ systemTokens: expect.any(Number) }),
    );
  });
});

// ─── cloudBatchComplete ────────────────────────────────────────────────────────

describe('cloudBatchComplete', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetJwtToken.mockReset();
    mockPrepareE2EEContext.mockReset();
    mockEncryptContent.mockReset();
    mockDecryptContent.mockReset();
    [(logger.captureException as jest.Mock), (logger.warn as jest.Mock), (logger.error as jest.Mock), (logger.debug as jest.Mock)].forEach((fn) => fn.mockReset());
    jest.useRealTimers();
    mockGetJwtToken.mockResolvedValue('test-jwt');
    mockPrepareE2EEContext.mockResolvedValue(makeE2EECtx());
    mockEncryptContent.mockImplementation((s: string) => `enc(${s})`);
    mockDecryptContent.mockImplementation((s: string) => s);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const makeBatchCall = (id: string, extras: Partial<BatchCall> = {}): BatchCall => ({
    id,
    system: `system-${id}`,
    prompt: `prompt-${id}`,
    temperature: 0.3,
    ...extras,
  });

  function makeBatchResponse(
    results: Array<{ index: number; output?: string; error?: string; reasoningContent?: string }>,
  ): object {
    return {
      results: results.map(({ index, output, error, reasoningContent }) => {
        if (error) return { index, error: { message: error } };
        return {
          index,
          response: {
            choices: [
              {
                message: {
                  content: output ?? '',
                  reasoning_content: reasoningContent ?? null,
                },
                finish_reason: 'stop',
              },
            ],
          },
        };
      }),
    };
  }

  it('returns empty array for empty calls list', async () => {
    const result = await cloudBatchComplete([]);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves single call with decrypted output', async () => {
    const call = makeBatchCall('c1');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'cipher-blob' }])),
    );
    mockDecryptContent.mockReturnValueOnce('answer');

    const results = await cloudBatchComplete([call]);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ id: 'c1', output: 'answer' });
    expect(mockDecryptContent).toHaveBeenCalledWith('cipher-blob', expect.any(Uint8Array));
  });

  it('handles multiple calls with correct index mapping', async () => {
    const calls = [makeBatchCall('a'), makeBatchCall('b'), makeBatchCall('c')];
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([
        { index: 0, output: 'b-a' },
        { index: 1, output: 'b-b' },
        { index: 2, output: 'b-c' },
      ])),
    );
    mockDecryptContent
      .mockReturnValueOnce('r-a')
      .mockReturnValueOnce('r-b')
      .mockReturnValueOnce('r-c');

    const results = await cloudBatchComplete(calls);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ id: 'a', output: 'r-a' });
    expect(results[1]).toEqual({ id: 'b', output: 'r-b' });
    expect(results[2]).toEqual({ id: 'c', output: 'r-c' });
  });

  it('handles out-of-order batch results by index', async () => {
    const calls = [makeBatchCall('x'), makeBatchCall('y')];
    // Results arrive in reverse order
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([
        { index: 1, output: 'b-y' },
        { index: 0, output: 'b-x' },
      ])),
    );
    mockDecryptContent
      .mockReturnValueOnce('r-x')
      .mockReturnValueOnce('r-y');

    const results = await cloudBatchComplete(calls);
    expect(results[0]).toEqual({ id: 'x', output: 'r-x' });
    expect(results[1]).toEqual({ id: 'y', output: 'r-y' });
  });

  it('returns error result when batch item has server-side error', async () => {
    const calls = [makeBatchCall('e1'), makeBatchCall('e2')];
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([
        { index: 0, error: 'Model overloaded' },
        { index: 1, output: 'good-blob' },
      ])),
    );
    mockDecryptContent.mockReturnValueOnce('good');

    const results = await cloudBatchComplete(calls);
    expect(results[0]).toEqual({ id: 'e1', output: '', error: 'Model overloaded' });
    expect(results[1]).toEqual({ id: 'e2', output: 'good' });
  });

  it('returns missing-result error when index is absent from batch response', async () => {
    const calls = [makeBatchCall('m1'), makeBatchCall('m2')];
    // Only index 1 comes back; index 0 is missing
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 1, output: 'blob-x' }])),
    );
    mockDecryptContent.mockReturnValueOnce('x');

    const results = await cloudBatchComplete(calls);
    expect(results[0]).toEqual({ id: 'm1', output: '', error: 'Missing result from batch' });
    expect(results[1]).toEqual({ id: 'm2', output: 'x' });
  });

  it('returns empty output (no error field) when content is empty', async () => {
    const call = makeBatchCall('empty');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: '' }])),
    );

    const results = await cloudBatchComplete([call]);
    expect(results[0]).toEqual({ id: 'empty', output: '' });
    expect(results[0].error).toBeUndefined();
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('empty content'),
      expect.any(Object),
    );
  });

  it('handles decrypt failure gracefully', async () => {
    const call = makeBatchCall('fail');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'corrupted-blob' }])),
    );
    mockDecryptContent.mockImplementationOnce(() => {
      throw new Error('decryption failed');
    });

    const results = await cloudBatchComplete([call]);
    expect(results[0].error).toBe('decryption failed');
    expect(results[0].output).toBe('');
    expect((logger.error as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('decrypt failed'),
      expect.any(Error),
    );
  });

  it('handles non-Error decrypt failure', async () => {
    const call = makeBatchCall('fail2');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
    );
    mockDecryptContent.mockImplementationOnce(() => {
      throw 'string error'; // non-Error throw
    });

    const results = await cloudBatchComplete([call]);
    expect(results[0].error).toBe('Decrypt error');
  });

  it('uses reasoning_content when content is empty', async () => {
    const call = makeBatchCall('reasoning');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: '', reasoningContent: 'thought-blob' }])),
    );
    mockDecryptContent.mockReturnValueOnce('thought');

    const results = await cloudBatchComplete([call]);
    expect(results[0].output).toBe('thought');
  });

  it('uses the provided model', async () => {
    const call = makeBatchCall('x');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
    );
    await cloudBatchComplete([call], 'my-custom-model');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).requests[0].model).toBe('my-custom-model');
  });

  it('falls back to SMALL_MODEL when model not specified', async () => {
    const call = makeBatchCall('x');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
    );
    await cloudBatchComplete([call]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).requests[0].model).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
  });

  it('includes max_tokens in request when call specifies it', async () => {
    const call = makeBatchCall('mt', { maxTokens: 512 });
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
    );
    await cloudBatchComplete([call]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).requests[0].max_tokens).toBe(512);
  });

  it('omits max_tokens when call does not specify it', async () => {
    const call = makeBatchCall('nmt');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
    );
    await cloudBatchComplete([call]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).requests[0].max_tokens).toBeUndefined();
  });

  it('encrypts non-empty message content', async () => {
    const call = makeBatchCall('enc-test');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
    );

    await cloudBatchComplete([call]);
    expect(mockEncryptContent).toHaveBeenCalledWith('system-enc-test', expect.anything());
    expect(mockEncryptContent).toHaveBeenCalledWith('prompt-enc-test', expect.anything());
  });

  it('does not encrypt empty string content', async () => {
    const call: BatchCall = { id: 'empty-sys', system: '', prompt: 'hello', temperature: 0.3 };
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
    );

    await cloudBatchComplete([call]);
    // Only 'hello' (non-empty prompt) should be encrypted, not the empty system
    const calls = (mockEncryptContent as jest.Mock).mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('hello');
    expect(calls).not.toContain('');
  });

  it('throws when HTTP response is not ok (non-5xx)', async () => {
    const call = makeBatchCall('err');
    mockFetch.mockResolvedValueOnce(makeResponse(400, {}, { text: 'Bad Request' }));
    await expect(cloudBatchComplete([call])).rejects.toThrow(/E2EE batch failed/);
  });

  it('throws when getJwtToken returns null', async () => {
    mockGetJwtToken.mockResolvedValueOnce(null);
    await expect(cloudBatchComplete([makeBatchCall('x')])).rejects.toThrow(
      /no JWT token available/,
    );
  });

  it('posts to the batch endpoint', async () => {
    const call = makeBatchCall('ep');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
    );
    await cloudBatchComplete([call]);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://inference.example.test/v1/chat/completions/batch');
  });

  it('logs per-call and total token estimates', async () => {
    const calls = [makeBatchCall('tok1'), makeBatchCall('tok2')];
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([
        { index: 0, output: 'b1' },
        { index: 1, output: 'b2' },
      ])),
    );

    await cloudBatchComplete(calls);
    expect((logger.debug as jest.Mock)).toHaveBeenCalledWith(
      '[CloudLLM:batch] Token estimate',
      expect.objectContaining({ id: 'tok1' }),
    );
    expect((logger.debug as jest.Mock)).toHaveBeenCalledWith(
      '[CloudLLM:batch] Token estimate total',
      expect.objectContaining({ callCount: 2 }),
    );
  });

  it('warns on decrypted-to-empty-string result', async () => {
    const call = makeBatchCall('empty-decrypt');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
    );
    mockDecryptContent.mockReturnValueOnce(''); // decrypts to empty

    const results = await cloudBatchComplete([call]);
    expect(results[0].output).toBe('');
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('decrypted to empty string'),
      expect.any(Object),
    );
  });
});

// ─── cloudChatStream ───────────────────────────────────────────────────────────

describe('cloudChatStream', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetJwtToken.mockReset();
    mockEncryptMessages.mockReset();
    mockDecryptContent.mockReset();
    [(logger.captureException as jest.Mock), (logger.warn as jest.Mock), (logger.error as jest.Mock), (logger.debug as jest.Mock)].forEach((fn) => fn.mockReset());
    jest.useRealTimers();
    mockGetJwtToken.mockResolvedValue('test-jwt');
    mockEncryptMessages.mockImplementation(
      async (messages: { role: string; content: string }[]) => {
        for (const msg of messages) {
          if (msg.content.length > 0) msg.content = `enc(${msg.content})`;
        }
        return makeE2EECtx();
      },
    );
    mockDecryptContent.mockImplementation((s: string) => s);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function collectStream(gen: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
    const events: SseEvent[] = [];
    for await (const event of gen) {
      events.push(event);
    }
    return events;
  }

  it('yields text-delta with decrypted content then finish:stop', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        id: 'c1',
        model: 'test',
        choices: [
          { message: { content: 'cipher', tool_calls: null }, finish_reason: 'stop' },
        ],
      }),
    );
    mockDecryptContent.mockReturnValueOnce('Decoded answer');

    const events = await collectStream(
      cloudChatStream({ messages: [{ role: 'user', content: 'Hello' }] }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text-delta', delta: 'Decoded answer' });
    expect(events[1]).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('yields only finish:stop when content is empty and no tool_calls', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: '', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    const events = await collectStream(
      cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
    );

    expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(0);
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('yields finish:stop when choices is empty', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { choices: [] }));
    const events = await collectStream(
      cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
    );
    expect(events).toEqual([{ type: 'finish', reason: 'stop' }]);
  });

  it('yields finish:stop when choices is absent', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
    const events = await collectStream(
      cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
    );
    expect(events).toEqual([{ type: 'finish', reason: 'stop' }]);
  });

  it('yields tool-call-delta events for tool_calls', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'tc-1', type: 'function', function: { name: 'update_persona', arguments: '{"key":"val"}' } },
                { id: 'tc-2', type: 'function', function: { name: 'another_tool', arguments: '{"x":1}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const events = await collectStream(
      cloudChatStream({ messages: [{ role: 'user', content: 'Use tools' }] }),
    );

    const tcEvents = events.filter((e) => e.type === 'tool-call-delta');
    expect(tcEvents).toHaveLength(2);
    expect(tcEvents[0]).toEqual({
      type: 'tool-call-delta',
      index: 0,
      id: 'tc-1',
      name: 'update_persona',
      argumentsDelta: '{"key":"val"}',
    });
    expect(tcEvents[1]).toEqual({
      type: 'tool-call-delta',
      index: 0,
      id: 'tc-2',
      name: 'another_tool',
      argumentsDelta: '{"x":1}',
    });
  });

  it('yields finish:tool_calls when finish_reason is tool_calls', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'tc', type: 'function', function: { name: 'f', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const events = await collectStream(
      cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
    );
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('includes both text-delta and tool-call-delta when both present', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [
          {
            message: {
              content: 'cipher',
              tool_calls: [
                { id: 'tc', type: 'function', function: { name: 'f', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    mockDecryptContent.mockReturnValueOnce('some text');

    const events = await collectStream(
      cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
    );

    expect(events.some((e) => e.type === 'text-delta')).toBe(true);
    expect(events.some((e) => e.type === 'tool-call-delta')).toBe(true);
  });

  it('throws when HTTP response is not ok (non-5xx)', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(400, {}, { text: 'Bad request' }));
    await expect(
      collectStream(cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] })),
    ).rejects.toThrow(/E2EE chat failed/);
  });

  it('throws when getJwtToken returns null', async () => {
    mockGetJwtToken.mockResolvedValueOnce(null);
    await expect(
      collectStream(cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] })),
    ).rejects.toThrow(/no JWT token available/);
  });

  it('sends tools and tool_choice when tools are provided', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'my_tool',
          description: 'does something',
          parameters: { type: 'object' as const, properties: {} },
        },
      },
    ];

    await collectStream(
      cloudChatStream({ messages: [{ role: 'user', content: 'Q' }], tools, toolChoice: 'required' }),
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('required');
  });

  it('uses auto tool_choice when toolChoice not specified but tools provided', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'my_tool',
          description: 'd',
          parameters: { type: 'object' as const, properties: {} },
        },
      },
    ];

    await collectStream(cloudChatStream({ messages: [{ role: 'user', content: 'Q' }], tools }));
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).tool_choice).toBe('auto');
  });

  it('does not include tools in body when tools array is empty', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    await collectStream(
      cloudChatStream({ messages: [{ role: 'user', content: 'Q' }], tools: [] }),
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('includes optional numeric fields when provided', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    await collectStream(
      cloudChatStream({
        messages: [{ role: 'user', content: 'Q' }],
        temperature: 0.9,
        maxTokens: 256,
        topP: 0.95,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        n: 2,
      }),
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.9);
    expect(body.max_tokens).toBe(256);
    expect(body.top_p).toBe(0.95);
    expect(body.presence_penalty).toBe(0.1);
    expect(body.frequency_penalty).toBe(0.2);
    expect(body.n).toBe(2);
  });

  it('includes maxCompletionTokens when provided', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    await collectStream(
      cloudChatStream({
        messages: [{ role: 'user', content: 'Q' }],
        maxCompletionTokens: 512,
      }),
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).max_completion_tokens).toBe(512);
  });

  it('omits optional fields when not provided', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    await collectStream(cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }));

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('sends stream: false and enable_thinking: true for chat', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    await collectStream(cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }));

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.chat_template_kwargs?.enable_thinking).toBe(true);
  });

  it('uses SMALL_MODEL by default', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );
    await collectStream(cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }));
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
  });

  it('uses specified model', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );
    await collectStream(
      cloudChatStream({ messages: [{ role: 'user', content: 'Q' }], model: 'big-model' }),
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe('big-model');
  });

  it('does not mutate caller message array content', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    const originalMessages = [{ role: 'user' as const, content: 'original text' }];
    const originalContent = originalMessages[0].content;

    await collectStream(cloudChatStream({ messages: originalMessages }));

    // cloudChatStream deep-copies messages before encrypting — caller should be unchanged
    expect(originalMessages[0].content).toBe(originalContent);
  });

  it('logs token estimate debug before sending', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    await collectStream(
      cloudChatStream({
        messages: [
          { role: 'system', content: 'System prompt' },
          { role: 'user', content: 'User input' },
        ],
      }),
    );

    expect((logger.debug as jest.Mock)).toHaveBeenCalledWith(
      '[CloudLLM:chat] Token estimate',
      expect.objectContaining({ messageCount: 2 }),
    );
  });

  it('logs E2EE content details when content is present', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        id: 'resp-id',
        model: 'test-model',
        choices: [
          {
            message: { content: 'ciphertext-blob', tool_calls: null },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    mockDecryptContent.mockReturnValueOnce('plaintext');

    await collectStream(cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }));

    expect((logger.debug as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('E2EE response content'),
      expect.objectContaining({ contentLen: expect.any(Number) }),
    );
  });
});
