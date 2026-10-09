// Mock of mera-inference-gateway + NEAR. Real E2EE runs both ways through the
// app's own primitives (see crypto.ts). Every route is driven by a per-test
// responder (state.responder); the helper API lives in test/helpers/gateway.ts.
//
// Attestation faults (401, 403, 429, 5xx, 503 `Model not found`, a 3p-shaped
// body, an off-curve key) are NOT a responder concern: override the route with
// server.use(http.get('*\/api/attestation/report', ...)). Other faults go
// through the responder (`{ status }` replies, `closeAfter`, `stallAfter`, ...).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { delay, http, HttpResponse, type RequestHandler } from 'msw';
import { gunzipSync } from 'node:zlib';
import { FORBIDDEN_TOOL_KEYS } from '../../../lib/llm/text-tool-protocol';
import type {
  GatewayCall,
  GatewayReply,
  GatewayResponder,
  GatewayRoute,
} from '../../helpers/gateway';
import { openFromClient, sealForClient } from './crypto';
import { TEST_MODEL_KEYS, type GatewayAlgo } from './keys';
import { gatewayState as state, resetGatewayState, type GatewayJobRow } from './state';

export { resetGatewayState };

const FIXTURE_PATH = join(__dirname, '../../../lib/e2ee/__tests__/fixtures/attestation-report.json');

const curveFor = (model: string): GatewayAlgo => state.curveByModel.get(model) ?? 'ed25519';
const lower = (h: Headers) => Object.fromEntries([...h.entries()].map(([k, v]) => [k.toLowerCase(), v]));
const unauthorized = () => new HttpResponse('Unauthorized', { status: 401 });
const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

type Msg = { role: string; content: string };
type StatusReply = Extract<GatewayReply, { status: number }>;
type ChunksReply = Extract<GatewayReply, { chunks: string[] }>;
const isStatus = (r: GatewayReply): r is StatusReply => typeof r === 'object' && 'status' in r;
const isChunks = (r: GatewayReply): r is ChunksReply => typeof r === 'object' && 'chunks' in r;
const replyText = (r: Exclude<GatewayReply, StatusReply>) => (typeof r === 'string' ? r : r.chunks.join(''));
const replyDelay = (r: GatewayReply) => (typeof r === 'object' && 'headerDelayMs' in r ? r.headerDelayMs ?? 0 : 0);

function violation(route: GatewayRoute, rule: string): Response {
  state.violations.push({ route, rule });
  return HttpResponse.json({ error: `E2E mock: ${rule}` }, { status: 500 });
}

/** A raw, unencrypted reply (429 + Retry-After, 401, 502, 503 ...). */
function rawResponse(r: StatusReply): Response {
  const headers = r.headers ?? {};
  if (r.body === undefined) return new HttpResponse(null, { status: r.status, headers });
  if (typeof r.body === 'string') return new HttpResponse(r.body, { status: r.status, headers });
  return HttpResponse.json(r.body, { status: r.status, headers });
}

function hasForbiddenKey(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const k = hasForbiddenKey(x);
      if (k) return k;
    }
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if ((FORBIDDEN_TOOL_KEYS as readonly string[]).includes(k)) return k;
      const inner = hasForbiddenKey(x);
      if (inner) return inner;
    }
  }
  return null;
}

/** The E2EE header contract the real gateway/NEAR enforce. Returns the broken rule, if any. */
function checkE2eeHeaders(h: Record<string, string>, model: string): string | null {
  const algo = h['x-signing-algo'];
  if (!h['authorization']) return 'missing Authorization';
  if (algo !== 'ed25519' && algo !== 'ecdsa') return 'missing or unknown X-Signing-Algo';
  if (!h['x-client-pub-key']) return 'missing X-Client-Pub-Key';
  if (!h['x-model-pub-key']) return 'missing X-Model-Pub-Key';
  if (h['x-model-pub-key'] !== TEST_MODEL_KEYS[algo].publicKeyHex) return 'X-Model-Pub-Key is not the served test key';
  if (algo !== curveFor(model)) return `X-Signing-Algo ${algo} is not the curve served for ${model}`;
  if (algo === 'ed25519' ? h['x-encryption-version'] !== '2' : 'x-encryption-version' in h) {
    return 'X-Encryption-Version must be 2 if and only if ed25519';
  }
  return null;
}

/** Decrypt every non-empty content. Null when any envelope does not open. */
function openMessages(messages: Msg[], algo: GatewayAlgo): Msg[] | null {
  try {
    return messages.map((m) => ({
      ...m,
      content: typeof m.content === 'string' && m.content.length > 0 ? openFromClient(m.content, algo) : '',
    }));
  } catch {
    return null;
  }
}

function newCall(
  route: GatewayRoute,
  request: Request,
  fields: Pick<GatewayCall, 'model' | 'stream' | 'algo' | 'messages'> & { callId?: string; headers?: Record<string, string> },
): GatewayCall {
  const call: GatewayCall = {
    route,
    callId: fields.callId,
    model: fields.model,
    stream: fields.stream,
    algo: fields.algo,
    messages: fields.messages,
    headers: fields.headers ?? lower(request.headers),
    // Per-route sequence number, so a reply script can key on "the 2nd chat leg".
    index: state.calls.filter((c) => c.route === route).length,
    aborted: false,
  };
  request.signal.addEventListener('abort', () => (call.aborted = true), { once: true });
  state.calls.push(call);
  return call;
}

const decryptFailed = (model: string) =>
  HttpResponse.json({ error: `Provider failed for model '${model}': Decryption failed` }, { status: 400 });

// --- SSE -----------------------------------------------------------------

function sseStream(
  call: GatewayCall,
  reply: Exclude<GatewayReply, StatusReply | string>,
  clientPub: string,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const seal = (t: string) => sealForClient(t, clientPub, call.algo);
  let cancelled = false;
  const live = () => !cancelled && !signal.aborted;
  const delta = (d: object) => ({ choices: [{ index: 0, delta: d }] });

  // Pull-driven (highWaterMark 0): a chunk is produced only when the client reads, so an
  // abrupt close lands AFTER the previous chunk was delivered (error() discards queued chunks).
  async function* frames(): AsyncGenerator<unknown> {
    if (reply.reasoning) yield delta({ reasoning_content: seal('E2E fixture reasoning.') });
    for (let i = 0; i < reply.chunks.length; i++) {
      if (i > 0 && reply.chunkDelayMs) await delay(reply.chunkDelayMs);
      if (!live()) return;
      if (reply.closeAfter !== undefined && i >= reply.closeAfter) {
        throw new Error('E2E mock: connection closed mid-stream');
      }
      if (reply.stallAfter !== undefined && i >= reply.stallAfter) {
        // Open and silent until the client gives up.
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return;
      }
      yield delta({ content: seal(reply.chunks[i]) });
    }
    if (!live()) return;
    yield { choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason ?? 'stop' }] };
    yield { choices: [], usage: USAGE };
    yield '[DONE]';
  }

  const it = frames();
  // A client that cancels (Stop, a hedge loser, an idle abort) closes the stream while a pull may
  // still be awaiting the next frame (a chunkDelayMs wait). Nothing touches the controller once
  // the stream is cancelled or the request aborted, and every controller call is guarded, so a
  // late frame can never surface "Invalid state: ReadableStream is already closed".
  const safely = (f: () => void) => {
    try {
      f();
    } catch {
      /* the stream closed under us: the client went away */
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let res: IteratorResult<unknown>;
        try {
          res = await it.next();
        } catch (err) {
          if (live()) safely(() => controller.error(err));
          return;
        }
        if (!live()) return;
        const { value, done } = res;
        safely(() => {
          if (done) controller.close();
          else controller.enqueue(enc.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`));
        });
      },
      cancel() {
        cancelled = true;
        void it.return(undefined).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

async function chatReply(call: GatewayCall, reply: GatewayReply, request: Request): Promise<Response> {
  const wait = replyDelay(reply);
  if (wait) await delay(wait);
  if (isStatus(reply)) return rawResponse(reply);
  const clientPub = call.headers['x-client-pub-key'];
  const streamed = call.stream && !(isChunks(reply) && reply.ignoreStream);
  if (streamed) {
    const obj: Exclude<GatewayReply, StatusReply | string> = typeof reply === 'string' ? { chunks: [reply] } : reply;
    return new HttpResponse(sseStream(call, obj, clientPub, request.signal), {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }
  const message: Record<string, string> = { content: sealForClient(replyText(reply), clientPub, call.algo) };
  if (isChunks(reply) && reply.reasoning) message.reasoning_content = sealForClient('E2E fixture reasoning.', clientPub, call.algo);
  return HttpResponse.json({
    id: `chatcmpl-e2e-${call.index}`,
    model: call.model,
    choices: [{ index: 0, message, finish_reason: (isChunks(reply) && reply.finishReason) || 'stop' }],
    usage: USAGE,
  });
}

// --- routes --------------------------------------------------------------

const attestation = http.get('*/api/attestation/report', ({ request }) => {
  if (!request.headers.get('authorization')) return unauthorized();
  const url = new URL(request.url);
  // G2: the verification tap sends a nonce and gets NEAR's captured report.
  if (url.searchParams.has('nonce')) {
    return new HttpResponse(readFileSync(FIXTURE_PATH), { headers: { 'content-type': 'application/json' } });
  }
  // G1: the hot path. A test key on the model's curve (no secret exists for the fixture's key).
  const model = url.searchParams.get('model') ?? '';
  state.attestationCount.set(model, (state.attestationCount.get(model) ?? 0) + 1);
  const algo = curveFor(model);
  return HttpResponse.json({
    model_attestations: [
      {
        model_name: model,
        signing_address: '0xe2e',
        signing_algo: algo,
        signing_public_key: TEST_MODEL_KEYS[algo].publicKeyHex,
        request_nonce: '',
      },
    ],
  });
});

const chat = http.post('*/v1/chat/completions', async ({ request }) => {
  const body = (await request.json()) as { model?: string; stream?: boolean; messages?: Msg[] };
  const model = body.model ?? '';
  const headers = lower(request.headers);
  const rule = checkE2eeHeaders(headers, model);
  if (rule) return violation('chat', rule);
  const forbidden = hasForbiddenKey(body);
  if (forbidden) return violation('chat', `cleartext tool field "${forbidden}" in the request body`);
  const algo = headers['x-signing-algo'] as GatewayAlgo;
  const messages = openMessages(body.messages ?? [], algo);
  if (!messages) {
    state.violations.push({ route: 'chat', rule: 'message content did not decrypt (cleartext or wrong key)' });
    return decryptFailed(model);
  }
  const call = newCall('chat', request, { model, stream: body.stream === true, algo, messages, headers });
  return chatReply(call, state.responder(call), request);
});

const batch = http.post('*/v1/chat/completions/batch', async ({ request }) => {
  const body = (await request.json()) as { requests?: { model?: string; stream?: boolean; messages: Msg[] }[] };
  const items = body.requests ?? [];
  const headers = lower(request.headers);
  const rule = checkE2eeHeaders(headers, items[0]?.model ?? '');
  if (rule) return violation('batch', rule);
  const forbidden = hasForbiddenKey(body);
  if (forbidden) return violation('batch', `cleartext tool field "${forbidden}" in the request body`);
  const algo = headers['x-signing-algo'] as GatewayAlgo;
  const clientPub = headers['x-client-pub-key'];
  const results = [];
  let wait = 0;
  for (const [index, item] of items.entries()) {
    const messages = openMessages(item.messages ?? [], algo);
    if (!messages) {
      state.violations.push({ route: 'batch', rule: 'message content did not decrypt (cleartext or wrong key)' });
      return decryptFailed(item.model ?? '');
    }
    // Batch items carry no id on the wire (the client maps results by index), so callId stays unset.
    const call = newCall('batch', request, { model: item.model ?? '', stream: false, algo, messages, headers });
    const reply = state.responder(call);
    // A `{ status }` reply fails the whole request, as a gateway-level 429/5xx would; with
    // `perItem` only this item fails, as an upstream error on one call of the batch does.
    if (isStatus(reply) && reply.perItem) {
      const msg = (reply.body as { error?: unknown } | undefined)?.error;
      results.push({ index, error: { message: typeof msg === 'string' ? msg : `status ${reply.status}` } });
      continue;
    }
    if (isStatus(reply)) return rawResponse(reply);
    wait ||= replyDelay(reply);
    results.push({
      index,
      response: {
        id: `chatcmpl-e2e-batch-${index}`,
        model: call.model,
        choices: [
          {
            index: 0,
            message: { content: sealForClient(replyText(reply), clientPub, algo) },
            finish_reason: (isChunks(reply) && reply.finishReason) || 'stop',
          },
        ],
        usage: USAGE,
      },
    });
  }
  if (wait) await delay(wait);
  return HttpResponse.json({ results });
});

const jobId = (n: number) => n.toString(16).padStart(24, '0');

const submitJob = http.post('*/v1/inference/jobs', async ({ request }) => {
  const headers = lower(request.headers);
  if (!headers['authorization']) return unauthorized();
  // The client gzips the body (Content-Encoding: gzip) and the interceptor hands it over raw.
  const raw = Buffer.from(await request.arrayBuffer());
  const text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
  const body = JSON.parse(text) as {
    e2eeSession: Record<string, string>;
    requests: { id: string; body: { model: string; messages: Msg[] } }[];
    sharedSystem?: string;
  };
  const key = headers['idempotency-key'];
  const replayed = key ? state.jobKeys.get(key) : undefined;
  if (replayed) return HttpResponse.json({ requestId: replayed, capabilityToken: `cap.${replayed}` }, { status: 202 });

  const session = Object.fromEntries(Object.entries(body.e2eeSession ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const sessionRule = checkE2eeHeaders({ authorization: 'x', ...session }, body.requests[0]?.body.model ?? '');
  if (sessionRule) return violation('job', `e2eeSession: ${sessionRule}`);
  const forbidden = hasForbiddenKey(body);
  if (forbidden) return violation('job', `cleartext tool field "${forbidden}" in the request body`);
  const algo = session['x-signing-algo'] as GatewayAlgo;

  let sharedSystem: Msg[] = [];
  try {
    if (body.sharedSystem) sharedSystem = [{ role: 'system', content: openFromClient(body.sharedSystem, algo) }];
  } catch {
    state.violations.push({ route: 'job', rule: 'sharedSystem did not decrypt (cleartext or wrong key)' });
    return decryptFailed('');
  }

  const calls: GatewayCall[] = [];
  const rows: GatewayJobRow[] = [];
  for (const item of body.requests) {
    const opened = openMessages(item.body.messages ?? [], algo);
    if (!opened) {
      state.violations.push({ route: 'job', rule: 'message content did not decrypt (cleartext or wrong key)' });
      return decryptFailed(item.body.model);
    }
    const call = newCall('job', request, {
      callId: item.id,
      model: item.body.model,
      stream: false,
      algo,
      messages: [...sharedSystem, ...opened],
      headers: { ...headers, ...session },
    });
    calls.push(call);
    const reply = state.responder(call);
    rows.push(
      isStatus(reply)
        ? { id: item.id, ok: false, error: `E2E mock: upstream ${reply.status}` }
        : { id: item.id, ok: true, content: sealForClient(replyText(reply), session['x-client-pub-key'], algo) },
    );
  }
  const requestId = jobId(state.jobs.size + 1);
  state.jobs.set(requestId, { requestId, calls, results: rows, polls: 0, idempotencyKey: key });
  if (key) state.jobKeys.set(key, requestId);
  return HttpResponse.json({ requestId, capabilityToken: `cap.${requestId}` }, { status: 202 });
});

const jobResults = http.get('*/v1/inference/jobs/:id/results', ({ request, params }) => {
  const auth = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!auth) return unauthorized();
  const id = String(params.id);
  // Capability tokens are bound to one request id.
  if (auth.startsWith('cap.') && auth !== `cap.${id}`) return new HttpResponse('Forbidden', { status: 403 });
  const job = state.jobs.get(id);
  if (!job) return new HttpResponse('Unknown requestId', { status: 404 });
  if (job.polls++ < state.pendingPolls) return HttpResponse.json({ pending: true });
  return HttpResponse.json({
    requestId: id,
    results: job.results.map((r) =>
      r.ok
        ? { id: r.id, ok: true, response: { choices: [{ message: { content: r.content }, finish_reason: 'stop' }] } }
        : { id: r.id, ok: false, error: r.error },
    ),
  });
});

/** Plaintext search-ish routes: the one place the gateway handles cleartext by design. */
async function search(request: Request, route: 'web-search' | 'fact-check-claims'): Promise<Response> {
  if (!request.headers.get('authorization')) return unauthorized();
  const body = (await request.json()) as { query?: string; queries?: string[] };
  const batched = Array.isArray(body.queries);
  if (batched === (body.query !== undefined)) {
    return HttpResponse.json({ error: 'Provide exactly one of `query` or `queries`' }, { status: 400 });
  }
  const entries: { query: string; parsed: unknown }[] = [];
  for (const query of batched ? body.queries! : [body.query!]) {
    const call = newCall(route, request, {
      model: route,
      stream: false,
      algo: 'ed25519', // n/a: these routes are plaintext
      messages: [{ role: 'user', content: query }],
    });
    const reply = state.responder(call);
    // A `{ status }` reply (503 search-unavailable, 429 ...) passes through raw.
    if (isStatus(reply)) return rawResponse(reply);
    await delay(replyDelay(reply));
    entries.push({ query, parsed: JSON.parse(replyText(reply)) });
  }
  if (route === 'fact-check-claims') return HttpResponse.json({ claimReviews: entries[0].parsed });
  if (!batched) return HttpResponse.json({ results: entries[0].parsed });
  return HttpResponse.json({
    searches: entries.map(({ query, parsed }) =>
      // A non-array reply is a per-entry verdict, e.g. { code: 'search-unavailable' }.
      Array.isArray(parsed) ? { query, results: parsed } : { query, ...(parsed as object) },
    ),
  });
}

const webSearch = http.post('*/v1/web-search', ({ request }) => search(request, 'web-search'));
const factCheckClaims = http.post('*/v1/fact-check-claims', ({ request }) => search(request, 'fact-check-claims'));

/**
 * The gateway mock. With no arguments (the default handler set) it leaves the
 * current responder alone; with a responder it installs it, and `opts` sets the
 * per-model curve and the number of "pending" polls before job results land.
 * State is read at request time, so the same handlers serve every test.
 */
export function createGatewayHandlers(
  respond?: GatewayResponder,
  opts: { curve?: Partial<Record<string, GatewayAlgo>>; pendingPolls?: number } = {},
): RequestHandler[] {
  if (respond) state.responder = respond;
  for (const [model, algo] of Object.entries(opts.curve ?? {})) if (algo) state.curveByModel.set(model, algo);
  if (opts.pendingPolls !== undefined) state.pendingPolls = opts.pendingPolls;
  return [attestation, chat, batch, submitJob, jobResults, webSearch, factCheckClaims];
}
