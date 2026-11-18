import { parseServiceAddress } from './address';
import { guardTurnOn, OwnServiceError, parseConfirmation, type Confirmation } from './gate';
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
  /** Set only by the confirm's affirmative button; cleared with every new address, model or key. */
  confirmed: Confirmation | null;
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
      // An item that says on without a confirmation was never turned on through the confirm: it stays off.
      on: r.on && parseConfirmation(r.confirmed) !== null,
      confirmed: parseConfirmation(r.confirmed),
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
  await ownAiState.save({ v: 1, baseUrl: addr.url, model: f.model, key: f.key, on: false, checkedAt: null, status: null, confirmed: null });
}

export async function recordOwnAiCheck(status: AiCheckStatus): Promise<void> {
  await ownAiState.hydrate();
  const cur = ownAiState.get();
  if (cur) await ownAiState.save({ ...cur, status, checkedAt: Date.now() });
}

/** Turning on needs the person's confirmation for this address: given now, or kept from an earlier turn-on. */
export async function setOwnAiOn(on: boolean, confirmation?: Confirmation): Promise<void> {
  await ownAiState.hydrate();
  const cur = ownAiState.get();
  if (on) guardTurnOn(cur?.status);
  if (!cur) return;
  const confirmed = confirmation ?? cur.confirmed;
  if (on && !confirmed) throw new OwnServiceError('not-confirmed');
  await ownAiState.save({ ...cur, on, confirmed });
  if (on) {
    // So no gateway run is collected after the switch. Lazy: the pipeline reaches the database at import.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { abortRun } = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');
    await abortRun('own-ai');
  }
}

export const forgetOwnAi = (): Promise<void> => ownAiState.clear();
