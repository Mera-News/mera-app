// Shared kit for the cloudChatStream seam tests. Not a test file (Jest matches *.test.ts only).
//
// Everything runs against the real gateway mock: real E2EE both ways, real auth, the real limiter.
// `rawChat` / `rawJson` are the one escape hatch: a per-test msw override for the faults the
// responder shape cannot express (a provider tool_call in clear, an unparseable SSE frame, an abort
// that errors the body, a silent gap before the first chunk). They seal with the mock's own
// `sealForClient`, so the app still decrypts for real; the mock simply does not record those calls.
import { http, HttpResponse } from 'msw';
import { invalidateJwtCache } from '@/lib/auth-client';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { __resetOnDeviceGateForTests } from '@/lib/llm/on-device-gate';
import type { SseEvent } from '@/lib/llm/cloudComplete';
import logger from '@/lib/logger';
import { assertNoGatewayViolations, server, signInFixtureAccount, type GatewayResponder } from '@/test/helpers';
import { sealForClient } from '@/test/mock-backend/gateway/crypto';

export const SECRET_SYSTEM = 'SENTINEL-SYSTEM-7f3a you are the test model';
export const SECRET_USER = 'SENTINEL-USER-91bc what is the news';
export const MESSAGES = [
  { role: 'system' as const, content: SECRET_SYSTEM },
  { role: 'user' as const, content: SECRET_USER },
];
export const CHAT_URL = '/v1/chat/completions';

export async function collect(gen: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

export const textOf = (events: SseEvent[]) =>
  events.flatMap((e) => (e.type === 'text-delta' ? [e.delta] : [])).join('');

export const respond =
  (r: ReturnType<GatewayResponder>): GatewayResponder =>
  () =>
    r;

/** Real-time poll. For fake-clock tests use `advanceUntil`. */
export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  for (let t = 0; t < ms && !cond(); t += 10) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('until: condition not met');
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Fake clock: advance in small steps until `cond()` holds. Every step also yields one REAL event-loop
 * turn (setImmediate is not faked): the helpers' own `advanceUntilDone` only drains microtasks, and a
 * request through MSW needs real macrotask turns to make progress, so a long virtual wait could be
 * stepped through before the network ever got to answer.
 */
export async function advanceUntil(cond: () => boolean, maxMs = 120_000, stepMs = 50): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs && !cond(); elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await turn();
  }
  if (!cond()) throw new Error('advanceUntil: condition not met');
}

/** `advanceUntil` for a promise: steps the fake clock until it settles, then returns it. */
export async function drive<T>(promise: Promise<T>, maxMs = 120_000, stepMs = 50): Promise<T> {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  for (let elapsed = 0; elapsed < maxMs && !done; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await turn();
  }
  return promise;
}

/** Raw request bodies of the chat route, as the wire carried them (all still ciphertext). */
export function captureChatBodies(): string[] {
  const bodies: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.url.endsWith(CHAT_URL)) void request.clone().text().then((t) => bodies.push(t));
  });
  return bodies;
}

/** Count requests the server saw whose URL ends with `suffix`. */
export function countRequests(suffix: string): () => number {
  let n = 0;
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname.endsWith(suffix)) n += 1;
  });
  return () => n;
}

/** The logger methods the app reports through, spied on the REAL logger (R23), not replaced. */
export interface LoggerSpies {
  captureMessage: jest.SpyInstance;
  captureException: jest.SpyInstance;
  addBreadcrumb: jest.SpyInstance;
}
let spies: LoggerSpies | null = null;
export const loggerSpies = (): LoggerSpies => {
  if (!spies) throw new Error('installChatHooks() was not called');
  return spies;
};

/** Per-file beforeEach/afterEach, as in test/integration/harness/gateway.test.ts. */
export function installChatHooks(timeoutMs = 30_000): void {
  jest.setTimeout(timeoutMs);
  beforeEach(async () => {
    resetLimiter();
    resetModelFallback();
    __resetOnDeviceGateForTests();
    clearAttestationCache();
    invalidateJwtCache();
    await signInFixtureAccount();
    spies = {
      captureMessage: jest.spyOn(logger, 'captureMessage'),
      captureException: jest.spyOn(logger, 'captureException'),
      addBreadcrumb: jest.spyOn(logger, 'addBreadcrumb'),
    };
  });
  afterEach(() => {
    server.events.removeAllListeners();
    for (const s of Object.values(spies ?? {})) s.mockRestore();
    spies = null;
    assertNoGatewayViolations();
  });
}

// --- raw wire faults -----------------------------------------------------------------------

/** One `data:` frame. */
export const frame = (payload: object | string) =>
  `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
export const DONE = frame('[DONE]');
export const delta = (d: object, finish?: string) =>
  frame({ choices: [{ index: 0, delta: d, ...(finish ? { finish_reason: finish } : {}) }] });

export type RawItem = string | { wait: number } | { fail: Error };
type Seal = (plaintext: string) => string;

/**
 * A raw SSE reply for the chat route. `script` gets a `seal` bound to the caller's client key and
 * returns the body as pieces: a string is written as-is (so a frame can be split mid-way), `{ wait }`
 * is a silent gap (cut short by the request's abort), `{ fail }` errors the body.
 * `requests()` counts how many calls reached this handler.
 */
export function rawChat(script: (seal: Seal) => RawItem[], opts: { once?: boolean } = {}) {
  let count = 0;
  const handler = http.post(
    `*${CHAT_URL}`,
    ({ request }) => {
      count += 1;
      const clientPub = request.headers.get('x-client-pub-key') ?? '';
      const algo = (request.headers.get('x-signing-algo') ?? 'ed25519') as 'ed25519' | 'ecdsa';
      const items = script((t) => sealForClient(t, clientPub, algo));
      const enc = new TextEncoder();
      const it = (async function* () {
        for (const item of items) {
          if (typeof item === 'string') yield item;
          else if ('wait' in item) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, item.wait);
              request.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
            });
            if (request.signal.aborted) return;
          } else throw item.fail;
        }
      })();
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const { value, done } = await it.next();
              if (done) controller.close();
              else controller.enqueue(enc.encode(value));
            } catch (err) {
              controller.error(err);
            }
          },
          cancel() {
            void it.return(undefined);
          },
        },
        { highWaterMark: 0 },
      );
      return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
    { once: opts.once ?? false },
  );
  return { handler, requests: () => count };
}

/** A raw JSON (non-SSE) 200 reply for the chat route, e.g. a provider `tool_calls` in clear. */
export function rawJson(body: (seal: Seal) => object, opts: { once?: boolean } = {}) {
  let count = 0;
  const handler = http.post(
    `*${CHAT_URL}`,
    ({ request }) => {
      count += 1;
      const clientPub = request.headers.get('x-client-pub-key') ?? '';
      const algo = (request.headers.get('x-signing-algo') ?? 'ed25519') as 'ed25519' | 'ecdsa';
      return HttpResponse.json(body((t) => sealForClient(t, clientPub, algo)));
    },
    { once: opts.once ?? false },
  );
  return { handler, requests: () => count };
}

/** An AbortError, as a cancelled fetch body rejects with. */
export const abortError = () => Object.assign(new Error('Fetch request has been canceled'), { name: 'AbortError' });
