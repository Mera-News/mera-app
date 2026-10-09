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
};

export function resetGatewayState(): void {
  gatewayState.calls.length = 0;
  gatewayState.violations.length = 0;
  gatewayState.attestationCount.clear();
  gatewayState.jobs.clear();
  gatewayState.jobKeys.clear();
  gatewayState.curveByModel.clear();
  gatewayState.responder = defaultResponder;
  gatewayState.pendingPolls = 0;
}
