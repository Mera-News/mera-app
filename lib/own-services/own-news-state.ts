import { parseServiceAddress } from './address';
import { guardTurnOn, OwnServiceError } from './gate';
import { OWN_NEWS_KEY } from './keys';
import { createServiceState } from './service-state';

export type NewsCheckStatus = 'connected' | 'refused' | 'unreachable' | 'no-feed' | 'redirect';

export type OwnNewsConfig = {
  v: 1;
  baseUrl: string;
  key: string | null;
  on: boolean;
  checkedAt: number | null;
  status: NewsCheckStatus | null;
  fields: string[] | null;
};

export const ownNewsState = createServiceState<OwnNewsConfig>({
  key: OWN_NEWS_KEY,
  kind: 'ownNews',
  parse(raw) {
    const r = raw as Partial<OwnNewsConfig> | null;
    if (!r || r.v !== 1 || typeof r.baseUrl !== 'string' || typeof r.on !== 'boolean') return null;
    return {
      v: 1,
      baseUrl: r.baseUrl,
      key: typeof r.key === 'string' ? r.key : null,
      on: r.on,
      checkedAt: typeof r.checkedAt === 'number' ? r.checkedAt : null,
      status: (r.status as NewsCheckStatus | null) ?? null,
      fields: Array.isArray(r.fields) ? r.fields.filter((f): f is string => typeof f === 'string') : null,
    };
  },
  secrets(v) {
    const host = parseServiceAddress(v.baseUrl);
    return { hosts: host.ok ? [host.host] : [], secrets: v.key ? [v.key] : [] };
  },
});

export const ownNewsOn = (): boolean => ownNewsState.isHydrated() && ownNewsState.get()?.on === true;

export function graphqlUrlFor(baseUrl: string): string {
  return baseUrl.endsWith('/graphql') ? baseUrl : `${baseUrl}/graphql`;
}

export function ownNewsRoute(): { graphqlUrl: string; key: string | null } | null {
  const v = ownNewsState.get();
  return ownNewsState.isHydrated() && v?.on ? { graphqlUrl: graphqlUrlFor(v.baseUrl), key: v.key } : null;
}

export async function saveOwnNewsFields(f: { baseUrl: string; key: string | null }): Promise<void> {
  const addr = parseServiceAddress(f.baseUrl);
  if (!addr.ok) throw new OwnServiceError('address', addr.reason);
  await ownNewsState.hydrate();
  const cur = ownNewsState.get();
  if (cur && cur.baseUrl === addr.url && cur.key === f.key) return;
  await ownNewsState.save({ v: 1, baseUrl: addr.url, key: f.key, on: false, checkedAt: null, status: null, fields: null });
}

export async function recordOwnNewsCheck(status: NewsCheckStatus, fields: string[] | null): Promise<void> {
  await ownNewsState.hydrate();
  const cur = ownNewsState.get();
  if (cur) await ownNewsState.save({ ...cur, status, fields, checkedAt: Date.now() });
}

export async function setOwnNewsOn(on: boolean): Promise<void> {
  await ownNewsState.hydrate();
  const cur = ownNewsState.get();
  if (on) guardTurnOn(cur?.status);
  if (cur) await ownNewsState.save({ ...cur, on });
}

export const forgetOwnNews = (): Promise<void> => ownNewsState.clear();
