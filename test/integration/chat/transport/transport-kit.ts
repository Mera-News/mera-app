// Shared setup for the chat transport seam tests: the resets every file runs in beforeEach, a
// request recorder for what the gateway mock does not keep (raw bodies, network faults, timings),
// and a sealed request builder for driving authFetch directly. Not a test file.
import { getJwtToken } from '@/lib/auth-client';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { encryptContent, prepareE2EEContext } from '@/lib/e2ee/e2ee-service';
import { SMALL_MODEL } from '@/lib/llm/constants';
import {
  http,
  HttpResponse,
  server,
  signInFixtureAccount,
  type GatewayReply,
  type GatewayResponder,
} from '@/test/helpers';
import { driveUntilDone, resetChatModules, useStrictClock } from '@/test/integration/chat/_helpers';

import type { JsonBodyType } from 'msw';
import { openFromClientV2, redpillAttestationBody, sealForClient, sealForClientV2 } from '@/test/mock-backend/gateway/crypto';

// Aliased: a function named use* trips react-hooks/rules-of-hooks wherever it is called.
const strictClock = useStrictClock;

export const ORIGIN = 'http://127.0.0.1:8790';
export const CHAT_PATH = '/v1/chat/completions';
export const BATCH_PATH = '/v1/chat/completions/batch';
export const TOKEN_PATH = '/api/auth/token';

/** The resets every transport test starts from. Signed-out cases pass `signIn: false`. */
export async function resetTransport({ signIn = true }: { signIn?: boolean } = {}): Promise<void> {
  resetChatModules();
  resetBreaker();
  if (signIn) await signInFixtureAccount();
}

/** A fake clock on the real clock's value, so JWT, attestation and limiter times agree. */
export function fakeClock(): void {
  strictClock(Date.now());
}

/** Drives a promise to completion under the fake clock. */
export const run = <T>(p: Promise<T>, maxMs = 600_000, stepMs = 100): Promise<T> =>
  driveUntilDone(p, maxMs, stepMs);

export const respond = (r: GatewayReply): GatewayResponder => () => r;

/** The error a promise rejects with, or null when it resolves. */
export const errorOf = (p: Promise<unknown>): Promise<Error | null> =>
  p.then(
    () => null,
    (e: unknown) => e as Error,
  );

/**
 * Records every request to one path as it starts: its (fake or real) clock time and its raw
 * body. Network faults never reach the mock's call log, so this is the only place they count.
 */
export function watchRequests(path: string) {
  const seen: { at: number; body: Promise<string> }[] = [];
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname === path) {
      seen.push({ at: Date.now(), body: request.clone().text() });
    }
  });
  return {
    count: () => seen.length,
    times: () => seen.map((s) => s.at),
    raw: () => Promise.all(seen.map((s) => s.body)),
    json: async () => (await Promise.all(seen.map((s) => s.body))).map((b) => JSON.parse(b)),
  };
}

/** The next `times` requests to the chat route fail at the network level (no response at all). */
export function failChatNetwork(times: number): void {
  server.use(
    ...Array.from({ length: times }, () =>
      http.post(`*${CHAT_PATH}`, () => HttpResponse.error(), { once: true }),
    ),
  );
}

/** The chat route fails at the network level on every request. */
export function failChatNetworkAlways(): void {
  server.use(http.post(`*${CHAT_PATH}`, () => HttpResponse.error()));
}

/** A sealed chat request built with the real E2EE context, ready for authFetch. */
export async function sealedInit(content: string, extra: RequestInit = {}): Promise<RequestInit> {
  const ctx = await prepareE2EEContext(SMALL_MODEL);
  const token = await getJwtToken();
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...ctx.headers },
    body: JSON.stringify({
      model: SMALL_MODEL,
      stream: false,
      messages: [{ role: 'user', content: encryptContent(content, ctx) }],
    }),
    ...extra,
  };
}

export { advanceUntil } from '@/test/helpers';

/**
 * Replaces one gateway route with a reply the responder cannot express (a malformed body, a
 * per-item batch error, an out-of-order batch). `build` gets a `seal` toward the calling client,
 * so the reply still opens with the client's real key.
 */
export function serveJson(path: string, build: (seal: (plaintext: string) => string) => JsonBodyType): void {
  server.use(
    http.post(`*${path}`, ({ request }) => {
      const pub = request.headers.get('x-client-pub-key') ?? '';
      const algo = request.headers.get('x-signing-algo') === 'ecdsa' ? 'ecdsa' : 'ed25519';
      return HttpResponse.json(build((text) => sealForClient(text, pub, algo)));
    }),
  );
}

/** One sync request RedPill received, opened with the test model's key. */
export interface RedPillCall {
  model: string;
  nonce: string;
  messages: { role: string; content: string }[];
  body: Record<string, unknown>;
}

/**
 * Serves RedPill on the mock: its aci/1 key report and E2EE v2 sync completions (the shared
 * mock speaks NEAR only). `reply` gets the opened messages; a `{ status }` answers raw.
 * Requests without `X-Mera-Provider: redpill` fall through to the NEAR mock.
 */
export function serveRedPill(
  reply: (messages: { role: string; content: string }[]) => string | { status: number },
): RedPillCall[] {
  const calls: RedPillCall[] = [];
  const isRedPill = (request: Request) => request.headers.get('x-mera-provider') === 'redpill';
  server.use(
    http.get('*/api/attestation/report', ({ request }) =>
      isRedPill(request) ? HttpResponse.json(redpillAttestationBody()) : undefined,
    ),
    http.post(`*${CHAT_PATH}`, async ({ request }) => {
      if (!isRedPill(request)) return undefined;
      const h = request.headers;
      const body = (await request.json()) as { model: string; messages: { role: string; content: string }[] };
      const p = { model: body.model, nonce: h.get('x-e2ee-nonce') ?? '', ts: Number(h.get('x-e2ee-timestamp')) };
      const messages = body.messages.map((m, i) => ({
        role: m.role,
        content: m.content ? openFromClientV2(m.content, p, `messages.${i}.content`) : '',
      }));
      calls.push({ model: body.model, nonce: p.nonce, messages, body });
      const r = reply(messages);
      if (typeof r !== 'string') return new HttpResponse('down', { status: r.status });
      const id = `req_${calls.length}`;
      const content = sealForClientV2(r, h.get('x-client-pub-key') ?? '', p, 'choices.0.message.content', id);
      return HttpResponse.json({ id, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    }),
  );
  return calls;
}
