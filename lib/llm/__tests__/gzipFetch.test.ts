// Tests for lib/llm/gzipFetch.ts — thin gzip wrapper over authFetch.
// pako is pure JS and runs for real; authFetch is mocked.

const mockAuthFetch = jest.fn();

jest.mock('../cloudComplete', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

// pako is pure — let it run for real (no mock needed).

import pako from 'pako';
import { gzipFetch } from '../gzipFetch';

const MIN_GZIP_BYTES = 4 * 1024; // must match source

function makeBody(size: number): string {
  // Fill with 'a' repeated to hit exactly the desired byte length.
  return 'a'.repeat(size);
}

function makeResponse(status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: jest.fn(() => Promise.resolve({})),
    text: jest.fn(() => Promise.resolve('')),
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthFetch.mockResolvedValue(makeResponse(200));
});

describe('gzipFetch — small body (< 4 KB)', () => {
  it('passes small body straight through without gzip', async () => {
    const body = makeBody(100);
    await gzipFetch('https://example.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit & { body?: unknown }];
    // Body should be the original string (no Uint8Array)
    expect(typeof init.body).toBe('string');
    expect(init.body).toBe(body);
  });

  it('sets Content-Type to application/json if not supplied for small body', async () => {
    await gzipFetch('https://example.test/api', {
      method: 'POST',
      body: makeBody(10),
    });

    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('preserves an explicit Content-Type for small body', async () => {
    await gzipFetch('https://example.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: makeBody(10),
    });

    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('Content-Type')).toBe('text/plain');
  });

  it('passes the URL through unchanged', async () => {
    const url = 'https://inference.example.test/v1/jobs';
    await gzipFetch(url, { method: 'POST', body: makeBody(50) });
    expect(mockAuthFetch.mock.calls[0][0]).toBe(url);
  });

  it('uses empty string when body is undefined', async () => {
    await gzipFetch('https://example.test/api', { method: 'POST' });
    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit & { body?: unknown }];
    // byteLength of '' is 0 < 4096 → straight-through path
    expect(typeof init.body).not.toBe('object'); // no Uint8Array
  });
});

describe('gzipFetch — large body (>= 4 KB)', () => {
  it('compresses large body with gzip', async () => {
    const body = makeBody(MIN_GZIP_BYTES); // exactly at threshold
    await gzipFetch('https://example.test/api', {
      method: 'POST',
      body,
    });

    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit & { body?: unknown }];
    // Body must now be a Uint8Array (gzipped)
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  it('sets Content-Encoding: gzip for large body', async () => {
    const body = makeBody(MIN_GZIP_BYTES + 100);
    await gzipFetch('https://example.test/api', { method: 'POST', body });

    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('Content-Encoding')).toBe('gzip');
  });

  it('sets Content-Type for large body even if not supplied', async () => {
    const body = makeBody(MIN_GZIP_BYTES + 100);
    await gzipFetch('https://example.test/api', { method: 'POST', body });

    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('preserves explicit Content-Type for large body', async () => {
    const body = makeBody(MIN_GZIP_BYTES + 100);
    await gzipFetch('https://example.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });

    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('produces a valid gzip stream that decompresses to the original body', async () => {
    const body = makeBody(MIN_GZIP_BYTES + 200);
    await gzipFetch('https://example.test/api', { method: 'POST', body });

    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit & { body?: unknown }];
    const compressed = init.body as Uint8Array;
    const decompressed = pako.ungzip(compressed, { to: 'string' });
    expect(decompressed).toBe(body);
  });

  it('forwards extra init properties (e.g. method, signal)', async () => {
    const controller = new AbortController();
    const body = makeBody(MIN_GZIP_BYTES + 50);
    await gzipFetch('https://example.test/api', {
      method: 'PUT',
      signal: controller.signal,
      body,
    });

    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(init.signal).toBe(controller.signal);
  });

  it('returns the Response from authFetch', async () => {
    const mockResp = makeResponse(201);
    mockAuthFetch.mockResolvedValueOnce(mockResp);
    const body = makeBody(MIN_GZIP_BYTES + 50);
    const result = await gzipFetch('https://example.test/api', { method: 'POST', body });
    expect(result).toBe(mockResp);
  });
});

describe('gzipFetch — non-string body', () => {
  it('treats non-string body (e.g. Uint8Array) as 0 bytes — takes small body path (no gzip)', async () => {
    // The source has: typeof body === 'string' ? encoder.encode(body).length : 0
    // A Uint8Array body gives byteLength=0 → small body path (no gzip applied).
    // The original body IS passed through unmodified (no Content-Encoding: gzip set).
    const binaryBody = new Uint8Array(100) as unknown as string;
    await gzipFetch('https://example.test/api', {
      method: 'POST',
      body: binaryBody,
    });
    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit & { headers?: Headers }];
    // Since byteLength=0 < 4096, the no-gzip path is taken — no Content-Encoding header.
    const headers = init.headers as Headers;
    expect(headers.get('Content-Encoding')).toBeNull();
    // authFetch was called (not short-circuited)
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
  });
});

describe('gzipFetch — boundary at exactly MIN_GZIP_BYTES', () => {
  it('compresses a body of exactly MIN_GZIP_BYTES bytes', async () => {
    const body = makeBody(MIN_GZIP_BYTES);
    await gzipFetch('https://example.test/api', { method: 'POST', body });
    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit & { body?: unknown }];
    // exactly at threshold triggers gzip path
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  it('does NOT compress a body of MIN_GZIP_BYTES − 1 bytes', async () => {
    const body = makeBody(MIN_GZIP_BYTES - 1);
    await gzipFetch('https://example.test/api', { method: 'POST', body });
    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit & { body?: unknown }];
    expect(typeof init.body).toBe('string');
  });
});
