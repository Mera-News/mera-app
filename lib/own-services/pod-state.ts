import { parseServiceAddress } from './address';
import { OwnServiceError, parseConfirmation, type Confirmation } from './gate';
import { POD_PAIRING_KEY } from './keys';
import { createServiceState } from './service-state';

/** What the phone keeps about the wake-up pass it handed the server. Never the pass itself. */
export type WakeRecord = {
  /** Unix seconds. */
  expiresAt?: number;
  tokenHash?: string;
  mintedAt?: number;
  /** When the last refusal came and how long to leave the pass alone after it, in ms. */
  refusedAt?: number;
  waitMs?: number;
  /** Wake-ups were turned off and the server has not yet said it dropped the pass. */
  offPending?: boolean;
};

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseWake(raw: unknown): WakeRecord | null {
  const r = raw as Partial<WakeRecord> | null;
  if (!r || typeof r !== 'object') return null;
  return {
    ...(num(r.expiresAt) ? { expiresAt: r.expiresAt } : {}),
    ...(typeof r.tokenHash === 'string' ? { tokenHash: r.tokenHash } : {}),
    ...(num(r.mintedAt) ? { mintedAt: r.mintedAt } : {}),
    ...(num(r.refusedAt) ? { refusedAt: r.refusedAt } : {}),
    ...(num(r.waitMs) ? { waitMs: r.waitMs } : {}),
    ...(r.offPending === true ? { offPending: true } : {}),
  };
}

// The token is the only credential; the server keeps only its hash.
// A pending item exists between the server accepting the phone and the erase landing: it routes nothing.
export type PodPairing = {
  v: 1;
  baseUrl: string;
  deviceId: string;
  token: string;
  podName: string;
  pairedAt: number;
  confirmed: Confirmation;
  state: 'pending' | 'active';
  /** When a pending item was stored, to tell whether the erase marker is from this pairing. */
  pendingAt?: number;
  /** The person's choice to let the server wake the phone with a push. Off unless true. */
  wakeups?: boolean;
  wake?: WakeRecord;
};

export const podState = createServiceState<PodPairing>({
  key: POD_PAIRING_KEY,
  kind: 'pod',
  parse(raw) {
    const r = raw as Partial<PodPairing> | null;
    if (!r || r.v !== 1 || typeof r.baseUrl !== 'string' || typeof r.token !== 'string' || !r.token) return null;
    const addr = parseServiceAddress(r.baseUrl);
    if (!addr.ok) return null;
    const confirmed = parseConfirmation(r.confirmed);
    if (!confirmed || (r.state !== 'pending' && r.state !== 'active')) return null;
    return {
      v: 1,
      baseUrl: addr.url,
      deviceId: String(r.deviceId ?? ''),
      token: r.token,
      podName: String(r.podName ?? ''),
      pairedAt: typeof r.pairedAt === 'number' ? r.pairedAt : 0,
      confirmed,
      state: r.state,
      ...(typeof r.pendingAt === 'number' ? { pendingAt: r.pendingAt } : {}),
      ...(r.wakeups === true ? { wakeups: true } : {}),
      ...(parseWake(r.wake) ? { wake: parseWake(r.wake)! } : {}),
    };
  },
  secrets(v) {
    const host = parseServiceAddress(v.baseUrl);
    return { hosts: host.ok ? [host.host] : [], secrets: [v.token] };
  },
});

// The mode is an active item: a pending one has not been erased into yet and routes nothing.
export const podPaired = (): boolean => podState.isHydrated() && podState.get()?.state === 'active';

const active = (): PodPairing | null => (podPaired() ? podState.get() : null);

export function podHost(): string | null {
  const v = active();
  const addr = v ? parseServiceAddress(v.baseUrl) : null;
  return addr?.ok ? addr.host : null;
}

export const podConfig = (): PodPairing | null => active();

export async function savePairing(p: PodPairing): Promise<void> {
  if (!parseConfirmation(p.confirmed)) throw new OwnServiceError('not-confirmed');
  const addr = parseServiceAddress(p.baseUrl);
  if (!addr.ok) throw new OwnServiceError('address', addr.reason);
  await podState.save({ ...p, baseUrl: addr.url });
}

export const forgetPairing = (): Promise<void> => podState.clear();
