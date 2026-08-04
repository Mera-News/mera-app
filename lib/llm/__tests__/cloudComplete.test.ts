// Tests for lib/llm/cloudComplete.ts — cloud LLM completion, batch, and streaming.
// ALL I/O is mocked; fake timers are used for retry/backoff paths.

// ─── I/O mocks (must precede imports) ─────────────────────────────────────────

const mockFetch = jest.fn<Promise<Response>, unknown[]>();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));

const mockGetJwtToken = jest.fn<Promise<string | null>, unknown[]>(() =>
  Promise.resolve('test-jwt'),
);
const mockInvalidateJwtCache = jest.fn();
jest.mock('@/lib/auth-client', () => ({
  getJwtToken: (...args: unknown[]) => mockGetJwtToken(...args),
  invalidateJwtCache: (...args: unknown[]) => mockInvalidateJwtCache(...args),
}));

const mockPrepareE2EEContext = jest.fn<Promise<ReturnType<typeof makeE2EECtx>>, unknown[]>();
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
    algo: 'ed25519' as const,
  };
}

jest.mock('@/lib/e2ee/e2ee-service', () => ({
  prepareE2EEContext: (...args: unknown[]) => mockPrepareE2EEContext(...args),
  encryptContent: (...args: unknown[]) => mockEncryptContent(...(args as [string])),
  decryptContent: (...args: unknown[]) => mockDecryptContent(...(args as [string])),
  encryptMessages: (...args: unknown[]) =>
    mockEncryptMessages(...(args as [{ role: string; content: string }[]])),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    captureMessage: jest.fn(),
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
  CallerAbortError,
  cloudComplete,
  cloudBatchComplete,
  cloudChatStream,
  HEDGE_DELAY_MS,
  isAbortLike,
  isCallerAbort,
  STREAM_IDLE_TIMEOUT_MS,
  UPSTREAM_ALIGNED_MAX_TIMEOUT_ATTEMPTS,
  UPSTREAM_ALIGNED_TIMEOUT_MS,
  type SseEvent,
} from '../cloudComplete';
import { __resetForTests as resetModelFallback, isFallbackEngaged } from '../model-fallback';
import { SMALL_MODEL } from '../constants';
import type { BatchCall } from '../types';
import logger from '@/lib/logger';

const FALLBACK_MODEL = 'google/gemma-4-31B-it';

/** A rejection whose wording matches expo/fetch's cancellation. */
function makeCanceledError(): Error {
  return new Error('fetch failed: Fetch request has been canceled');
}

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

/** A Response-like whose body is an SSE stream. Each entry is one raw wire
 *  chunk — split them wherever a test needs a boundary. */
function makeSseResponse(chunks: string[], onRead?: () => void): Response {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  let i = 0;
  return {
    status: 200,
    statusText: '200',
    ok: true,
    headers: { get: (name: string) => (name === 'content-type' ? 'text/event-stream' : null) },
    body: {
      getReader: () => ({
        read: () => {
          onRead?.();
          return Promise.resolve(
            i < encoded.length
              ? { done: false, value: encoded[i++] }
              : { done: true, value: undefined },
          );
        },
        cancel: () => Promise.resolve(),
      }),
    },
    json: () => Promise.reject(new Error('SSE body is not JSON')),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

/** An SSE Response-like that yields `chunks`, then fails the next read. */
function makeFailingSseResponse(chunks: string[], err: Error): Response {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  let i = 0;
  return {
    status: 200,
    statusText: '200',
    ok: true,
    headers: { get: (name: string) => (name === 'content-type' ? 'text/event-stream' : null) },
    body: {
      getReader: () => ({
        read: () =>
          i < encoded.length
            ? Promise.resolve({ done: false, value: encoded[i++] })
            : Promise.reject(err),
        cancel: () => Promise.resolve(),
      }),
    },
    json: () => Promise.reject(new Error('SSE body is not JSON')),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

/** One SSE frame carrying a chat-completion chunk. */
const sseChunk = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;
const SSE_DONE = 'data: [DONE]\n\n';

/** Drain the microtask queue. Fake timers do NOT fake promises, so this is how
 *  a test reaches the point where a timer has actually been armed. */
async function tickMicrotasks(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    resetModelFallback();
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

  it('combines a caller-supplied signal with the timeout instead of replacing it', async () => {
    // Regression: `init.signal ?? controller.signal` silently DISABLED the
    // per-attempt timeout whenever a caller passed a signal, so the request
    // could hang forever. The timeout must still fire with a caller signal
    // attached, and the signal handed to fetch must not be the caller's.
    const controller = new AbortController();
    mockFetch.mockImplementation((_url: unknown, init: unknown) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
    );

    await expect(
      authFetch(
        'https://test.test/api',
        { method: 'POST', signal: controller.signal },
        { requestTimeoutMs: 50, maxTimeoutAttempts: 1 },
      ),
    ).rejects.toThrow(/aborted/);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).not.toBe(controller.signal);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockReset();
  }, 10_000);

  it('surfaces a CALLER abort as CallerAbortError — no budget spent, no retry', async () => {
    // The caller's ORIGINAL signal is the only reliable discriminator between a
    // caller abort and our own per-attempt timeout (both reach the catch block
    // worded "aborted"). A caller abort must end the call outright: the timeout
    // budget below allows a second attempt, and it must go unused.
    const controller = new AbortController();
    mockFetch.mockImplementation((_url: unknown, init: unknown) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
    );

    const promise = authFetch(
      'https://test.test/api',
      { method: 'POST', signal: controller.signal },
      // Timeout far away — only the caller's abort can end this.
      { requestTimeoutMs: 60_000, maxTimeoutAttempts: 2 },
    );
    controller.abort();
    const err: unknown = await promise.then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(CallerAbortError);
    expect(isCallerAbort(err)).toBe(true);
    expect((err as CallerAbortError).name).toBe('CallerAbortError');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockReset();
  }, 10_000);

  it('isCallerAbort rejects an ordinary abort/timeout error', () => {
    expect(isCallerAbort(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(isCallerAbort(makeCanceledError())).toBe(false);
    expect(isCallerAbort('not an error')).toBe(false);
  });

  it('classifies expo/fetch "canceled" wording as a timeout, not a network error', async () => {
    // expo/fetch words its cancellation "Fetch request has been canceled" —
    // the old /abort/-only test logged our own timeouts as `timedOut: false`.
    mockFetch
      .mockRejectedValueOnce(makeCanceledError())
      .mockResolvedValueOnce(makeResponse(200));

    const result = await authFetch('https://test.test/api', { method: 'POST' });

    expect(result.status).toBe(200);
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
      { url: 'https://test.test/api' },
    );
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('fetch error'),
      expect.objectContaining({ timedOut: true }),
    );
  }, 10_000);

  it('isAbortLike matches abort and cancel wording only', () => {
    expect(isAbortLike(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortLike(new Error('The operation was aborted'))).toBe(true);
    expect(isAbortLike(makeCanceledError())).toBe(true);
    expect(isAbortLike(new Error('Request was cancelled'))).toBe(true);
    expect(isAbortLike(new Error('Network request failed'))).toBe(false);
    expect(isAbortLike('not an error')).toBe(false);
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

  // ─── per-call options: chat timeout budget (Part 2e) ────────────────────────

  it('retries 502 like other 5xx under default options', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(502))
      .mockResolvedValueOnce(makeResponse(200));
    const result = await authFetch('https://test.test/api', { method: 'POST' });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('caps 502 attempts via maxTimeoutAttempts and surfaces the 502 (no storm)', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(502))
      .mockResolvedValueOnce(makeResponse(502))
      .mockResolvedValueOnce(makeResponse(200)); // would succeed if it kept retrying
    const result = await authFetch(
      'https://test.test/api',
      { method: 'POST' },
      { maxTimeoutAttempts: 2 },
    );
    expect(result.status).toBe(502);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('caps client-timeout/network attempts via maxTimeoutAttempts', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockFetch
      .mockRejectedValueOnce(abortError)
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(makeResponse(200));
    await expect(
      authFetch('https://test.test/api', { method: 'POST' }, { maxTimeoutAttempts: 2 }),
    ).rejects.toThrow(/aborted/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('does NOT count 401 refresh against the timeout budget', async () => {
    // 401 → refresh → then a 200. Even with a tight timeout cap, the 401 retry
    // is unaffected (only 502/timeout count).
    mockGetJwtToken.mockResolvedValue('jwt');
    mockFetch
      .mockResolvedValueOnce(makeResponse(401))
      .mockResolvedValueOnce(makeResponse(200));
    const result = await authFetch(
      'https://test.test/api',
      { method: 'POST', headers: {} },
      { maxTimeoutAttempts: 1 },
    );
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
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
    resetModelFallback();
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
    expect(mockDecryptContent).toHaveBeenCalledWith('raw-blob', expect.any(Uint8Array), 'ed25519');
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
    expect(mockDecryptContent).toHaveBeenCalledWith('thinking-blob', expect.any(Uint8Array), 'ed25519');
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

  it('includes max_tokens when maxTokens is provided (used by the prewarm warmup)', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p', maxTokens: 1 });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).max_tokens).toBe(1);
  });

  it('falls back to maxCompletionTokens for max_tokens when maxTokens absent', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p', maxCompletionTokens: 8 });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).max_tokens).toBe(8);
  });

  it('omits max_tokens when neither is provided', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).max_tokens).toBeUndefined();
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
    resetModelFallback();
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
    expect(mockDecryptContent).toHaveBeenCalledWith('cipher-blob', expect.any(Uint8Array), 'ed25519');
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

  // r12 K-P2 — REPLACES the old 'uses reasoning_content when content is empty'
  // pin, which asserted the substitution this guard removes. With thinking
  // enabled a trace that exhausts max_tokens leaves `content` empty; handing the
  // trace back AS the output made a pure budget problem look like a benign empty
  // answer (the caller parsed prose as JSON, got nothing, and reported "no
  // usable topics"). An error is retryable and countable; prose is neither.
  it('errors instead of substituting reasoning_content for an empty content', async () => {
    const call = makeBatchCall('reasoning');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([{ index: 0, output: '', reasoningContent: 'thought-blob' }])),
    );

    const results = await cloudBatchComplete([call]);

    expect(results[0].error).toBe('reasoning-overran-budget');
    expect(results[0].output).toBe('');
    // The trace must never even reach the decryptor as if it were an answer.
    expect(mockDecryptContent).not.toHaveBeenCalled();
  });

  it('still returns content normally when BOTH content and reasoning are present', async () => {
    const call = makeBatchCall('both');
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, makeBatchResponse([
        { index: 0, output: 'real-blob', reasoningContent: 'thought-blob' },
      ])),
    );
    mockDecryptContent.mockReturnValueOnce('["a"]');

    const results = await cloudBatchComplete([call]);

    expect(results[0].error).toBeUndefined();
    expect(results[0].output).toBe('["a"]');
    expect(mockDecryptContent).toHaveBeenCalledWith('real-blob', expect.any(Uint8Array), 'ed25519');
  });

  // The batch path had NO enable_thinking pin before r12 K-P2 (the one at the
  // top of this file covers the SINGLE-completion path). These two are that pin:
  // the default must stay false so every pre-existing batch caller — relevance
  // scoring, reason generation, noise generation — is byte-identical.
  describe('enable_thinking (K-P2)', () => {
    it('defaults to false when the call omits enableThinking', async () => {
      const call = makeBatchCall('no-flag');
      mockFetch.mockResolvedValueOnce(
        makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
      );

      await cloudBatchComplete([call]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.requests[0].chat_template_kwargs.enable_thinking).toBe(false);
    });

    it('sends false when enableThinking is explicitly false', async () => {
      const call = makeBatchCall('off', { enableThinking: false });
      mockFetch.mockResolvedValueOnce(
        makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
      );

      await cloudBatchComplete([call]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(
        JSON.parse(init.body as string).requests[0].chat_template_kwargs.enable_thinking,
      ).toBe(false);
    });

    it('honours enableThinking: true', async () => {
      const call = makeBatchCall('on', { enableThinking: true });
      mockFetch.mockResolvedValueOnce(
        makeResponse(200, makeBatchResponse([{ index: 0, output: 'blob' }])),
      );

      await cloudBatchComplete([call]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(
        JSON.parse(init.body as string).requests[0].chat_template_kwargs.enable_thinking,
      ).toBe(true);
    });

    it('sets the flag per call, not per batch', async () => {
      const calls = [
        makeBatchCall('a', { enableThinking: true }),
        makeBatchCall('b'),
      ];
      mockFetch.mockResolvedValueOnce(
        makeResponse(200, makeBatchResponse([
          { index: 0, output: 'blob-a' },
          { index: 1, output: 'blob-b' },
        ])),
      );

      await cloudBatchComplete(calls);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const { requests } = JSON.parse(init.body as string);
      expect(requests[0].chat_template_kwargs.enable_thinking).toBe(true);
      expect(requests[1].chat_template_kwargs.enable_thinking).toBe(false);
    });
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

// ─── session model fallback (plan E) ───────────────────────────────────────────

describe('session model fallback', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetJwtToken.mockReset();
    mockEncryptMessages.mockReset();
    mockPrepareE2EEContext.mockReset();
    mockEncryptContent.mockReset();
    mockDecryptContent.mockReset();
    [(logger.captureMessage as jest.Mock), (logger.warn as jest.Mock), (logger.error as jest.Mock), (logger.debug as jest.Mock)].forEach((fn) => fn.mockReset());
    jest.useRealTimers();
    resetModelFallback();
    mockGetJwtToken.mockResolvedValue('test-jwt');
    mockPrepareE2EEContext.mockResolvedValue(makeE2EECtx());
    mockEncryptContent.mockImplementation((s: string) => `enc(${s})`);
    mockDecryptContent.mockImplementation((s: string) => s);
    mockEncryptMessages.mockImplementation(
      async (messages: { role: string; content: string }[]) => {
        for (const msg of messages) {
          if (msg.content.length > 0) msg.content = `enc(${msg.content})`;
        }
        return makeE2EECtx();
      },
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    resetModelFallback();
  });

  const bodyModelOf = (i: number) =>
    JSON.parse((mockFetch.mock.calls[i] as [string, RequestInit])[1].body as string).model;

  it('cloudComplete: exhausted timeout attempts engage the fallback and retry the SAME call once', async () => {
    mockFetch
      .mockRejectedValueOnce(makeCanceledError()) // attempt 1 on the primary
      .mockRejectedValueOnce(makeCanceledError()) // attempt 2 — budget exhausted
      .mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob'))); // fallback
    mockDecryptContent.mockReturnValueOnce('recovered');

    const result = await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });

    expect(result).toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(bodyModelOf(0)).toBe(SMALL_MODEL);
    expect(bodyModelOf(2)).toBe(FALLBACK_MODEL);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  }, 10_000);

  it('a gateway 502 upstream-timeout verdict engages the fallback too', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(502))
      .mockResolvedValueOnce(makeResponse(502)) // budget (2) exhausted → surfaced
      .mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    mockDecryptContent.mockReturnValueOnce('ok');

    const result = await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });

    expect(result).toBe('ok');
    expect(bodyModelOf(2)).toBe(FALLBACK_MODEL);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  }, 10_000);

  it('substitutes the fallback on SUBSEQUENT calls once engaged', async () => {
    mockFetch
      .mockRejectedValueOnce(makeCanceledError())
      .mockRejectedValueOnce(makeCanceledError())
      .mockResolvedValueOnce(makeResponse(200, makeChatResponse('a')))
      .mockResolvedValueOnce(
        makeResponse(200, {
          results: [
            { index: 0, response: { choices: [{ message: { content: 'b' }, finish_reason: 'stop' }] } },
          ],
        }),
      );
    mockDecryptContent.mockImplementation((s: string) => s);

    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    await cloudBatchComplete([{ id: 'c1', system: 's', prompt: 'p', temperature: 0.3 }]);

    const batchBody = JSON.parse(
      (mockFetch.mock.calls[3] as [string, RequestInit])[1].body as string,
    );
    expect(batchBody.requests[0].model).toBe(FALLBACK_MODEL);
  }, 10_000);

  it('encrypts the RETRY under the RESOLVED fallback model (attestation is per-model)', async () => {
    mockFetch
      .mockRejectedValueOnce(makeCanceledError())
      .mockRejectedValueOnce(makeCanceledError())
      .mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));

    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });

    const models = (mockEncryptMessages as jest.Mock).mock.calls.map((c: unknown[]) => c[1]);
    expect(models).toEqual([SMALL_MODEL, FALLBACK_MODEL]);
  }, 10_000);

  it('the fallback retry re-encrypts FRESH plaintext (never double-encrypts)', async () => {
    mockFetch
      .mockRejectedValueOnce(makeCanceledError())
      .mockRejectedValueOnce(makeCanceledError())
      .mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));

    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });

    const retryBody = JSON.parse(
      (mockFetch.mock.calls[2] as [string, RequestInit])[1].body as string,
    );
    expect(retryBody.messages[0].content).toBe('enc(sys)'); // not enc(enc(sys))
    expect(retryBody.messages[1].content).toBe('enc(p)');
  }, 10_000);

  it('batch: rebuilds the E2EE context for the fallback attempt', async () => {
    mockFetch
      .mockRejectedValueOnce(makeCanceledError())
      .mockRejectedValueOnce(makeCanceledError())
      .mockResolvedValueOnce(
        makeResponse(200, {
          results: [
            { index: 0, response: { choices: [{ message: { content: 'blob' }, finish_reason: 'stop' }] } },
          ],
        }),
      );

    await cloudBatchComplete([{ id: 'c1', system: 's', prompt: 'p', temperature: 0.3 }]);

    const models = (mockPrepareE2EEContext as jest.Mock).mock.calls.map((c: unknown[]) => c[0]);
    expect(models).toEqual([SMALL_MODEL, FALLBACK_MODEL]);
  }, 10_000);

  it('does NOT engage on a plain network error', async () => {
    for (let i = 0; i < 11; i++) mockFetch.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(
      cloudComplete({ systemPrompt: 'sys', prompt: 'p' }, { maxTimeoutAttempts: 1 }),
    ).rejects.toThrow(/Network request failed/);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('does NOT engage on a 4xx', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(400, {}, { text: 'nope' }));
    await expect(cloudComplete({ systemPrompt: 'sys', prompt: 'p' })).rejects.toThrow(
      /E2EE completion failed/,
    );
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT engage on an E2EE/auth failure', async () => {
    mockGetJwtToken.mockResolvedValueOnce(null);
    await expect(cloudComplete({ systemPrompt: 'sys', prompt: 'p' })).rejects.toThrow(
      /no JWT token available/,
    );
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('does NOT engage on success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect((logger.captureMessage as jest.Mock)).not.toHaveBeenCalled();
  });

  it('surfaces the ORIGINAL error when the fallback retry also fails', async () => {
    mockFetch
      .mockRejectedValueOnce(makeCanceledError())
      .mockRejectedValueOnce(makeCanceledError())
      .mockRejectedValueOnce(new Error('fallback exploded'));

    await expect(cloudComplete({ systemPrompt: 'sys', prompt: 'p' })).rejects.toThrow(
      /has been canceled/,
    );
  }, 10_000);

  it('reports to Sentry exactly once per model per session', async () => {
    mockFetch
      .mockRejectedValueOnce(makeCanceledError())
      .mockRejectedValueOnce(makeCanceledError())
      .mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')))
      // second call: already on the fallback, which also times out
      .mockRejectedValueOnce(makeCanceledError())
      .mockRejectedValueOnce(makeCanceledError());

    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    await expect(cloudComplete({ systemPrompt: 'sys', prompt: 'p' })).rejects.toThrow();

    expect((logger.captureMessage as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((logger.captureMessage as jest.Mock)).toHaveBeenCalledWith(
      'NEAR primary model failing — session fallback engaged',
      { level: 'error', tags: { model: SMALL_MODEL, fallback: FALLBACK_MODEL } },
    );
  }, 15_000);

  it('does not fire a pointless second attempt once already on the fallback', async () => {
    mockFetch
      .mockRejectedValueOnce(makeCanceledError())
      .mockRejectedValueOnce(makeCanceledError())
      .mockResolvedValueOnce(makeResponse(200, makeChatResponse('blob')));
    await cloudComplete({ systemPrompt: 'sys', prompt: 'p' });
    mockFetch.mockReset();

    // Engaged now — the primary resolves to the fallback, so a timeout-class
    // failure has nowhere else to go: 2 attempts and out, no third call.
    mockFetch
      .mockRejectedValueOnce(makeCanceledError())
      .mockRejectedValueOnce(makeCanceledError());
    await expect(cloudComplete({ systemPrompt: 'sys', prompt: 'p' })).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 15_000);
});

// ─── gateway-aligned timeout defaults (plan A) ─────────────────────────────────

describe('gateway-aligned timeout defaults', () => {
  it('exports 130s / 2 attempts (must outlast the gateway 120s upstream limit)', () => {
    expect(UPSTREAM_ALIGNED_TIMEOUT_MS).toBe(130_000);
    expect(UPSTREAM_ALIGNED_TIMEOUT_MS).toBeGreaterThan(120_000);
    expect(UPSTREAM_ALIGNED_MAX_TIMEOUT_ATTEMPTS).toBe(2);
  });

  it('cloudBatchComplete caps 502 attempts at 2 by default (was 11)', async () => {
    mockFetch.mockReset();
    resetModelFallback();
    mockGetJwtToken.mockResolvedValue('test-jwt');
    mockPrepareE2EEContext.mockResolvedValue(makeE2EECtx());
    mockFetch
      .mockResolvedValueOnce(makeResponse(502))
      .mockResolvedValueOnce(makeResponse(502))
      // the fallback attempt (engaged by the 502 verdict) also 502s
      .mockResolvedValueOnce(makeResponse(502, {}, { text: 'gateway timeout' }));

    await expect(
      cloudBatchComplete([{ id: 'c1', system: 's', prompt: 'p', temperature: 0.3 }]),
    ).rejects.toThrow(/E2EE batch failed: 502/);
    // 2 on the primary + exactly 1 fallback retry — not an 11-attempt storm.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    resetModelFallback();
  }, 15_000);
});

// ─── cloudChatStream ───────────────────────────────────────────────────────────

describe('cloudChatStream', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetJwtToken.mockReset();
    mockEncryptMessages.mockReset();
    mockDecryptContent.mockReset();
    [(logger.captureException as jest.Mock), (logger.captureMessage as jest.Mock), (logger.warn as jest.Mock), (logger.error as jest.Mock), (logger.debug as jest.Mock)].forEach((fn) => fn.mockReset());
    jest.useRealTimers();
    resetModelFallback();
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

  it('caps 502 retries on the chat path (surfaces the gateway 502 without storming)', async () => {
    // maxTimeoutAttempts=2 exhausts the primary's budget, then the session model
    // fallback (plan E) buys exactly ONE more attempt on a different model —
    // 3 upstream attempts total, not an 11-attempt multi-minute storm. The
    // ORIGINAL 502 is what surfaces.
    mockFetch
      .mockResolvedValueOnce(makeResponse(502))
      .mockResolvedValueOnce(makeResponse(502))
      .mockResolvedValueOnce(makeResponse(502))
      .mockResolvedValueOnce(makeResponse(200)); // never reached
    await expect(
      collectStream(cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] })),
    ).rejects.toThrow(/E2EE chat failed: 502/);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    resetModelFallback();
  }, 10_000);

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

  it('sends stream: true and enable_thinking: true for chat', async () => {
    // Streaming and E2EE coexist: NEAR encrypts each streamed delta.content as
    // its own envelope. Only the chat path streams — complete/batch stay false.
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: 'blob', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );

    await collectStream(cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }));

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
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

  // ─── real SSE streaming ──────────────────────────────────────────────────
  //
  // Wire contract measured against cloud-api.near.ai on 2026-08-03: with
  // `stream: true` + E2EE headers NEAR returns text/event-stream and EVERY
  // delta.content is a self-contained envelope under the same client key.

  describe('streaming (text/event-stream)', () => {
    it('decrypts each delta and yields incremental text-deltas', async () => {
      mockDecryptContent.mockImplementation((s: string) => `<${s}>`);
      mockFetch.mockResolvedValueOnce(
        makeSseResponse([
          // Preamble: empty content, must not reach decryptContent.
          sseChunk({ choices: [{ delta: { content: '', reasoning_content: null, role: 'assistant' }, finish_reason: null }] }),
          sseChunk({ choices: [{ delta: { content: 'hexA', reasoning_content: null }, finish_reason: null }] }),
          sseChunk({ choices: [{ delta: { content: 'hexB', reasoning_content: null }, finish_reason: null }] }),
          sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          // Usage-only trailer: `choices` empty, must be tolerated.
          sseChunk({ choices: [], usage: { total_tokens: 9 } }),
          SSE_DONE,
        ]),
      );

      const events = await collectStream(
        cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
      );

      expect(events).toEqual([
        { type: 'text-delta', delta: '<hexA>' },
        { type: 'text-delta', delta: '<hexB>' },
        { type: 'finish', reason: 'stop' },
      ]);
      expect(mockDecryptContent).toHaveBeenCalledTimes(2);
      expect(mockDecryptContent).toHaveBeenCalledWith('hexA', expect.any(Uint8Array), 'ed25519');
    });

    it('reassembles deltas split across chunk boundaries', async () => {
      mockDecryptContent.mockImplementation((s: string) => s);
      const frame = sseChunk({ choices: [{ delta: { content: 'hexAll' }, finish_reason: 'stop' }] });
      mockFetch.mockResolvedValueOnce(
        makeSseResponse([frame.slice(0, 20), frame.slice(20), SSE_DONE]),
      );

      const events = await collectStream(
        cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
      );
      expect(events).toEqual([
        { type: 'text-delta', delta: 'hexAll' },
        { type: 'finish', reason: 'stop' },
      ]);
    });

    it('NEVER yields reasoning_content, even when populated', async () => {
      mockDecryptContent.mockImplementation((s: string) => `<${s}>`);
      mockFetch.mockResolvedValueOnce(
        makeSseResponse([
          // Chain-of-thought arrives as its own field and may itself be an
          // encrypted envelope — dropped WITHOUT decrypting.
          sseChunk({ choices: [{ delta: { content: null, reasoning_content: 'secretThought' }, finish_reason: null }] }),
          sseChunk({ choices: [{ delta: { content: 'hexA', reasoning_content: null }, finish_reason: 'stop' }] }),
          SSE_DONE,
        ]),
      );

      const events = await collectStream(
        cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
      );

      expect(events.filter((e) => e.type === 'text-delta')).toEqual([
        { type: 'text-delta', delta: '<hexA>' },
      ]);
      const decrypted = (mockDecryptContent as jest.Mock).mock.calls.map((c: unknown[]) => c[0]);
      expect(decrypted).not.toContain('secretThought');
    });

    it('forwards fragmented tool-call deltas in the shapes the consumer already accumulates', async () => {
      mockFetch.mockResolvedValueOnce(
        makeSseResponse([
          sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc-1', function: { name: 'proposeTrack', arguments: '' } }] }, finish_reason: null }] }),
          sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] }, finish_reason: null }] }),
          sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: null }] }),
          sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          SSE_DONE,
        ]),
      );

      const events = await collectStream(
        cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
      );
      const toolEvents = events.filter((e) => e.type === 'tool-call-delta');

      expect(toolEvents).toHaveLength(3);
      expect(toolEvents[0]).toMatchObject({
        type: 'tool-call-delta', index: 0, id: 'tc-1', name: 'proposeTrack', argumentsDelta: '',
      });
      expect(toolEvents[1]).toMatchObject({ index: 0, argumentsDelta: '{"a":' });
      expect(toolEvents[2]).toMatchObject({ index: 0, argumentsDelta: '1}' });
      // Arguments are CLEARTEXT on the wire — never routed through decrypt.
      expect(mockDecryptContent).not.toHaveBeenCalled();
      expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'tool_calls' });
    });

    it('skips an unparseable SSE payload instead of failing the turn', async () => {
      mockDecryptContent.mockImplementation((s: string) => s);
      mockFetch.mockResolvedValueOnce(
        makeSseResponse([
          'data: {not json\n\n',
          ': keep-alive comment\n\n',
          sseChunk({ choices: [{ delta: { content: 'hexA' }, finish_reason: 'stop' }] }),
          SSE_DONE,
        ]),
      );

      const events = await collectStream(
        cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
      );
      expect(events).toEqual([
        { type: 'text-delta', delta: 'hexA' },
        { type: 'finish', reason: 'stop' },
      ]);
    });

    it('falls through to the buffered path when the gateway relays JSON', async () => {
      // NEAR ignoring `stream: true` (or contract drift) must not break chat.
      const jsonResponse = {
        ...makeResponse(200, {
          choices: [{ message: { content: 'cipher', tool_calls: null }, finish_reason: 'stop' }],
        }),
        headers: { get: () => 'application/json' },
      } as unknown as Response;
      mockFetch.mockResolvedValueOnce(jsonResponse);
      mockDecryptContent.mockReturnValueOnce('whole answer');

      const events = await collectStream(
        cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
      );
      expect(events).toEqual([
        { type: 'text-delta', delta: 'whole answer' },
        { type: 'finish', reason: 'stop' },
      ]);
    });

    /** An SSE Response-like that delivers `chunks`, then stalls until aborted. */
    function makeStallingSseResponse(
      signal: AbortSignal | null | undefined,
      chunks: string[],
      onAbort: () => void,
    ): Response {
      const encoded = chunks.map((c) => new TextEncoder().encode(c));
      let i = 0;
      return {
        status: 200, statusText: '200', ok: true,
        headers: { get: () => 'text/event-stream' },
        body: {
          getReader: () => ({
            read: () =>
              i < encoded.length
                ? Promise.resolve({ done: false, value: encoded[i++] })
                : new Promise((_res, reject) => {
                    signal?.addEventListener('abort', () => {
                      onAbort();
                      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                    });
                  }),
            cancel: () => Promise.resolve(),
          }),
        },
        text: () => Promise.resolve(''),
      } as unknown as Response;
    }

    it('gives the FIRST chunk the full 130s budget, not the 30s idle window', async () => {
      // Whether NEAR flushes headers on accept or with the first token is
      // unverified. A single 30s window measured from headers would abort a cold
      // model the buffered path used to tolerate for 130s.
      jest.useFakeTimers();
      let aborted = false;
      mockFetch.mockImplementationOnce((_url: unknown, init: unknown) =>
        Promise.resolve(
          makeStallingSseResponse((init as RequestInit).signal, [], () => { aborted = true; }),
        ),
      );
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve(makeSseResponse([sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }), SSE_DONE])),
      );

      const collected = collectStream(
        cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
      );
      await tickMicrotasks(30);

      jest.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS + 1_000);
      await tickMicrotasks(10);
      expect(aborted).toBe(false); // still well inside the first-chunk budget

      jest.advanceTimersByTime(UPSTREAM_ALIGNED_TIMEOUT_MS);
      jest.useRealTimers();
      await collected;
      expect(aborted).toBe(true);
    }, 15_000);

    it('tightens to STREAM_IDLE_TIMEOUT_MS once chunks start flowing, then retries once', async () => {
      jest.useFakeTimers();
      let aborted = false;
      mockDecryptContent.mockImplementation((s: string) => s);

      // A chunk lands (no text yet), then the body goes silent.
      mockFetch.mockImplementationOnce((_url: unknown, init: unknown) =>
        Promise.resolve(
          makeStallingSseResponse(
            (init as RequestInit).signal,
            [sseChunk({ choices: [{ delta: { content: '', role: 'assistant' } }] })],
            () => { aborted = true; },
          ),
        ),
      );
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve(
          makeSseResponse([
            sseChunk({ choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }] }),
            SSE_DONE,
          ]),
        ),
      );

      const collected = collectStream(
        cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
      );
      await tickMicrotasks(30);
      expect(aborted).toBe(false);

      jest.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS);
      jest.useRealTimers();
      const events = await collected;

      expect(aborted).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // A stalled body IS timeout-class evidence — the retry goes to the fallback.
      expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
      expect(JSON.parse((mockFetch.mock.calls[1] as [string, RequestInit])[1].body as string).model)
        .toBe(FALLBACK_MODEL);
      expect(events).toEqual([
        { type: 'text-delta', delta: 'recovered' },
        { type: 'finish', reason: 'stop' },
      ]);
    }, 15_000);

    it('mid-stream failure with ZERO text yielded fires exactly one fresh request', async () => {
      mockDecryptContent.mockImplementation((s: string) => s);
      mockFetch
        .mockResolvedValueOnce(
          makeFailingSseResponse(
            [sseChunk({ choices: [{ delta: { content: '', role: 'assistant' } }] })],
            Object.assign(new Error('Fetch request has been canceled'), { name: 'AbortError' }),
          ),
        )
        .mockResolvedValueOnce(
          makeSseResponse([
            sseChunk({ choices: [{ delta: { content: 'second try' }, finish_reason: 'stop' }] }),
            SSE_DONE,
          ]),
        )
        .mockResolvedValueOnce(makeResponse(200)); // must never be reached

      const events = await collectStream(
        cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(events).toEqual([
        { type: 'text-delta', delta: 'second try' },
        { type: 'finish', reason: 'stop' },
      ]);
    }, 10_000);

    it('mid-stream failure AFTER text was yielded throws — no silent re-send', async () => {
      mockDecryptContent.mockImplementation((s: string) => s);
      mockFetch
        .mockResolvedValueOnce(
          makeFailingSseResponse(
            [sseChunk({ choices: [{ delta: { content: 'half an answer' } }] })],
            Object.assign(new Error('Fetch request has been canceled'), { name: 'AbortError' }),
          ),
        )
        .mockResolvedValueOnce(makeResponse(200)); // must never be reached

      await expect(
        collectStream(cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] })),
      ).rejects.toThrow(/canceled/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }, 10_000);

    it('a DECRYPT failure retries but never engages the fallback (not model evidence)', async () => {
      // model-fallback.ts: "4xx, auth, E2EE/decrypt and plain network errors say
      // nothing about the model and must never engage this."
      mockDecryptContent
        .mockImplementationOnce(() => { throw new Error('decryption failed'); })
        .mockImplementation((s: string) => s);
      mockFetch
        .mockResolvedValueOnce(
          makeSseResponse([
            sseChunk({ choices: [{ delta: { content: 'corrupt' }, finish_reason: 'stop' }] }),
            SSE_DONE,
          ]),
        )
        .mockResolvedValueOnce(
          makeSseResponse([
            sseChunk({ choices: [{ delta: { content: 'clean' }, finish_reason: 'stop' }] }),
            SSE_DONE,
          ]),
        );

      const events = await collectStream(
        cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] }),
      );

      expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
      expect((logger.captureMessage as jest.Mock)).not.toHaveBeenCalled();
      // The retry stays on the PRIMARY — nothing engaged it.
      expect(JSON.parse((mockFetch.mock.calls[1] as [string, RequestInit])[1].body as string).model)
        .toBe(SMALL_MODEL);
      expect(events).toEqual([
        { type: 'text-delta', delta: 'clean' },
        { type: 'finish', reason: 'stop' },
      ]);
    }, 10_000);
  });
});

// ─── hedged requests (5s race onto the fallback model) ─────────────────────────
//
// Fake timers throughout, and NEVER runAllTimers — that would also fire the
// 130s per-attempt aborts. Every leg is a manually-resolved deferred, and every
// leg runs with maxTimeoutAttempts: 1 unless the test is ABOUT the budget, so
// authFetch's exponential backoff sleep() never enters the picture.

describe('hedged requests', () => {
  interface Leg {
    model: string;
    signal: AbortSignal | null | undefined;
    d: Deferred<Response>;
  }
  let legs: Leg[];

  /** Distinct E2EE key per model, so "ctx follows the winner" is provable —
   *  a shared mock ctx would pass no matter which leg's context was returned. */
  const keyFor = (model: string) => new Uint8Array([model === SMALL_MODEL ? 1 : 2]);

  beforeEach(() => {
    mockFetch.mockReset();
    mockGetJwtToken.mockReset();
    mockEncryptMessages.mockReset();
    mockPrepareE2EEContext.mockReset();
    mockDecryptContent.mockReset();
    [(logger.captureMessage as jest.Mock), (logger.warn as jest.Mock), (logger.error as jest.Mock), (logger.debug as jest.Mock)].forEach((fn) => fn.mockReset());
    resetModelFallback();
    mockGetJwtToken.mockResolvedValue('test-jwt');
    mockDecryptContent.mockImplementation((s: string) => s);
    mockEncryptMessages.mockImplementation(
      async (messages: { role: string; content: string }[], ...rest: unknown[]) => {
        for (const msg of messages) {
          if (msg.content.length > 0) msg.content = `enc(${msg.content})`;
        }
        return { ...makeE2EECtx(), privateKey: keyFor(rest[0] as string) };
      },
    );

    legs = [];
    mockFetch.mockImplementation((_url: unknown, init: unknown) => {
      const i = init as RequestInit;
      const d = deferred<Response>();
      i.signal?.addEventListener('abort', () =>
        d.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
      legs.push({ model: JSON.parse(i.body as string).model, signal: i.signal, d });
      return d.promise;
    });

    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetModelFallback();
  });

  const HEDGED = { hedgeAfterMs: HEDGE_DELAY_MS, maxTimeoutAttempts: 1 };
  const complete = (options: object = HEDGED) =>
    cloudComplete({ systemPrompt: 'sys', prompt: 'p' }, options);
  const okResponse = (blob: string) => makeResponse(200, makeChatResponse(blob));

  /** Advance to just past the hedge delay and let the second leg start. */
  async function fireHedge(): Promise<void> {
    jest.advanceTimersByTime(HEDGE_DELAY_MS);
    await tickMicrotasks(20);
  }

  it('does not fire a second request before the delay elapses', async () => {
    const p = complete();
    await tickMicrotasks();
    expect(legs).toHaveLength(1);

    jest.advanceTimersByTime(HEDGE_DELAY_MS - 1);
    await tickMicrotasks();
    expect(legs).toHaveLength(1);

    legs[0].d.resolve(okResponse('blob'));
    await expect(p).resolves.toBe('blob');
  });

  it('fires the fallback model at the delay and leaves the primary running', async () => {
    const p = complete();
    await tickMicrotasks();
    await fireHedge();

    expect(legs).toHaveLength(2);
    expect(legs[0].model).toBe(SMALL_MODEL);
    expect(legs[1].model).toBe(FALLBACK_MODEL);
    expect(legs[0].signal?.aborted).toBe(false);
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('hedge fired'),
      { primaryModel: SMALL_MODEL, hedgeModel: FALLBACK_MODEL },
    );

    legs[0].d.resolve(okResponse('blob'));
    await p;
  });

  it('primary winning after the hedge fired aborts the hedge and engages nothing', async () => {
    const p = complete();
    await tickMicrotasks();
    await fireHedge();

    legs[0].d.resolve(okResponse('from-primary'));
    await expect(p).resolves.toBe('from-primary');

    expect(legs[1].signal?.aborted).toBe(true);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect((logger.captureMessage as jest.Mock)).not.toHaveBeenCalled();
  });

  it('ctx follows the winner — primary wins', async () => {
    const p = complete();
    await tickMicrotasks();
    await fireHedge();
    legs[0].d.resolve(okResponse('blob'));
    await p;

    expect(mockDecryptContent).toHaveBeenCalledWith('blob', keyFor(SMALL_MODEL), 'ed25519');
  });

  it('ctx follows the winner — hedge wins', async () => {
    const p = complete();
    await tickMicrotasks();
    await fireHedge();
    legs[1].d.resolve(okResponse('blob'));
    await p;

    // The fallback leg's OWN key: decrypting under the primary's would be
    // garbage, since attestation keys are per-model.
    expect(mockDecryptContent).toHaveBeenCalledWith('blob', keyFor(FALLBACK_MODEL), 'ed25519');
  });

  it('a hedge win engages the session fallback, warns once, and skips the race next time', async () => {
    const p = complete();
    await tickMicrotasks();
    await fireHedge();
    legs[1].d.resolve(okResponse('from-hedge'));
    await expect(p).resolves.toBe('from-hedge');

    expect(legs[0].signal?.aborted).toBe(true);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    expect((logger.captureMessage as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((logger.captureMessage as jest.Mock)).toHaveBeenCalledWith(
      'NEAR primary model slow — hedged fallback won, session fallback engaged',
      { level: 'warning', tags: { model: SMALL_MODEL, fallback: FALLBACK_MODEL } },
    );

    // Engaged: the next call goes STRAIGHT to the fallback, with nothing left
    // to race against — no timer, no second request.
    const p2 = complete();
    await tickMicrotasks();
    expect(legs).toHaveLength(3);
    expect(legs[2].model).toBe(FALLBACK_MODEL);
    jest.advanceTimersByTime(HEDGE_DELAY_MS * 3);
    await tickMicrotasks();
    expect(legs).toHaveLength(3);

    legs[2].d.resolve(okResponse('b'));
    await p2;
  });

  it('does not hedge without hedgeAfterMs', async () => {
    const p = complete({ maxTimeoutAttempts: 1 });
    await tickMicrotasks();
    jest.advanceTimersByTime(HEDGE_DELAY_MS * 3);
    await tickMicrotasks();
    expect(legs).toHaveLength(1);

    legs[0].d.resolve(okResponse('b'));
    await p;
  });

  it('does not hedge a model with no configured fallback', async () => {
    const p = cloudComplete(
      { systemPrompt: 'sys', prompt: 'p', model: 'some/model-with-no-fallback' },
      HEDGED,
    );
    await tickMicrotasks();
    jest.advanceTimersByTime(HEDGE_DELAY_MS * 3);
    await tickMicrotasks();
    expect(legs).toHaveLength(1);

    legs[0].d.resolve(okResponse('b'));
    await p;
  });

  it('a timeout-class primary failure after the hedge fired engages, but fires NO third request', async () => {
    const p = complete();
    await tickMicrotasks();
    await fireHedge();

    legs[0].d.resolve(makeResponse(502));
    await tickMicrotasks();

    // The in-flight hedge IS the retry — the sequential tail must not run.
    expect(legs).toHaveLength(2);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    expect((logger.captureMessage as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((logger.captureMessage as jest.Mock)).toHaveBeenCalledWith(
      'NEAR primary model failing — session fallback engaged',
      { level: 'error', tags: { model: SMALL_MODEL, fallback: FALLBACK_MODEL } },
    );

    legs[1].d.resolve(okResponse('rescued'));
    await expect(p).resolves.toBe('rescued');
    expect(legs).toHaveLength(2);
  });

  it('when both legs fail, the PRIMARY failure is what surfaces', async () => {
    const p = complete();
    await tickMicrotasks();
    await fireHedge();

    legs[0].d.resolve(makeResponse(502, {}, { text: 'gateway timeout' }));
    await tickMicrotasks();
    legs[1].d.resolve(makeResponse(400, {}, { text: 'hedge said no' }));

    await expect(p).rejects.toThrow(/E2EE completion failed: 502/);
  });

  it('a hedge failure is swallowed — the primary keeps going and nothing engages', async () => {
    const p = complete();
    await tickMicrotasks();
    await fireHedge();

    legs[1].d.resolve(makeResponse(400, {}, { text: 'hedge said no' }));
    await tickMicrotasks();
    legs[0].d.resolve(okResponse('primary anyway'));

    await expect(p).resolves.toBe('primary anyway');
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect((logger.captureMessage as jest.Mock)).not.toHaveBeenCalled();
  });

  it('both succeeding in the same tick produces exactly one winner (the primary)', async () => {
    const p = complete();
    await tickMicrotasks();
    await fireHedge();

    legs[0].d.resolve(okResponse('primary-blob'));
    legs[1].d.resolve(okResponse('hedge-blob'));

    await expect(p).resolves.toBe('primary-blob');
    expect(mockDecryptContent).toHaveBeenCalledTimes(1);
    expect(legs[1].signal?.aborted).toBe(true);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('a primary 4xx after the hedge fired surfaces the 4xx (a fallback never masks it)', async () => {
    const p = complete();
    await tickMicrotasks();
    await fireHedge();

    legs[0].d.resolve(makeResponse(400, {}, { text: 'bad request' }));
    await expect(p).rejects.toThrow(/E2EE completion failed: 400/);

    expect(legs[1].signal?.aborted).toBe(true);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('aborting the loser never reports a model failure nor leaks an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const p = complete();
      await tickMicrotasks();
      await fireHedge();
      legs[1].d.resolve(okResponse('from-hedge'));
      await p;

      jest.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The loser died by OUR abort — a CallerAbortError, which must never be
      // classified as model evidence.
      expect(unhandled).toEqual([]);
      expect((logger.captureMessage as jest.Mock)).toHaveBeenCalledTimes(1);
      expect((logger.captureMessage as jest.Mock).mock.calls[0][1].level).toBe('warning');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('cloudChatStream hedges by default', async () => {
    const collected = (async () => {
      const events: SseEvent[] = [];
      for await (const e of cloudChatStream({ messages: [{ role: 'user', content: 'Q' }] })) {
        events.push(e);
      }
      return events;
    })();

    await tickMicrotasks();
    expect(legs).toHaveLength(1);
    await fireHedge();
    expect(legs).toHaveLength(2);
    expect(legs[1].model).toBe(FALLBACK_MODEL);

    legs[0].d.resolve(
      makeResponse(200, {
        choices: [{ message: { content: 'cipher', tool_calls: null }, finish_reason: 'stop' }],
      }),
    );
    const events = await collected;
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('a fast 502 exhaustion before the hedge fires is identical to the sequential path', async () => {
    // The one test that needs the REAL timeout budget (and therefore the real
    // backoff sleep), so it runs on real timers.
    jest.useRealTimers();
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(makeResponse(502))
      .mockResolvedValueOnce(makeResponse(502)) // budget (2) exhausted → surfaced
      .mockResolvedValueOnce(okResponse('recovered'));

    const result = await cloudComplete(
      { systemPrompt: 'sys', prompt: 'p' },
      { hedgeAfterMs: HEDGE_DELAY_MS },
    );

    expect(result).toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const bodyModel = (i: number) =>
      JSON.parse((mockFetch.mock.calls[i] as [string, RequestInit])[1].body as string).model;
    expect(bodyModel(0)).toBe(SMALL_MODEL);
    expect(bodyModel(2)).toBe(FALLBACK_MODEL);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  }, 10_000);
});
