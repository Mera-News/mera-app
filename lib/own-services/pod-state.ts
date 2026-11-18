import { parseServiceAddress } from './address';
import { OwnServiceError } from './gate';
import { POD_PAIRING_KEY } from './keys';
import { createServiceState } from './service-state';

// The token is the only credential; the server keeps only its hash.
export type PodPairing = { v: 1; baseUrl: string; deviceId: string; token: string; podName: string; pairedAt: number };

export const podState = createServiceState<PodPairing>({
  key: POD_PAIRING_KEY,
  kind: 'pod',
  parse(raw) {
    const r = raw as Partial<PodPairing> | null;
    if (!r || r.v !== 1 || typeof r.baseUrl !== 'string' || typeof r.token !== 'string' || !r.token) return null;
    const addr = parseServiceAddress(r.baseUrl);
    if (!addr.ok) return null;
    return {
      v: 1,
      baseUrl: addr.url,
      deviceId: String(r.deviceId ?? ''),
      token: r.token,
      podName: String(r.podName ?? ''),
      pairedAt: typeof r.pairedAt === 'number' ? r.pairedAt : 0,
    };
  },
  secrets(v) {
    const host = parseServiceAddress(v.baseUrl);
    return { hosts: host.ok ? [host.host] : [], secrets: [v.token] };
  },
});

// The mode is the presence of the item: nothing inside it turns it on or off.
export const podPaired = (): boolean => podState.isHydrated() && podState.get() !== null;

export function podHost(): string | null {
  const v = podState.get();
  const addr = v ? parseServiceAddress(v.baseUrl) : null;
  return addr?.ok ? addr.host : null;
}

export const podConfig = (): PodPairing | null => podState.get();

export async function savePairing(p: PodPairing): Promise<void> {
  const addr = parseServiceAddress(p.baseUrl);
  if (!addr.ok) throw new OwnServiceError('address', addr.reason);
  await podState.save({ ...p, baseUrl: addr.url });
}

export const forgetPairing = (): Promise<void> => podState.clear();
