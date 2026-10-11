import { useCallback, useEffect, useRef, useState } from 'react';
import { Share } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  backupLastRunAt,
  backupProviderId,
  hydrateBackupSettings,
  recordBackupFailure,
  recordBackupRun,
  setBackupCadence,
  setBackupProviderId,
  type BackupProviderId,
} from '@/lib/backup/backup-settings';
import { listBackups, runBackup, runRestore, verifyProviderAccess } from '@/lib/backup/backup-service';
import {
  adoptRecoveryCode,
  clearBackupKey,
  ensureBackupKey,
  getRecoveryCode,
  isBackupConfigured,
  markRecoveryCodeConfirmed,
} from '@/lib/backup/key-store';
import {
  connectGoogleDrive,
  googleDriveProvider,
  isGoogleDriveConfigured,
  type DriveConnectResult,
} from '@/lib/backup/providers/google-drive';
import { icloudProvider, isICloudSupported } from '@/lib/backup/providers/icloud';
import { createdAtFromRemoteFilename } from '@/lib/backup/remote-names';
import { backgroundBackupIsAvailable } from '@/lib/background/backup-task';
import type { BackupCadence, BackupProvider } from '@/lib/backup/types';
import { requestRestart, restartIsAvailable } from '@/lib/app-restart';
import { showDialog } from '@/lib/dialog';
import { hapticSuccess } from '@/lib/haptics';
import logger from '@/lib/logger';
import { toastManager } from '@/lib/toast-manager';

type BackupState = 'loading' | 'off' | 'setup' | 'on';
type BackupStep = 'code' | 'where' | 'when';
type RestoreStep = 'idle' | 'where' | 'code' | 'restoring';

function cloudProviderFor(id: BackupProviderId): BackupProvider | null {
  if (id === 'icloud') return icloudProvider;
  if (id === 'google-drive') return googleDriveProvider;
  return null;
}

export function useBackupSection({ autoOpenRecover }: { autoOpenRecover: boolean }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;

  // ── backup state ──────────────────────────────────────────────────────────
  const [state, setState] = useState<BackupState>('loading');
  const [step, setStep] = useState<BackupStep>('code');
  /** A folded step reopened from the on state ("Change"). */
  const [editing, setEditing] = useState<'where' | 'when' | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeSaved, setCodeSaved] = useState(false);
  const [pickedProvider, setPickedProvider] = useState<BackupProviderId | null>(null);
  const [pickedCadence, setPickedCadence] = useState<Exclude<BackupCadence, 'off'>>('daily');
  const [busy, setBusy] = useState<string | null>(null);
  const [icloudReady, setIcloudReady] = useState(false);
  const [driveReady, setDriveReady] = useState(false);
  const [bgAvailable, setBgAvailable] = useState(true);
  const [showCode, setShowCode] = useState(false);
  const [earned, setEarned] = useState(false);
  // Newest backup in the cloud, for a device that never stamped one itself.
  const [cloudLastAt, setCloudLastAt] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const fail = useCallback((err: unknown, where: string) => {
    logger.captureException(err, { tags: { screen: 'backup', action: where } });
    toastManager.showError(tRef.current('backup.errorTitle'), tRef.current('backup.errorDescription'));
  }, []);

  // Provider availability is a RUNTIME question, re-asked on every entry:
  // iCloud reports unavailable for a window right after launch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await hydrateBackupSettings();
        const [ic, gd, bg] = await Promise.all([
          isICloudSupported() ? icloudProvider.isAvailable() : Promise.resolve(false),
          isGoogleDriveConfigured() ? googleDriveProvider.isAvailable() : Promise.resolve(false),
          backgroundBackupIsAvailable(),
        ]);
        if (cancelled) return;
        setIcloudReady(ic);
        setDriveReady(gd);
        setBgAvailable(bg);
        const configured = await isBackupConfigured();
        if (cancelled) return;
        setState((prev) => (prev === 'setup' && !configured ? prev : configured ? 'on' : 'off'));
        const id = backupProviderId();
        const cloud = id ? cloudProviderFor(id) : null;
        if (configured && cloud && backupLastRunAt() === null) {
          listBackups(cloud)
            .then((paths) => {
              if (cancelled) return;
              setCloudLastAt(paths.map(createdAtFromRemoteFilename).find((ms) => ms !== null) ?? null);
            })
            .catch(() => {});
        }
      } catch (err) {
        if (!cancelled) {
          fail(err, 'load');
          setState('off');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fail, version]);

  const reportDriveFailure = useCallback((result: Exclude<DriveConnectResult, { ok: true }>) => {
    if (result.reason === 'cancelled') return; // a choice, not an error
    const key =
      result.reason === 'play-services'
        ? 'backup.drivePlayServices'
        : result.reason === 'misconfigured'
          ? 'backup.driveMisconfigured'
          : 'backup.driveFailed';
    const detail = 'detail' in result ? result.detail : '';
    if (detail) {
      logger.captureException(new Error(`Drive connect failed: ${detail}`), {
        tags: { screen: 'backup', action: 'connect-drive', reason: result.reason },
      });
    }
    toastManager.showError(
      tRef.current('backup.driveFailedTitle'),
      __DEV__ && detail ? `${tRef.current(key)} (${detail})` : tRef.current(key),
    );
  }, []);

  /** Connect (if needed) and prove the credential really works, so a Drive
   *  scope problem surfaces as an error and never as "no backups". */
  const reachProvider = useCallback(
    async (id: BackupProviderId): Promise<BackupProvider | null> => {
      if (id === 'google-drive' && !driveReady) {
        const result = await connectGoogleDrive();
        if (!result.ok) {
          reportDriveFailure(result);
          return null;
        }
        setDriveReady(true);
      }
      const cloud = cloudProviderFor(id);
      if (cloud) await verifyProviderAccess(cloud);
      return cloud;
    },
    [driveReady, reportDriveFailure],
  );

  // ── backup actions ────────────────────────────────────────────────────────
  const turnOn = useCallback(async () => {
    try {
      setBusy('setup');
      // Idempotent: a second run must not mint a new key and orphan every blob.
      setCode(await ensureBackupKey());
      setCodeSaved(false);
      setPickedProvider(null);
      setStep('code');
      setState('setup');
    } catch (err) {
      fail(err, 'begin-setup');
    } finally {
      setBusy(null);
    }
  }, [fail]);

  const turnOff = useCallback(async () => {
    const ok = await showDialog({
      title: tRef.current('backup.turnOff'),
      body: tRef.current('backup.turnOffConfirm'),
      confirmLabel: tRef.current('backup.turnOffAction'),
      cancelLabel: tRef.current('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      setBusy('off');
      await setBackupCadence('off');
      // The key goes too. Copies already saved stay where they are and stay
      // readable only with the written-down code.
      await clearBackupKey();
      setEditing(null);
      setState('off');
      refresh();
    } catch (err) {
      fail(err, 'turn-off');
    } finally {
      setBusy(null);
    }
  }, [fail, refresh]);

  const onSwitch = (on: boolean) => {
    if (busy) return;
    if (on) void turnOn();
    else if (state === 'on') void turnOff();
    else {
      // Setup not finished: nothing runs yet, so off is just leaving it.
      setState('off');
      refresh();
    }
  };

  const acknowledgeCode = useCallback(async () => {
    try {
      await markRecoveryCodeConfirmed();
      setStep('where');
    } catch (err) {
      fail(err, 'acknowledge-code');
    }
  }, [fail]);

  const confirmProvider = useCallback(async () => {
    const id = pickedProvider;
    if (!id) return;
    try {
      setBusy(id);
      if (!(await reachProvider(id))) return; // reported (or cancelled)
      await setBackupProviderId(id);
      if (state === 'on') {
        setEditing(null);
        refresh();
      } else {
        setStep('when');
      }
    } catch (err) {
      fail(err, 'choose-provider');
    } finally {
      setBusy(null);
    }
  }, [pickedProvider, reachProvider, state, fail, refresh]);

  const finishCadence = useCallback(async () => {
    try {
      await setBackupCadence(pickedCadence);
      const firstTime = state !== 'on';
      setEditing(null);
      setState('on');
      if (firstTime) {
        void hapticSuccess();
        setEarned(true);
      }
      refresh();
    } catch (err) {
      fail(err, 'choose-cadence');
    }
  }, [pickedCadence, state, fail, refresh]);

  const backUpNow = useCallback(async () => {
    const id = backupProviderId();
    if (!id) return;
    try {
      setBusy('run');
      const result = await runBackup(cloudProviderFor(id) as BackupProvider);
      const rows = result.header.tables.reduce((n, tb) => n + tb.rows, 0);
      toastManager.showSuccess(tRef.current('backup.doneTitle'), tRef.current('backup.doneDescription', { count: rows }));
      // Its own catch: the upload DID happen; a failed stamp must not read as
      // a failed backup.
      try {
        await recordBackupRun(result.header.createdAt ?? Date.now());
      } catch (err) {
        logger.captureException(err, { tags: { screen: 'backup', action: 'stamp-run' } });
      }
      refresh();
    } catch (err) {
      fail(err, 'run-backup');
      try {
        await recordBackupFailure(Date.now());
      } catch {
        // The toast already told the user; the status line is best effort.
      }
      refresh();
    } finally {
      setBusy(null);
    }
  }, [fail, refresh]);

  const openRecoveryCode = useCallback(async () => {
    try {
      setCode(await getRecoveryCode());
      setShowCode(true);
    } catch (err) {
      fail(err, 'show-code');
    }
  }, [fail]);

  const shareCode = useCallback(async () => {
    if (!code) return;
    try {
      await Share.share({ message: code });
    } catch {
      // Dismissing the sheet is not an error.
    }
  }, [code]);

  // ── restore ───────────────────────────────────────────────────────────────
  const [rstep, setRstep] = useState<RestoreStep>('idle');
  const [rsource, setRsource] = useState<BackupProviderId | null>(null);
  const [found, setFound] = useState<{ source: BackupProviderId; path: string; at: number | null } | null>(null);
  const [typedCode, setTypedCode] = useState('');
  const [restored, setRestored] = useState(0);

  // `?restore=1` opens the restore steps once the load settled, ONCE.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpenRecover || autoOpened.current || state === 'loading') return;
    autoOpened.current = true;
    setRstep('where');
  }, [autoOpenRecover, state]);

  const lookForBackup = useCallback(async () => {
    const id = rsource;
    if (!id) return;
    try {
      setBusy('list');
      const cloud = await reachProvider(id);
      if (!cloud) return;
      const paths = await listBackups(cloud); // newest first
      if (paths.length === 0) {
        toastManager.showInfo(tRef.current('backup.restoreEmpty'));
        return;
      }
      setFound({ source: id, path: paths[0], at: createdAtFromRemoteFilename(paths[0]) });
      setRstep('code');
    } catch (err) {
      fail(err, 'choose-source');
    } finally {
      setBusy(null);
    }
  }, [rsource, reachProvider, fail]);

  const restore = useCallback(async () => {
    const target = found;
    const cloud = target ? cloudProviderFor(target.source) : null;
    if (!target || !cloud) return;
    try {
      setBusy('adopt');
      // Crockford already forgives case, hyphens and I/L/O, so a refusal really
      // means the code is wrong.
      const ok = await adoptRecoveryCode(typedCode);
      if (!ok) {
        toastManager.showError(tRef.current('backup.codeWrongTitle'), tRef.current('backup.codeWrong'));
        return;
      }
    } catch (err) {
      fail(err, 'adopt-code');
      return;
    } finally {
      setBusy(null);
    }
    const confirmed = await showDialog({
      title: tRef.current('backup.restoreConfirmTitle'),
      body: tRef.current('backup.restoreConfirmDescription'),
      confirmLabel: tRef.current('backup.restoreConfirmAction'),
      cancelLabel: tRef.current('common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    setTypedCode('');
    setRestored(0);
    setRstep('restoring');
    try {
      const result = await runRestore(cloud, target.path, (p) => setRestored(p.rowsRestored));
      toastManager.showSuccess(
        tRef.current('backup.restoredTitle'),
        tRef.current('backup.restoredDescription', { count: result.rowsRestored }),
      );
      // The card folds back; backup for this phone stays off until turned on.
      setRstep('idle');
      setFound(null);
      // RELOAD rather than re-hydrate: the restore replaced rows under every
      // store. Through the one restart authority; a build that cannot restart
      // says so instead.
      if (restartIsAvailable()) await requestRestart('restore');
      else toastManager.showSuccess(tRef.current('backup.restoredTitle'), tRef.current('backup.restartNeeded'));
    } catch (err) {
      fail(err, 'run-restore');
      setRstep('code');
    }
  }, [found, typedCode, fail]);

  return {
    state,
    step,
    editing,
    setEditing,
    code,
    codeSaved,
    setCodeSaved,
    pickedProvider,
    setPickedProvider,
    pickedCadence,
    setPickedCadence,
    busy,
    icloudReady,
    driveReady,
    bgAvailable,
    showCode,
    setShowCode,
    earned,
    setEarned,
    cloudLastAt,
    refresh,
    onSwitch,
    acknowledgeCode,
    confirmProvider,
    finishCadence,
    backUpNow,
    openRecoveryCode,
    shareCode,
    rstep,
    setRstep,
    rsource,
    setRsource,
    found,
    setFound,
    typedCode,
    setTypedCode,
    restored,
    lookForBackup,
    restore,
  };
}

export type { BackupStep, RestoreStep };
