// The user's backup preferences, and a synchronous mirror of them.
//
// **Why the mirror exists.** `TaskCondition` with `type: 'custom'` takes a
// SYNCHRONOUS `check: () => boolean`, but every preference here lives in
// WatermelonDB behind an async read. So the values are cached in module state,
// hydrated once at startup and updated on every write. The cache is a
// consequence of the scheduler's contract, not a performance idea.
//
// **`off` is a condition, not a no-op inside the handler.** The plan called for
// unregistering the task; `AppScheduler` has `register` and no `unregister`, so
// the equivalent is a condition that fails — the job is never created rather
// than created and immediately abandoned. Worth stating because the two look
// the same from the outside and only one of them keeps the scheduler's job
// history honest.
//
// Every key here is device state and is in `FORBIDDEN_SETTING_KEYS`. Carrying
// "backup is on, daily, to iCloud" to a new device would enable a schedule
// against a provider that device may not have and a key it definitely does not
// have.

import { getSetting, setSetting } from '@/lib/database/services/setting-service';

import type { BackupCadence } from './types';

export const BACKUP_CADENCE_KEY = 'backup_cadence';
export const BACKUP_PROVIDER_KEY = 'backup_provider';
export const BACKUP_WIFI_ONLY_KEY = 'backup_wifi_only';
export const BACKUP_LAST_RUN_KEY = 'backup_last_run_at';

export type BackupProviderId = 'icloud' | 'google-drive';

/**
 * Destinations the app can write to without the user present. Every provider
 * qualifies today, and the list exists because one did not: a "save to a file"
 * destination was built and removed on 2026-08-18. A file can NEVER be
 * automated — the share sheet needs a human — and a backup nobody remembers to
 * take is not a backup. Any future destination has to answer this question
 * before it is offered.
 */
const SCHEDULABLE_PROVIDERS: readonly BackupProviderId[] = ['icloud', 'google-drive'];

export const CADENCE_INTERVAL_MS: Readonly<Record<BackupCadence, number>> = {
  off: Infinity,
  manual: Infinity,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

interface Mirror {
  cadence: BackupCadence;
  provider: BackupProviderId | null;
  wifiOnly: boolean;
  lastRunAt: number | null;
}

// Defaults are the safe ones: backup is OFF until the user turns it on, and
// Wi-Fi-only is ON, because a 25 MB upload over a metered connection is a cost
// the user did not agree to.
const mirror: Mirror = { cadence: 'off', provider: null, wifiOnly: true, lastRunAt: null };

/**
 * Hydrates the mirror. Runs inside `hydrateAllStores`' Promise.all, so it must
 * never reject — one unreadable settings row must not take the whole startup
 * hydration down. Falling back to the declared defaults is the safe outcome:
 * they say backup is off.
 */
export async function hydrateBackupSettings(): Promise<void> {
  try {
    const [cadence, provider, wifiOnly, lastRun] = await Promise.all([
      getSetting(BACKUP_CADENCE_KEY),
      getSetting(BACKUP_PROVIDER_KEY),
      getSetting(BACKUP_WIFI_ONLY_KEY),
      getSetting(BACKUP_LAST_RUN_KEY),
    ]);
    mirror.cadence = isCadence(cadence) ? cadence : 'off';
    mirror.provider = isProviderId(provider) ? provider : null;
    // Absent means ON, matching the default above — a device that has never
    // been asked must not start uploading over cellular.
    mirror.wifiOnly = wifiOnly !== '0';
    mirror.lastRunAt = lastRun ? Number(lastRun) : null;
  } catch {
    resetBackupSettingsMirror();
  }
}

function isCadence(v: string | null): v is BackupCadence {
  return v === 'off' || v === 'daily' || v === 'weekly' || v === 'manual';
}

export function backupCadence(): BackupCadence {
  return mirror.cadence;
}
export function backupProviderId(): BackupProviderId | null {
  return mirror.provider;
}
export function backupWifiOnly(): boolean {
  return mirror.wifiOnly;
}
export function backupLastRunAt(): number | null {
  return mirror.lastRunAt;
}

/**
 * True when a scheduled backup is configured at all. The scheduler condition.
 *
 * `off` and `manual` are both false and are different situations: off means the
 * user declined, manual means they want to press the button themselves.
 * Collapsing either into "cadence !== 'off'" starts uploading for people who
 * said no. The provider check is the third gate — see SCHEDULABLE_PROVIDERS.
 */
export function scheduledBackupEnabled(): boolean {
  if (mirror.cadence === 'off' || mirror.cadence === 'manual') return false;
  return mirror.provider !== null && SCHEDULABLE_PROVIDERS.includes(mirror.provider);
}

/** Whether this destination can be written to without the user present. */
export function providerIsSchedulable(provider: BackupProviderId): boolean {
  return SCHEDULABLE_PROVIDERS.includes(provider);
}

function isProviderId(v: string | null): v is BackupProviderId {
  return v === 'icloud' || v === 'google-drive';
}

/** True when enough time has passed for the configured cadence. */
export function scheduledBackupIsDue(now: number): boolean {
  if (!scheduledBackupEnabled()) return false;
  if (mirror.lastRunAt === null) return true;
  return now - mirror.lastRunAt >= CADENCE_INTERVAL_MS[mirror.cadence];
}

/**
 * Registration follows the cadence, and it is done HERE rather than at the call
 * sites so the two cannot drift. `off` and `manual` unregister the OS task
 * outright instead of leaving one that wakes up and returns early.
 *
 * Required lazily to keep a cycle out of the graph: the background task imports
 * this module for its guards.
 */
async function syncRegistration(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { syncBackupTaskRegistration } = require('@/lib/background/backup-task');
    await syncBackupTaskRegistration();
  } catch {
    // The manual button and the staleness line both still work without it.
  }
}

export async function setBackupCadence(cadence: BackupCadence): Promise<void> {
  mirror.cadence = cadence;
  await setSetting(BACKUP_CADENCE_KEY, cadence);
  await syncRegistration();
}

export async function setBackupProviderId(provider: BackupProviderId): Promise<void> {
  mirror.provider = provider;
  await setSetting(BACKUP_PROVIDER_KEY, provider);
  await syncRegistration();
}

export async function setBackupWifiOnly(wifiOnly: boolean): Promise<void> {
  mirror.wifiOnly = wifiOnly;
  await setSetting(BACKUP_WIFI_ONLY_KEY, wifiOnly ? '1' : '0');
}

export async function recordBackupRun(at: number): Promise<void> {
  mirror.lastRunAt = at;
  await setSetting(BACKUP_LAST_RUN_KEY, String(at));
}

/** Back to the declared defaults. Used by the failed-hydration path and tests. */
export function resetBackupSettingsMirror(): void {
  mirror.cadence = 'off';
  mirror.provider = null;
  mirror.wifiOnly = true;
  mirror.lastRunAt = null;
}

/**
 * Whether the current connection satisfies the Wi-Fi-only preference.
 *
 * `type === 'wifi'` is the only accepted value, deliberately. NetInfo also
 * reports `ethernet`, `vpn`, `other` and `unknown`, and `unknown` is the one
 * that matters: treating it as unmetered is how a 25 MB upload lands on a
 * cellular plan. When the user has asked for Wi-Fi only, anything we cannot
 * prove is Wi-Fi is a reason to wait.
 */
export async function connectionSatisfiesWifiOnly(): Promise<boolean> {
  if (!mirror.wifiOnly) return true;
  try {
    const NetInfo = require('@react-native-community/netinfo').default;
    const state = await NetInfo.fetch();
    return state?.type === 'wifi' || state?.type === 'ethernet';
  } catch {
    // No NetInfo means no proof of Wi-Fi, and the answer to that is to wait.
    return false;
  }
}
