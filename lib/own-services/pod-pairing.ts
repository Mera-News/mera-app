import * as Device from 'expo-device';

import { requestRestart } from '@/lib/app-restart';
import appSchema from '@/lib/database/schema';
import { getSetting } from '@/lib/database/services/setting-service';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { applySnapshot } from '@/lib/sync/apply';
import { COMMAND_REGISTRY_VERSION } from '@/lib/sync/command';
import type { Snapshot } from '@/lib/sync/snapshot';
import { PAIRING_ERASED_KEY, SyncVersionError } from '@/lib/sync/tables';

import { parseServiceAddress } from './address';
import { appKeepSettingKeys } from './erase-keep';
import { OwnServiceError, parseConfirmation, type Confirmation } from './gate';
import { fromSyncVersionError, PodError, pairWithCode, pull, resolveVersion, revoke } from './pod-client';
import { leavePodMode } from './pod-runner';
import { forgetPairing, podState, savePairing, type PodPairing } from './pod-state';

const LOCAL = { schemaVersion: appSchema.version, registry: COMMAND_REGISTRY_VERSION };

type Target = Pick<PodPairing, 'baseUrl' | 'token'>;

/** The phone's model, never the name the person gave it. */
const deviceName = (): string => Device.modelName ?? 'Phone';

/** Takes the phone back out of the server's books and forgets the item, whatever happens to either. */
async function abandon(target: Target): Promise<void> {
  await revoke(target);
  await forgetPairing().catch(() => undefined);
}

/**
 * Pairs with the server, then replaces this phone's data with what the server holds, in this order so a
 * failure never leaves an empty phone: the server answers, the first snapshot is in memory, and only then
 * one writer erases and applies it. Throws a PodError (fixed message) or OwnServiceError.
 */
export async function pairAndErase(input: { baseUrl: string; code: string }, confirmation: Confirmation | undefined): Promise<void> {
  const confirmed = parseConfirmation(confirmation);
  if (!confirmed) throw new OwnServiceError('not-confirmed');
  const addr = parseServiceAddress(input.baseUrl);
  if (!addr.ok) throw new OwnServiceError('address', addr.reason);
  // A backup or restore rewrites the same tables the erase does: the two never overlap.
  const { backupOrRestoreRunning } = await import('@/lib/backup/backup-service');
  if (backupOrRestoreRunning()) throw new PodError('backup_running');

  const answer = await pairWithCode(addr.url, input.code, deviceName());
  const target: Target = { baseUrl: addr.url, token: answer.token };
  const now = Date.now();
  const item: PodPairing = {
    v: 1, baseUrl: addr.url, deviceId: answer.deviceId, token: answer.token, podName: answer.podName,
    pairedAt: now, confirmed, state: 'pending', pendingAt: now,
  };

  let first: Snapshot;
  try {
    // Stored first, so a crash after this point is cleaned up at the next start.
    await savePairing(item);
    first = await pull(target, { ...LOCAL, hashes: {} });
  } catch (e) {
    let error = e instanceof PodError ? e : new PodError('failed');
    // The 409 names the older side only in prose, so ask the server's versions while the token still works.
    if (error.code === 'version') error = new PodError(await resolveVersion(target, LOCAL));
    await abandon(target);
    throw error;
  }

  try {
    await applySnapshot(first, { local: LOCAL, erase: { keepSettingKeys: await appKeepSettingKeys() } });
  } catch (e) {
    await abandon(target);
    throw e instanceof SyncVersionError ? fromSyncVersionError(e) : new PodError('failed');
  }

  // The backups from before pairing may be the only copy of that profile: no scheduled run until the person chooses.
  const { holdBackupsAfterPairing } = await import('@/lib/backup/backup-settings');
  await holdBackupsAfterPairing();
  // Off only now: until the erase landed, the phone is as it was.
  const { setOwnAiOn } = await import('./own-ai-state');
  const { setOwnNewsOn } = await import('./own-news-state');
  await setOwnAiOn(false);
  await setOwnNewsOn(false);
  await savePairing({ ...item, state: 'active' });
  await requestRestart('pair');
}

/**
 * At start: a pending item whose erase never landed is revoked and forgotten, one whose erase landed
 * (the marker is at or after the item) becomes active.
 */
export async function settlePendingPairing(): Promise<void> {
  await podState.hydrate();
  const item = podState.get();
  if (!item || item.state !== 'pending') return;
  const erasedAt = Number(await getSetting(PAIRING_ERASED_KEY));
  if (Number.isFinite(erasedAt) && erasedAt >= (item.pendingAt ?? Infinity)) await savePairing({ ...item, state: 'active' });
  else await abandon(item);
}

async function leave(withRevoke: boolean): Promise<void> {
  const item = podState.get();
  if (item && withRevoke) await revoke(item);
  await leavePodMode();
  await forgetPairing();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isBreakerOpen } = require('@/lib/auth-failure-breaker') as typeof import('@/lib/auth-failure-breaker');
  // Back on Mera's feed at once. A phone with no account persona yet has nothing to read: feed sync would fail.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useUserStore } = require('@/lib/stores/user-store') as typeof import('@/lib/stores/user-store');
  if (!isBreakerOpen() && useUserStore.getState().userPersona) {
    void AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true }).catch(() => undefined);
  }
}

/** The phone leaves the server and keeps every row it has; the server is told on a best-effort basis. */
export const unpairPod = (): Promise<void> => leave(true);

/** The server already refused this phone, so there is nobody to tell. */
export const forgetPairingAfterRefusal = (): Promise<void> => leave(false);

/**
 * For the wipes: the phone leaves pod mode and forgets the pairing BEFORE the server is told, so a
 * wake that arrives while a slow or unreachable server holds the revoke finds nothing paired. The
 * revoke uses the item read first, is bounded and never throws; neither does anything here.
 */
export async function unpairForWipe(): Promise<void> {
  let item: PodPairing | null = null;
  try {
    await podState.hydrate();
    item = podState.get();
  } catch {
    // An unreadable keychain: nothing to tell; the wipe's keychain loop deletes the item.
  }
  try {
    await leavePodMode();
  } catch {
    // The stores' own reset leaves the mode too.
  }
  try {
    await forgetPairing();
  } catch {
    // The wipe's keychain loop deletes the item.
  }
  if (item) await revoke(item);
}
