// Test-facing API of the inference gateway mock (test/mock-backend/gateway/).
//
//   server.use(...mockGateway((call) => 'hello'));               // streamed or buffered, sealed both ways
//   server.use(...mockGateway(respond, { curve: { [BIG_MODEL]: 'ecdsa' } }));
//   gatewayCalls('chat')[0].messages                             // what the model saw, decrypted
//
// The default handler set already serves the default responder, so a test only
// calls mockGateway() when it scripts replies. Attestation faults are not
// scripted through the responder: override the route directly,
//   server.use(http.get('*/api/attestation/report', () => new HttpResponse('Unauthorized', { status: 401 })));
// Every request is decrypted with the real lib/e2ee/e2ee-crypto.ts; anything
// the real gateway/NEAR would refuse (bad headers, a cleartext tool field,
// content that does not open) is answered 500/400 AND recorded as a violation.
import type { RequestHandler } from 'msw';
import { createGatewayHandlers } from '../mock-backend/gateway/handlers';
import { defaultResponder } from '../mock-backend/gateway/responders';
import { gatewayState } from '../mock-backend/gateway/state';

export type GatewayRoute = 'chat' | 'batch' | 'job' | 'web-search' | 'fact-check-claims';

export interface GatewayCall {
  route: GatewayRoute;
  model: string;
  stream: boolean;
  /** Curve of the envelope. Always 'ed25519' on the plaintext search routes (n/a). */
  algo: 'ed25519' | 'ecdsa';
  /** Decrypted. On the search routes: one user message holding the query. */
  messages: { role: string; content: string }[];
  /** Job calls: the `BatchCall.id` (`score:N`, `reason:<id>`). Unset on chat and batch (batch items carry no id on the wire). */
  callId?: string;
  /** Lower-case keys. */
  headers: Record<string, string>;
  /** 0-based sequence number among the calls of the same route (a job call: among all job calls). */
  index: number;
  /** The request's signal fired (hedge loser, Stop, timeout). */
  aborted: boolean;
}

/**
 * What the mock does with a call:
 * - a string: the whole reply (streamed as ONE chunk when `stream: true`);
 * - `chunks`: streamed chunk by chunk (joined when `stream: false` or `ignoreStream`);
 *   `headerDelayMs` before headers, `chunkDelayMs` between chunks, `stallAfter` N chunks then silence,
 *   `closeAfter` N chunks then the body errors, `reasoning` sends a reasoning_content chunk first;
 * - `{ status }`: a raw unencrypted response (429 + Retry-After, 401, 502, 503, 400 Decryption failed ...).
 *   On the batch route it fails the whole request; on a job call it becomes that call's `ok: false` row.
 * Web-search and fact-check-claims replies are JSON text: an array of results, or an object
 * such as `{"code":"search-unavailable"}` (a per-query verdict on a batched search).
 */
export type GatewayReply =
  | string
  | {
      chunks: string[];
      reasoning?: boolean;
      finishReason?: 'stop' | 'tool_calls' | 'length';
      headerDelayMs?: number;
      chunkDelayMs?: number;
      stallAfter?: number;
      closeAfter?: number;
      ignoreStream?: boolean;
    }
  | { status: number; body?: unknown; headers?: Record<string, string> };

export type GatewayResponder = (call: GatewayCall) => GatewayReply;

export { defaultResponder };

/** Install `respond` for this test and return the gateway handlers for `server.use(...)`. */
export function mockGateway(
  respond: GatewayResponder,
  opts: { curve?: Partial<Record<string, 'ed25519' | 'ecdsa'>>; pendingPolls?: number } = {},
): RequestHandler[] {
  return createGatewayHandlers(respond, opts);
}

/** Decrypted calls the model side received, in arrival order. Live objects (`aborted` updates). */
export function gatewayCalls(route?: GatewayRoute): GatewayCall[] {
  return route ? gatewayState.calls.filter((c) => c.route === route) : [...gatewayState.calls];
}

/** Hot-path attestation requests (no nonce) received, for one model or all. */
export function attestationRequests(model?: string): number {
  if (model !== undefined) return gatewayState.attestationCount.get(model) ?? 0;
  let n = 0;
  for (const v of gatewayState.attestationCount.values()) n += v;
  return n;
}

export interface GatewayViolation {
  route: string;
  rule: string;
}

/** Everything the mock refused on E2EE grounds this test. */
export function gatewayViolations(): GatewayViolation[] {
  return [...gatewayState.violations];
}

/** Returns and clears the violations: for a test that provokes one on purpose. */
export function takeGatewayViolations(): GatewayViolation[] {
  return gatewayState.violations.splice(0);
}

/** For an `afterEach`: fails the test when the app sent the gateway anything it must not. */
export function assertNoGatewayViolations(): void {
  const v = gatewayState.violations;
  if (v.length) throw new Error('Gateway E2EE violations:\n' + v.map((x) => `${x.route}: ${x.rule}`).join('\n'));
}
