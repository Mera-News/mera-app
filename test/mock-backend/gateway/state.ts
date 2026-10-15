// Mutable gateway-mock state. One object, mutated in place, so the helpers and
// the handlers always see the same references. resetGatewayState() (called by
// the integration setup's beforeEach) puts it back to a clean slate.
import type { GatewayAlgo } from './keys';
import { defaultResponder } from './responders';
import type { GatewayCall, GatewayResponder } from '../../helpers/gateway';

export interface GatewayJobRow {
  id: string;
  ok: boolean;
  /** Sealed content when ok. */
  content?: string;
  error?: string;
}

export interface GatewayJob {
  requestId: string;
  calls: GatewayCall[];
  results: GatewayJobRow[];
  polls: number;
  idempotencyKey?: string;
}

export interface GatewayViolation {
  route: string;
  rule: string;
}

export const gatewayState = {
  calls: [] as GatewayCall[],
  violations: [] as GatewayViolation[],
  attestationCount: new Map<string, number>(),
  jobs: new Map<string, GatewayJob>(),
  /** Idempotency-Key -> requestId. */
  jobKeys: new Map<string, string>(),
  curveByModel: new Map<string, GatewayAlgo>(),
  responder: defaultResponder as GatewayResponder,
  pendingPolls: 0,
  /** The reading meter on `/v1/inference/jobs` (see setReadMeter). */
  readMeter: { resetAt: null, used: null } as ReadMeter,
};

export interface ReadMeter {
  /** Epoch ms. While `now < resetAt` a fresh submit is refused. */
  resetAt: number | null;
  /** 0..1, sent as `X-Mera-Reading-Used` on every accepted fresh submit. Null sends no header. */
  used: number | null;
}

/**
 * Script the gateway's daily reading meter. While held, a fresh submit that
 * carries `X-Mera-Reading: 1` gets 429 `{ code: 'daily-quota-exceeded', resetAt }`
 * with `Retry-After` (seconds to the reset, capped at 60); one without it (an old
 * bundle) gets 402 with the same body. A replayed Idempotency-Key always answers
 * its cached 202, never charged, never refused, no header.
 */
export function setReadMeter(patch: Partial<ReadMeter>): void {
  gatewayState.readMeter = { ...gatewayState.readMeter, ...patch };
}

export function resetGatewayState(): void {
  gatewayState.calls.length = 0;
  gatewayState.violations.length = 0;
  gatewayState.attestationCount.clear();
  gatewayState.jobs.clear();
  gatewayState.jobKeys.clear();
  gatewayState.curveByModel.clear();
  gatewayState.responder = defaultResponder;
  gatewayState.pendingPolls = 0;
  gatewayState.readMeter = { resetAt: null, used: null };
}
