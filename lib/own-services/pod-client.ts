import { assertSameVersions, SyncVersionError, type SyncPeer } from '@/lib/sync/tables';
import type { Snapshot } from '@/lib/sync/snapshot';
import type { CommandResult, SyncCommand, SyncRequest } from '@/lib/sync/session';
import { parseServiceAddress } from './address';
import type { PodPairing } from './pod-state';

export type PodErrorCode =
  | 'unreachable' | 'refused' | 'version' | 'wrong_code' | 'pairing_closed' | 'too_many_tries'
  | 'already_paired' | 'failed' | 'phone-old' | 'server-old' | 'backup_running';

// Messages are fixed text: a token, a code or an address must never end up in one.
export class PodError extends Error {
  readonly ownServer = true;
  constructor(readonly code: PodErrorCode) {
    super(`pod request failed: ${code}`);
    this.name = 'PodError';
  }
}

export type PodStatus = { reading: 'on' | 'paused'; podName: string } & SyncPeer;
export type PairAnswer = { deviceId: string; token: string; podName: string };
type Target = Pick<PodPairing, 'baseUrl' | 'token'>;

const SHORT_MS = 15_000;
const LONG_MS = 30_000;
const KNOWN = new Set<string>(['wrong_code', 'pairing_closed', 'too_many_tries']);

/** A plain fetch to the paired host only: no cookie, no redirect, no header but the content type and the token. */
async function call<T>(target: Target | string, method: 'GET' | 'POST', path: string, body: unknown, ms: number, auth = true): Promise<T> {
  const baseUrl = typeof target === 'string' ? target : target.baseUrl;
  const addr = parseServiceAddress(baseUrl);
  if (!addr.ok) throw new PodError('failed');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth && typeof target !== 'string') headers.authorization = `Bearer ${target.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    let res: Response;
    try {
      res = await fetch(`${addr.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch {
      throw new PodError('unreachable');
    }
    if (res.status === 0 || res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new PodError('unreachable');
    if (res.status === 401) throw new PodError('refused');
    if (res.status === 409) {
      const code = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
      throw new PodError(code === 'already_paired' ? 'already_paired' : 'version');
    }
    if (!res.ok) {
      const code = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
      throw new PodError(typeof code === 'string' && KNOWN.has(code) && (res.status === 403 || res.status === 429) ? (code as PodErrorCode) : 'failed');
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new PodError(controller.signal.aborted ? 'unreachable' : 'failed');
    }
  } finally {
    clearTimeout(timer);
  }
}

export const pairWithCode = (baseUrl: string, code: string, deviceName: string): Promise<PairAnswer> =>
  call(baseUrl, 'POST', '/pair', { code: code.trim().toUpperCase(), deviceName }, SHORT_MS, false);

export const pull = (cfg: Target, request: SyncRequest): Promise<Snapshot> => call(cfg, 'POST', '/snapshot', request, LONG_MS);

export const send = (cfg: Target, commands: SyncCommand[], request: SyncRequest): Promise<{ results: CommandResult[]; snapshot?: Snapshot }> =>
  call(cfg, 'POST', '/commands', { ...request, commands }, LONG_MS);

export const status = (cfg: Target): Promise<PodStatus> => call(cfg, 'GET', '/status', undefined, SHORT_MS);

export const setReading = (cfg: Target, paused: boolean): Promise<PodStatus> => call(cfg, 'POST', '/reading', { paused }, SHORT_MS);

/** Best effort: the phone is leaving whether or not the server hears it. */
export async function revoke(cfg: Target): Promise<void> {
  try {
    await call(cfg, 'POST', '/devices/revoke', undefined, 5_000);
  } catch {
    // ignored on purpose
  }
}

export const fromSyncVersionError = (e: SyncVersionError): PodError => new PodError(e.which === 'phone' ? 'phone-old' : 'server-old');

/** Says which side is older after a version refusal. */
export async function resolveVersion(cfg: Target, local: SyncPeer): Promise<'phone-old' | 'server-old' | 'failed' | 'unreachable'> {
  let remote: PodStatus;
  try {
    remote = await status(cfg);
  } catch {
    return 'unreachable';
  }
  try {
    assertSameVersions(local, remote, 'phone');
  } catch (e) {
    if (e instanceof SyncVersionError) return fromSyncVersionError(e).code as 'phone-old' | 'server-old';
  }
  return 'failed';
}
