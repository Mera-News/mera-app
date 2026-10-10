// Backup preferences and their synchronous mirror, over the real settings table: hydrate from
// rows, the setters persist, the cadence gate, the stamps, and the Wi-Fi gate over the NetInfo edge.
//
// Replaces lib/backup/__tests__/backup-settings.test.ts (all 15 `it`). The legacy suite mocked the
// setting service with a Map; the rows are now real. Not carried over: none dropped.
//
// Not reachable at this seam: the setters' registration call (`syncBackgroundTaskRegistration`)
// stops at `TaskManager.getRegisteredTasksAsync`, which the shared expo-task-manager mock does not
// provide. The setters swallow it, so the preference still persists. lib/background owns that path.
import NetInfo from '@react-native-community/netinfo';

import database from '@/lib/database';
import {
  BACKUP_CADENCE_KEY,
  BACKUP_LAST_FAILED_KEY,
  BACKUP_LAST_RUN_KEY,
  BACKUP_PROVIDER_KEY,
  BACKUP_WIFI_ONLY_KEY,
  CADENCE_INTERVAL_MS,
  backupCadence,
  backupLastFailedAt,
  backupLastRunAt,
  backupProviderId,
  backupWifiOnly,
  connectionSatisfiesWifiOnly,
  hydrateBackupSettings,
  recordBackupFailure,
  recordBackupRun,
  resetBackupSettingsMirror,
  scheduledBackupEnabled,
  scheduledBackupIsDue,
  setBackupCadence,
  setBackupProviderId,
} from '@/lib/backup/backup-settings';
import { FORBIDDEN_SETTING_KEYS } from '@/lib/backup/allowlist';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { useStrictClock } from '@/test/helpers';

const netInfoFetch = NetInfo.fetch as unknown as jest.Mock;

beforeEach(() => {
  resetBackupSettingsMirror();
});

describe('defaults', () => {
  it('is off, with no provider and Wi-Fi-only on, on a device that has never been asked', async () => {
    await hydrateBackupSettings();
    expect(backupCadence()).toBe('off');
    expect(backupProviderId()).toBeNull();
    expect(backupLastRunAt()).toBeNull();
    expect(backupLastFailedAt()).toBeNull();
    expect(scheduledBackupEnabled()).toBe(false);
  });

  it('falls back to the defaults rather than rejecting the whole startup hydration', async () => {
    await setSetting(BACKUP_CADENCE_KEY, 'daily');
    await setSetting(BACKUP_PROVIDER_KEY, 'icloud');
    await hydrateBackupSettings();
    expect(scheduledBackupEnabled()).toBe(true);

    // an unreadable settings table: hydrate runs inside hydrateAllStores' Promise.all
    const spy = jest.spyOn(database.get('settings'), 'query').mockImplementation((() => {
      throw new Error('db locked');
    }) as never);
    try {
      await expect(hydrateBackupSettings()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(scheduledBackupEnabled()).toBe(false);
    expect(backupCadence()).toBe('off');
  });
});

describe('the mirror is hydrated from the rows', () => {
  it('reads every preference and both stamps', async () => {
    await setSetting(BACKUP_CADENCE_KEY, 'weekly');
    await setSetting(BACKUP_PROVIDER_KEY, 'google-drive');
    await setSetting(BACKUP_LAST_RUN_KEY, '1755000000000');
    await setSetting(BACKUP_LAST_FAILED_KEY, '1755000099000');

    await hydrateBackupSettings();

    expect(backupCadence()).toBe('weekly');
    expect(backupProviderId()).toBe('google-drive');
    expect(backupLastRunAt()).toBe(1_755_000_000_000);
    expect(backupLastFailedAt()).toBe(1_755_000_099_000);
    expect(scheduledBackupEnabled()).toBe(true);
  });

  it('treats an unrecognised cadence or provider as the safe default', async () => {
    await setSetting(BACKUP_CADENCE_KEY, 'hourly');
    await setSetting(BACKUP_PROVIDER_KEY, 'dropbox');
    await hydrateBackupSettings();
    expect(backupCadence()).toBe('off');
    expect(backupProviderId()).toBeNull();
  });

  it('shows a failure only while it is newer than the last success', async () => {
    await setSetting(BACKUP_LAST_RUN_KEY, '2000');
    await setSetting(BACKUP_LAST_FAILED_KEY, '1000');
    await hydrateBackupSettings();
    expect(backupLastFailedAt()).toBeNull();

    await setSetting(BACKUP_LAST_FAILED_KEY, '3000');
    await hydrateBackupSettings();
    expect(backupLastFailedAt()).toBe(3000);
  });

  it('resets to the declared defaults', async () => {
    await setSetting(BACKUP_CADENCE_KEY, 'daily');
    await setSetting(BACKUP_PROVIDER_KEY, 'icloud');
    await hydrateBackupSettings();
    resetBackupSettingsMirror();
    expect(backupCadence()).toBe('off');
    expect(backupProviderId()).toBeNull();
    expect(backupLastRunAt()).toBeNull();
    expect(backupLastFailedAt()).toBeNull();
  });
});

describe('the setters persist', () => {
  it('writes the cadence and the provider to their rows and reads them back after a cold start', async () => {
    await setBackupCadence('weekly');
    await setBackupProviderId('google-drive');

    expect(await getSetting(BACKUP_CADENCE_KEY)).toBe('weekly');
    expect(await getSetting(BACKUP_PROVIDER_KEY)).toBe('google-drive');

    resetBackupSettingsMirror();
    await hydrateBackupSettings();
    expect(scheduledBackupEnabled()).toBe(true);
    expect(backupCadence()).toBe('weekly');
    expect(backupProviderId()).toBe('google-drive');
  });

  it('updates the mirror at once, before any re-read', async () => {
    await setBackupProviderId('icloud');
    await setBackupCadence('daily');
    expect(backupCadence()).toBe('daily');
    expect(backupProviderId()).toBe('icloud');
  });

  it('keeps every backup preference and stamp off the backup (device schedule state)', () => {
    for (const key of [
      BACKUP_CADENCE_KEY,
      BACKUP_PROVIDER_KEY,
      BACKUP_WIFI_ONLY_KEY,
      BACKUP_LAST_RUN_KEY,
      BACKUP_LAST_FAILED_KEY,
    ]) {
      expect(FORBIDDEN_SETTING_KEYS).toHaveProperty(key);
    }
  });
});

describe('when the scheduler may run', () => {
  it('does not run on `off`', async () => {
    await setBackupProviderId('icloud');
    await setBackupCadence('off');
    expect(scheduledBackupEnabled()).toBe(false);
  });

  it('does not run on `manual` either: the user wants to press the button', async () => {
    await setBackupProviderId('icloud');
    await setBackupCadence('manual');
    expect(scheduledBackupEnabled()).toBe(false);
  });

  it('does not run without a provider chosen', async () => {
    await setBackupCadence('daily');
    expect(scheduledBackupEnabled()).toBe(false);
  });

  it('is never due while it may not run, however long ago the last backup was', async () => {
    await setBackupProviderId('icloud');
    await setBackupCadence('manual');
    expect(scheduledBackupIsDue(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('runs immediately the first time, when there is no last run', async () => {
    useStrictClock('2026-10-01T09:00:00.000Z');
    await setBackupProviderId('icloud');
    await setBackupCadence('daily');
    expect(scheduledBackupIsDue(Date.now())).toBe(true);
  });

  it('waits out the cadence interval after a stamped run', async () => {
    useStrictClock('2026-10-01T09:00:00.000Z');
    await setBackupProviderId('icloud');
    await setBackupCadence('daily');
    const t0 = Date.now();
    await recordBackupRun(t0);

    expect(scheduledBackupIsDue(t0 + CADENCE_INTERVAL_MS.daily - 1)).toBe(false);
    expect(scheduledBackupIsDue(t0 + CADENCE_INTERVAL_MS.daily)).toBe(true);
  });

  it('gives weekly a seven-day interval, not a daily one', async () => {
    expect(CADENCE_INTERVAL_MS.weekly).toBe(7 * CADENCE_INTERVAL_MS.daily);
    await setBackupProviderId('google-drive');
    await setBackupCadence('weekly');
    await recordBackupRun(1_000);
    expect(scheduledBackupIsDue(1_000 + CADENCE_INTERVAL_MS.daily)).toBe(false);
    expect(scheduledBackupIsDue(1_000 + CADENCE_INTERVAL_MS.weekly)).toBe(true);
  });

  it('does not run again until the stamp is older than the interval, after a restart', async () => {
    await setBackupProviderId('icloud');
    await setBackupCadence('daily');
    await recordBackupRun(5_000);
    resetBackupSettingsMirror();
    await hydrateBackupSettings();
    expect(scheduledBackupIsDue(5_000 + 1)).toBe(false);
  });
});

describe('the stamps', () => {
  it('records a finished run in the row and the mirror', async () => {
    await recordBackupRun(1_755_000_000_000);
    expect(await getSetting(BACKUP_LAST_RUN_KEY)).toBe('1755000000000');
    expect(backupLastRunAt()).toBe(1_755_000_000_000);
  });

  it('records a failed attempt, and a later success clears it from the status', async () => {
    await recordBackupFailure(2_000);
    expect(await getSetting(BACKUP_LAST_FAILED_KEY)).toBe('2000');
    expect(backupLastFailedAt()).toBe(2_000);

    await recordBackupRun(3_000);
    expect(backupLastFailedAt()).toBeNull();
    // the row stays; only the status reading changes
    expect(await getSetting(BACKUP_LAST_FAILED_KEY)).toBe('2000');
  });
});

describe('the Wi-Fi gate (NetInfo edge)', () => {
  const link = (type: string) => netInfoFetch.mockResolvedValueOnce({ type });

  it('accepts wifi and ethernet', async () => {
    link('wifi');
    expect(await connectionSatisfiesWifiOnly()).toBe(true);
    link('ethernet');
    expect(await connectionSatisfiesWifiOnly()).toBe(true);
  });

  it('refuses cellular', async () => {
    link('cellular');
    expect(await connectionSatisfiesWifiOnly()).toBe(false);
  });

  it('refuses `unknown`, which is the one that would put 25 MB on a phone plan', async () => {
    link('unknown');
    expect(await connectionSatisfiesWifiOnly()).toBe(false);
  });

  it('refuses when NetInfo itself fails: no proof of Wi-Fi is a reason to wait', async () => {
    netInfoFetch.mockRejectedValueOnce(new Error('no netinfo'));
    expect(await connectionSatisfiesWifiOnly()).toBe(false);
  });

  it('accepts anything once the stored preference says Wi-Fi-only is off, without asking NetInfo', async () => {
    await setSetting(BACKUP_WIFI_ONLY_KEY, '0');
    await hydrateBackupSettings();
    expect(await connectionSatisfiesWifiOnly()).toBe(true);
    expect(netInfoFetch).not.toHaveBeenCalled();
  });
});

describe('[dead-candidate] helpers with no caller outside this file', () => {
  it('[dead-candidate] backupWifiOnly defaults to ON, so a cellular upload is never silent', async () => {
    await hydrateBackupSettings();
    expect(backupWifiOnly()).toBe(true);
  });
});
