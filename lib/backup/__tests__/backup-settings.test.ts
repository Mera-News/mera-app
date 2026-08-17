// Cadence, the Wi-Fi gate, and the scheduled task built on top of them.
//
// The interesting property is that `off` and `manual` are BOTH "the scheduler
// must not run this", for different reasons: off means the user declined, and
// manual means the user wants to press the button themselves. Collapsing them
// into "cadence !== 'off'" would silently start uploading for everyone who
// picked manual.

const mockSettings = new Map<string, string>();
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => {
    mockSettings.set(k, v);
  }),
}));

let mockNetInfoType = 'wifi';
let mockNetInfoThrows = false;
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => {
      if (mockNetInfoThrows) throw new Error('no netinfo');
      return { type: mockNetInfoType };
    }),
  },
}));

import {
  CADENCE_INTERVAL_MS,
  backupWifiOnly,
  connectionSatisfiesWifiOnly,
  hydrateBackupSettings,
  recordBackupRun,
  resetBackupSettingsMirror,
  scheduledBackupEnabled,
  scheduledBackupIsDue,
  setBackupCadence,
  setBackupProviderId,
  setBackupWifiOnly,
} from '../backup-settings';

beforeEach(() => {
  mockSettings.clear();
  resetBackupSettingsMirror();
  mockNetInfoType = 'wifi';
  mockNetInfoThrows = false;
});

describe('defaults', () => {
  it('is off and Wi-Fi-only on a device that has never been asked', async () => {
    await hydrateBackupSettings();
    expect(scheduledBackupEnabled()).toBe(false);
    // A 25 MB upload over a metered connection is a cost the user did not
    // agree to, so the absent value has to mean ON.
    expect(backupWifiOnly()).toBe(true);
  });

  it('falls back to the defaults rather than rejecting the whole startup hydration', async () => {
    const svc = require('@/lib/database/services/setting-service');
    svc.getSetting.mockRejectedValueOnce(new Error('db locked'));
    await expect(hydrateBackupSettings()).resolves.toBeUndefined();
    expect(scheduledBackupEnabled()).toBe(false);
  });

  it('reads back what was written', async () => {
    await setBackupCadence('weekly');
    await setBackupProviderId('google-drive');
    await setBackupWifiOnly(false);
    resetBackupSettingsMirror();
    await hydrateBackupSettings();
    expect(scheduledBackupEnabled()).toBe(true);
    expect(backupWifiOnly()).toBe(false);
  });
});

describe('when the scheduler may run', () => {
  it('does not run on `off`', async () => {
    await setBackupProviderId('icloud');
    await setBackupCadence('off');
    expect(scheduledBackupEnabled()).toBe(false);
  });

  it('does not run on `manual` either — the user wants to press the button', async () => {
    await setBackupProviderId('icloud');
    await setBackupCadence('manual');
    expect(scheduledBackupEnabled()).toBe(false);
  });

  it('does not run without a provider chosen', async () => {
    await setBackupCadence('daily');
    expect(scheduledBackupEnabled()).toBe(false);
  });

  it('runs immediately the first time, when there is no last run', async () => {
    await setBackupProviderId('icloud');
    await setBackupCadence('daily');
    expect(scheduledBackupIsDue(Date.now())).toBe(true);
  });

  it('waits out the cadence interval', async () => {
    await setBackupProviderId('icloud');
    await setBackupCadence('daily');
    const t0 = 1_755_000_000_000;
    await recordBackupRun(t0);
    expect(scheduledBackupIsDue(t0 + CADENCE_INTERVAL_MS.daily - 1)).toBe(false);
    expect(scheduledBackupIsDue(t0 + CADENCE_INTERVAL_MS.daily)).toBe(true);
  });

  it('gives weekly a seven-day interval, not a daily one', () => {
    expect(CADENCE_INTERVAL_MS.weekly).toBe(7 * CADENCE_INTERVAL_MS.daily);
  });
});

describe('the Wi-Fi gate', () => {
  it('accepts wifi and ethernet', async () => {
    await setBackupWifiOnly(true);
    expect(await connectionSatisfiesWifiOnly()).toBe(true);
    mockNetInfoType = 'ethernet';
    expect(await connectionSatisfiesWifiOnly()).toBe(true);
  });

  it('refuses cellular', async () => {
    await setBackupWifiOnly(true);
    mockNetInfoType = 'cellular';
    expect(await connectionSatisfiesWifiOnly()).toBe(false);
  });

  it('refuses `unknown`, which is the one that would put 25 MB on a phone plan', async () => {
    await setBackupWifiOnly(true);
    mockNetInfoType = 'unknown';
    expect(await connectionSatisfiesWifiOnly()).toBe(false);
  });

  it('refuses when NetInfo itself is unavailable — no proof of Wi-Fi is a reason to wait', async () => {
    await setBackupWifiOnly(true);
    mockNetInfoThrows = true;
    expect(await connectionSatisfiesWifiOnly()).toBe(false);
  });

  it('accepts anything once the user turns the preference off', async () => {
    await setBackupWifiOnly(false);
    mockNetInfoType = 'cellular';
    expect(await connectionSatisfiesWifiOnly()).toBe(true);
  });
});
