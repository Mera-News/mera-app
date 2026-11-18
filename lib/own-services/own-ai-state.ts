import { parseServiceAddress } from './address';
import { guardTurnOn, OwnServiceError } from './gate';
import { OWN_AI_KEY } from './keys';
import { createServiceState } from './service-state';

export type AiCheckStatus =
  | 'connected'
  | 'refused'
  | 'unreachable'
  | 'not-openai'
  | 'no-model'
  | 'redirect'
  | 'busy'
  | 'failing';

export type OwnAiConfig = {
  v: 1;
  baseUrl: string;
  model: string;
  key: string | null;
  on: boolean;
  checkedAt: number | null;
  status: AiCheckStatus | null;
};

export const ownAiState = createServiceState<OwnAiConfig>({
  key: OWN_AI_KEY,
  kind: 'ownAi',
  parse(raw) {
    const r = raw as Partial<OwnAiConfig> | null;
    if (!r || r.v !== 1 || typeof r.baseUrl !== 'string' || typeof r.model !== 'string' || typeof r.on !== 'boolean') return null;
    return {
      v: 1,
      baseUrl: r.baseUrl,
      model: r.model,
      key: typeof r.key === 'string' ? r.key : null,
      on: r.on,
      checkedAt: typeof r.checkedAt === 'number' ? r.checkedAt : null,
      status: (r.status as AiCheckStatus | null) ?? null,
    };
  },
  secrets(v) {
    const host = parseServiceAddress(v.baseUrl);
    return { hosts: host.ok ? [host.host] : [], secrets: v.key ? [v.key] : [] };
  },
});

export const ownAiOn = (): boolean => ownAiState.isHydrated() && ownAiState.get()?.on === true;

export async function saveOwnAiFields(f: { baseUrl: string; model: string; key: string | null }): Promise<void> {
  const addr = parseServiceAddress(f.baseUrl);
  if (!addr.ok) throw new OwnServiceError('address', addr.reason);
  await ownAiState.hydrate();
  const cur = ownAiState.get();
  if (cur && cur.baseUrl === addr.url && cur.model === f.model && cur.key === f.key) return;
  await ownAiState.save({ v: 1, baseUrl: addr.url, model: f.model, key: f.key, on: false, checkedAt: null, status: null });
}

export async function recordOwnAiCheck(status: AiCheckStatus): Promise<void> {
  await ownAiState.hydrate();
  const cur = ownAiState.get();
  if (cur) await ownAiState.save({ ...cur, status, checkedAt: Date.now() });
}

export async function setOwnAiOn(on: boolean): Promise<void> {
  await ownAiState.hydrate();
  const cur = ownAiState.get();
  if (on) guardTurnOn(cur?.status);
  if (!cur) return;
  await ownAiState.save({ ...cur, on });
  if (on) {
    // So no gateway run is collected after the switch. Lazy: the pipeline reaches the database at import.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { abortRun } = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');
    await abortRun('own-ai');
  }
}

export const forgetOwnAi = (): Promise<void> => ownAiState.clear();
