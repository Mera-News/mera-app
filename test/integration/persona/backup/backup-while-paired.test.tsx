// While the phone is paired with the person's own server, nothing backs up and nothing restores, on the
// real backup stack: settings table, key store, the real export, the iCloud provider over the cloud-storage
// fake. Only the native edges are stand-ins. Every request to the provider is counted.
jest.mock('expo-task-manager', () => require('../../data/background/native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('../../data/background/native-fakes').backgroundTaskModule);
jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@dr.pogodin/react-native-fs', () => require('../../data/backup/fakes').rnfsModule);
jest.mock('react-native-cloud-storage', () => require('../../data/backup/fakes').cloudStorageModule);
// RN Modal pulls an untransformed native spec in jest.
jest.mock('react-native/Libraries/Modal/Modal', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null),
  };
});

import NetInfo from '@react-native-community/netinfo';
import * as Sentry from '@sentry/react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';

import BackupSection from '@/components/custom/backup/BackupSection';
import {
  BACKUP_CADENCE_KEY,
  BACKUP_LAST_FAILED_KEY,
  BACKUP_LAST_RUN_KEY,
  BACKUP_PROVIDER_KEY,
  BACKUP_WIFI_ONLY_KEY,
} from '@/lib/backup/backup-settings';
import { listBackups, runBackup, runRestore } from '@/lib/backup/backup-service';
import { ensureBackupKey, markRecoveryCodeConfirmed } from '@/lib/backup/key-store';
import { googleDriveProvider } from '@/lib/backup/providers/google-drive';
import { icloudProvider } from '@/lib/backup/providers/icloud';
import { backupIntervalMinutes, runScheduledBackup } from '@/lib/background/backup-task';
import { runBackgroundWake } from '@/lib/background/background-task';
import { addFact } from '@/lib/database/services/fact-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { advanceUntilDone, fakePod, initI18nEn, podPairing, setAppState } from '@/test/helpers';
import { resetFileSystem } from '@/test/helpers/fs';

import { remoteNames, resetFakes, shared } from '../../data/backup/fakes';
import { resetNativeTasks } from '../../data/background/native-fakes';
import { HOUR, NOW, wakeCleanup, wakeWorld } from '../../data/background/support';

jest.setTimeout(60_000);

const LINE = 'Backups are off while this phone is paired with your server. Your earlier backups stay where they are.';
const SETTING_KEYS = [BACKUP_CADENCE_KEY, BACKUP_PROVIDER_KEY, BACKUP_WIFI_ONLY_KEY, BACKUP_LAST_RUN_KEY, BACKUP_LAST_FAILED_KEY];

beforeAll(initI18nEn);
beforeEach(async () => {
  resetNativeTasks();
  resetFakes();
  resetFileSystem();
  podState.resetMemory();
  (NetInfo.fetch as jest.Mock).mockReset().mockResolvedValue({ type: 'wifi', isConnected: true });
  await wakeWorld();
});
afterEach(async () => {
  await forgetPairing();
  podState.resetMemory();
  await wakeCleanup();
});

async function setUpBackup(over: { lastRunAt?: number } = {}): Promise<void> {
  await ensureBackupKey();
  await markRecoveryCodeConfirmed();
  await setSetting(BACKUP_CADENCE_KEY, 'daily');
  await setSetting(BACKUP_PROVIDER_KEY, 'icloud');
  await setSetting(BACKUP_WIFI_ONLY_KEY, '1');
  if (over.lastRunAt !== undefined) await setSetting(BACKUP_LAST_RUN_KEY, String(over.lastRunAt));
  await addFact('I follow racing');
}
const pair = (state: 'active' | 'pending' = 'active') => savePairing(podPairing({ state, ...(state === 'pending' ? { pendingAt: 5 } : {}) }));
const settingsNow = async () => Object.fromEntries(await Promise.all(SETTING_KEYS.map(async (k) => [k, await getSetting(k)])));
const providerCalls = () => shared.calls.length;
const run = () => advanceUntilDone(runScheduledBackup());
const sentry = () => (Sentry.captureException as jest.Mock).mock.calls;

describe('the service refuses while paired', () => {
  it.each([
    ['iCloud', icloudProvider],
    ['Google Drive', googleDriveProvider],
  ])('a manual backup to %s throws "paired" and touches the provider not at all', async (_n, provider) => {
    await setUpBackup();
    await pair();
    await expect(runBackup(provider)).rejects.toMatchObject({ name: 'BackupServiceError', reason: 'paired' });
    await expect(runRestore(provider, 'x')).rejects.toMatchObject({ reason: 'paired' });
    expect(providerCalls()).toBe(0);
    expect(remoteNames()).toEqual([]);
  });

  it('a restore throws "paired" and downloads nothing', async () => {
    await setUpBackup();
    await runBackup(icloudProvider);
    const [remote] = await listBackups(icloudProvider);
    await pair();
    shared.calls.length = 0;
    await expect(runRestore(icloudProvider, remote)).rejects.toMatchObject({ reason: 'paired' });
    expect(providerCalls()).toBe(0);
  });

  it('a due scheduled backup does nothing, stamps no failure and files no report', async () => {
    await setUpBackup();
    await pair();
    await run();
    expect(providerCalls()).toBe(0);
    expect(await getSetting(BACKUP_LAST_RUN_KEY)).toBeNull();
    expect(await getSetting(BACKUP_LAST_FAILED_KEY)).toBeNull();
    expect(sentry()).toEqual([]);
  });

  it('the same inside a whole background wake', async () => {
    await setUpBackup();
    fakePod({ token: podPairing().token });
    await pair();
    await advanceUntilDone(runBackgroundWake());
    expect(providerCalls()).toBe(0);
    expect(await getSetting(BACKUP_LAST_FAILED_KEY)).toBeNull();
    expect(await getSetting(BACKUP_CADENCE_KEY)).toBe('daily');
  });

  it('pairing and the guard leave every backup setting alone and keep earlier backups', async () => {
    await setUpBackup({ lastRunAt: NOW - 3 * HOUR });
    await runBackup(icloudProvider);
    const before = await settingsNow();
    const kept = remoteNames();
    expect(kept).toHaveLength(1);

    await pair();
    await run();
    await expect(runBackup(icloudProvider)).rejects.toMatchObject({ reason: 'paired' });

    expect(await settingsNow()).toEqual(before);
    expect(remoteNames()).toEqual(kept);
    expect(shared.calls.some((c) => c.name === 'unlink' || c.name === 'remove')).toBe(false);
  });
});

describe('a pairing in progress and a backup never overlap', () => {
  it('while a pairing is pending (between the server answering and the erase), a restore and a backup are refused', async () => {
    await setUpBackup();
    await pair('pending');
    await expect(runBackup(icloudProvider)).rejects.toMatchObject({ reason: 'paired' });
    await expect(runRestore(icloudProvider, 'x')).rejects.toMatchObject({ reason: 'paired' });
    expect(providerCalls()).toBe(0);
  });

  it('while a backup runs, pairing is refused before anything is sent to the server', async () => {
    await setUpBackup();
    const pod = fakePod();
    const { pairAndErase } = await import('@/lib/own-services/pod-pairing');
    // The backup is under way (it counts itself running before its first await) when pairing starts.
    const backup = runBackup(icloudProvider);
    await expect(pairAndErase({ baseUrl: 'https://pod.own.test', code: 'K7Q2M9XD' }, { at: 1, privacyVersion: null })).rejects.toMatchObject({ code: 'backup_running' });
    await backup;
    expect(pod.requests).toEqual([]);
    expect(remoteNames()).toHaveLength(1);
  });
});

describe('pairing from the code page while a backup runs', () => {
  it('says a backup or restore is running, and sends nothing to the server', async () => {
    await setUpBackup();
    const pod = fakePod();
    // A provider that has not answered yet keeps the backup running.
    let answer!: (v: boolean) => void;
    const slow = { ...icloudProvider, isAvailable: () => new Promise<boolean>((r) => (answer = r)) };
    const backup = runBackup(slow).catch(() => undefined);
    const { default: PodCodeScreen } = await import('@/components/custom/config-mera/own-services/PodCodeScreen');
    const { settleDialog, useDialogQueue } = await import('@/lib/dialog');
    useDialogQueue.setState({ queue: [] });
    await render(<PodCodeScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('own-pod-address'), 'https://pod.own.test');
      fireEvent.changeText(screen.getByTestId('own-pod-code'), 'K7Q2M9XD');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('own-pod-code-pair'));
    });
    await act(async () => {
      settleDialog(useDialogQueue.getState().queue[0].id, true);
    });
    expect(await screen.findByText('A backup or restore is running. Try again when it ends.')).toBeTruthy();
    expect(pod.requests).toEqual([]);
    answer(false);
    await backup;
  });
});

describe('after unpairing', () => {
  it('backup works again with the same settings, and nothing runs by itself at the moment of unpairing', async () => {
    await setUpBackup();
    await pair();
    const before = await settingsNow();
    await run();
    await forgetPairing();
    await advanceUntilDone(Promise.resolve());
    expect(providerCalls()).toBe(0);
    expect(await settingsNow()).toEqual(before);

    await runBackup(icloudProvider);
    expect(remoteNames()).toHaveLength(1);
  });

  it('no scheduled backup runs after unpairing until the person backs up or restores, so the backups from before pairing are not pruned away', async () => {
    await setUpBackup();
    await pair();
    await run();
    await forgetPairing();

    // Three due wakes: each would have pruned one more of the backups made before pairing.
    for (let day = 1; day <= 3; day++) {
      jest.setSystemTime(NOW + day * 24 * HOUR);
      await advanceUntilDone(runBackgroundWake());
    }
    expect(remoteNames()).toHaveLength(0);
    expect(providerCalls()).toBe(0);

    // The person backs up by hand: one write, and the schedule takes over again.
    await runBackup(icloudProvider);
    expect(remoteNames()).toHaveLength(1);
    jest.setSystemTime(NOW + 5 * 24 * HOUR);
    await advanceUntilDone(runBackgroundWake());
    expect(remoteNames()).toHaveLength(2);
  });

  it('pairing through the real flow holds the schedule too', async () => {
    const { holdBackupsAfterPairing, backupsHeldAfterPairing } = await import('@/lib/backup/backup-settings');
    expect(await backupsHeldAfterPairing()).toBe(false);
    await holdBackupsAfterPairing();
    expect(await backupsHeldAfterPairing()).toBe(true);
  });
});

describe('the backup section', () => {
  const mount = async () => {
    setAppState('active');
    await render(<BackupSection />);
    await screen.findByTestId('backup-switch');
  };
  const press = async (id: string) => {
    await act(async () => {
      fireEvent.press(screen.getByTestId(id));
    });
  };

  it('paired: opening the page only asks whether iCloud is available, and never lists the backup folder', async () => {
    await setUpBackup();
    await pair();
    shared.calls.length = 0;
    await mount();
    await act(async () => {
      await new Promise<void>((r) => setImmediate(r));
    });
    expect([...new Set(shared.calls.map((c) => c.name))]).toEqual(expect.not.arrayContaining(['readdir', 'exists', 'stat', 'downloadFile']));
    expect(shared.calls.every((c) => c.name === 'isCloudAvailable')).toBe(true);
  });

  it('paired: shows the line, disables every action with an announced state, and pressing does nothing', async () => {
    await setUpBackup();
    await pair();
    await mount();
    shared.calls.length = 0; // opening the page only asks whether iCloud is signed in

    expect(screen.getByText(LINE)).toBeTruthy();
    for (const id of ['backup-switch', 'backup-run-now', 'restore-start']) {
      expect(screen.getByTestId(id)).toBeDisabled();
      expect(screen.getByTestId(id).props.accessibilityState).toMatchObject({ disabled: true });
      expect(screen.getByTestId(id).props.accessibilityHint).toBe(LINE);
      expect(screen.getByTestId(id).props.accessibilityLabel).toBeTruthy();
    }

    await press('backup-run-now');
    await press('restore-start');
    expect(screen.queryByTestId('restore-steps')).toBeNull();
    expect(providerCalls()).toBe(0);
    expect(await getSetting(BACKUP_CADENCE_KEY)).toBe('daily');
    expect(screen.getByText('Schedule: Every day')).toBeTruthy();
  });

  it('a pending pairing: no line, the actions work', async () => {
    await setUpBackup();
    await pair('pending');
    await mount();
    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.getByTestId('backup-run-now')).toBeEnabled();
    expect(screen.getByTestId('restore-start')).toBeEnabled();
    expect(screen.getByTestId('backup-switch')).toBeEnabled();
  });

  it('unpairing while it is on screen brings the actions back', async () => {
    await setUpBackup();
    await pair();
    await mount();
    expect(screen.getByTestId('backup-run-now')).toBeDisabled();
    await act(async () => {
      await forgetPairing();
    });
    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.getByTestId('backup-run-now')).toBeEnabled();
  });
});
