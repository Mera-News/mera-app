// Stall timeout of the streamed NEAR caller.
//   npx tsx --tsconfig harness-local/tsconfig.json --test harness-local/lib/near-call-stall.test.ts
// A local http server stands in for NEAR; no network.

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { postBodyStream, SpendLimitError } from './near-call';

const SSE = (text: string): string =>
  `data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
const DONE = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

type Handler = (req: IncomingMessage, res: ServerResponse, n: number, body: string) => void;

async function withServer<T>(handler: Handler, run: (url: string, bodies: string[]) => Promise<T>): Promise<T> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { bodies.push(body); handler(req, res, bodies.length, body); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const BODY = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const OPTS = { stallTimeoutMs: 150 };
const sseHead = (res: ServerResponse): void => { res.writeHead(200, { 'content-type': 'text/event-stream' }); };

test('a server that sends nothing: one retry, then error "stall", identical bodies', async () => {
  await withServer(() => { /* never answers */ }, async (url, bodies) => {
    const r = await postBodyStream(url, 'k', BODY, 10_000, undefined, OPTS);
    assert.equal(r.error, 'stall');
    assert.equal(r.stallRetries, 1);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
  });
});

test('a stall mid-stream after some chunks is retried; a good retry succeeds', async () => {
  await withServer((_req, res, n) => {
    sseHead(res);
    if (n === 1) { res.write(SSE('par')); return; } // then silence
    res.write(SSE('whole')); res.end(DONE);
  }, async (url, bodies) => {
    const r = await postBodyStream(url, 'k', BODY, 10_000, undefined, OPTS);
    assert.equal(r.error, null);
    assert.equal(r.content, 'whole');
    assert.equal(r.stallRetries, 1);
    assert.equal(bodies.length, 2);
  });
});

test('a fast server is called once, no retry', async () => {
  await withServer((_req, res) => { sseHead(res); res.write(SSE('ok')); res.end(DONE); }, async (url, bodies) => {
    const r = await postBodyStream(url, 'k', BODY, 10_000, undefined, OPTS);
    assert.equal(r.error, null);
    assert.equal(r.stallRetries, 0);
    assert.equal(bodies.length, 1);
  });
});

test('a 402 spend cap throws once and is never retried', async () => {
  await withServer((_req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'api_key_limit_exceeded', message: 'API key spend limit exceeded. Spent: $1, Limit: $1' } }));
  }, async (url, bodies) => {
    await assert.rejects(postBodyStream(url, 'k', BODY, 10_000, undefined, OPTS), SpendLimitError);
    assert.equal(bodies.length, 1);
  });
});

test('a 4xx is recorded and never retried', async () => {
  await withServer((_req, res) => { res.writeHead(400); res.end('bad'); }, async (url, bodies) => {
    const r = await postBodyStream(url, 'k', BODY, 10_000, undefined, OPTS);
    assert.match(r.error ?? '', /^HTTP 400/);
    assert.equal(r.stallRetries, 0);
    assert.equal(bodies.length, 1);
  });
});
