// Backup and restore, one screen (FinalBackup #1-#12, You > Settings > Your
// data > Backup). Two cards, each a stack of steps that open one below the
// other (the kit's StepsAccordion): Backup on top, Restore always last.
//
// **Backup is optional and stays off.** `backup_cadence` defaults to `off` and
// `backup_provider` to null, so nothing runs until the reader turns it on.
//
// **The RECOVERY CODE COMES FIRST.** `runBackup` refuses until the code is
// acknowledged, because a backup taken before then is written under a key
// that exists only in the keychain, and the next logout wipes the keychain,
// leaving a file nobody can ever open. A provider-first order would end at a
// button the service declines.
//
// **Every destination can be written to unattended.** A save-to-a-file
// destination was built and removed: a share sheet needs a human, so it could
// never be automated, and a backup nobody remembers to take is not a backup.
//
// **The backup itself does NOT run here.** It runs in the OS background task
// (`lib/background/backup-task.ts`). Back up now is the only foreground path
// that does real work. Every path that runs a backup stamps it
// (`recordBackupRun` / `recordBackupFailure`): the status line reads nothing
// else.
//
// **Restore** (its own card, always on screen): where the backup is (Mera
// lists it there first), then the recovery code (adopted as this phone's
// key; the importer refuses a wrong key before touching any data), then a
// confirm (a restore REPLACES), then progress. It never turns backup on for
// this phone (owner, FinalBackup #12). After it the app restarts so every
// store re-hydrates; the toast before the restart may not survive it.
//
// `useTranslation()`'s `t` is read through a ref in callbacks: an unstable
// identity in a dependency list once re-ran the load effect on every render
// and snapped setup back to its first step.

import LottieView from 'lottie-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Share, StyleSheet, TextInput, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { MaterialIcons } from '@expo/vector-icons';

import { Group, Help, Row } from '@/components/custom/you/rows';
import { gameAnimationFor } from '@/components/custom/game-ui/animation-registry';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { StepsAccordion, type AccordionStep } from '@/components/ui/steps-accordion';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';

import {
  backupCadence,
  backupLastFailedAt,
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
  getBackupKey,
  getRecoveryCode,
  isRecoveryCodeConfirmed,
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
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import { toastManager } from '@/lib/toast-manager';

/** Past this, the status card says the copy is old (FinalBackup #8: a week). */
export const STALE_BACKUP_MS = 7 * 24 * 60 * 60 * 1000;

const CADENCES: Exclude<BackupCadence, 'off'>[] = ['daily', 'weekly', 'manual'];

type BackupState = 'loading' | 'off' | 'setup' | 'on';
type BackupStep = 'code' | 'where' | 'when';
type RestoreStep = 'idle' | 'where' | 'code' | 'restoring';

function cloudProviderFor(id: BackupProviderId): BackupProvider | null {
  if (id === 'icloud') return icloudProvider;
  if (id === 'google-drive') return googleDriveProvider;
  return null;
}

/** Date and time in the APP language; the bare default if the tag throws. */
function formatWhen(ms: number, language: string | undefined): string {
  try {
    return new Date(ms).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function formatDay(ms: number, language: string | undefined): string {
  try {
    return new Date(ms).toLocaleDateString(language, { day: 'numeric', month: 'short' });
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

export interface BackupSectionProps {
  /** Open the Restore steps at once (`you/backup?restore=1`, old links). */
  autoOpenRecover?: boolean;
}

const BackupSection: React.FC<BackupSectionProps> = ({ autoOpenRecover = false }) => {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const colors = useColors();
  const themeMode = useThemeMode();
  const reduceMotion = useReducedMotion();
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
        // The KEY too, not just the confirmation row: with a provider set and
        // the key gone, every scheduled run fails `no-key` while this read
        // "on" (MERA-APP-7Z). `getBackupKey` is the read `runBackup` refuses on.
        const configured =
          backupProviderId() !== null && (await isRecoveryCodeConfirmed()) && (await getBackupKey()) !== null;
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

  /** Connect (if needed) and prove the credential really works, so a Drive
   *  scope problem surfaces as an error and never as "no backups". */
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

  // ── rendering ─────────────────────────────────────────────────────────────
  const choice = (
    id: string,
    title: string,
    hint: string,
    selected: boolean,
    onPress: () => void,
    disabled = false,
  ) => (
    <Pressable
      key={id}
      testID={id}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected, disabled }}
      accessibilityLabel={`${title}, ${hint}`}
      style={[
        styles.choice,
        { borderColor: selected ? colors.accent : colors.trackBorder, opacity: disabled ? 0.45 : 1 },
      ]}
    >
      <MaterialIcons
        name={selected ? 'radio-button-checked' : 'radio-button-unchecked'}
        size={20}
        color={selected ? colors.accent : colors.ink3}
      />
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{hint}</Text>
      </View>
    </Pressable>
  );

  const primary = (label: string, onPress: () => void, disabled: boolean, testID: string, spin = false) => (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[styles.primary, { backgroundColor: colors.accent, opacity: disabled ? 0.4 : 1 }]}
    >
      {spin ? <Spinner size="small" /> : <Text style={{ color: colors.onAccent, fontSize: 16, fontWeight: '600' }}>{label}</Text>}
    </Pressable>
  );

  const codeBox = () => (
    <View style={[styles.codeBox, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}>
      <Text selectable style={{ color: colors.ink, textAlign: 'center', fontFamily: 'monospace', lineHeight: 26 }}>
        {code ?? ''}
      </Text>
    </View>
  );

  const providerChoices = (selected: BackupProviderId | null, onPick: (id: BackupProviderId) => void, forRestore: boolean) => (
    <>
      {/* iCloud on Android is not an option at all; iCloud signed out shows
          greyed with what to do (FinalBackup #7). */}
      {isICloudSupported()
        ? choice(
            forRestore ? 'restore-pick-icloud' : 'backup-pick-icloud',
            t('backup.icloud'),
            !icloudReady ? t('backup.icloudUnavailable') : forRestore ? t('backup.restoreSourceIcloud') : t('backup.icloudReady'),
            selected === 'icloud',
            () => onPick('icloud'),
            !icloudReady,
          )
        : null}
      {isGoogleDriveConfigured()
        ? choice(
            forRestore ? 'restore-pick-drive' : 'backup-pick-drive',
            t('backup.drive'),
            forRestore ? t('backup.restoreSourceDrive') : driveReady ? t('backup.driveReady') : t('backup.driveConnect'),
            selected === 'google-drive',
            () => onPick('google-drive'),
          )
        : null}
    </>
  );

  const providerName = (id: BackupProviderId | null) => (id === 'icloud' ? t('backup.icloud') : t('backup.drive'));
  const cadenceName = (c: BackupCadence) => t(`backup.cadence.${c}`);

  const backupSteps = (): AccordionStep[] => {
    const on = state === 'on';
    const statusOf = (s: BackupStep): AccordionStep['status'] => {
      if (on) return editing === s ? 'open' : 'done';
      const order: BackupStep[] = ['code', 'where', 'when'];
      const i = order.indexOf(s);
      const cur = order.indexOf(step);
      return i < cur ? 'done' : i === cur ? 'open' : 'hidden';
    };
    return [
      {
        id: 'code',
        title: t('backup.codeTitle'),
        hint: t('backup.codeDescription'),
        summary: on ? t('backup.codeSavedHint') : t('backup.stepSaved'),
        status: statusOf('code'),
        actionLabel: on ? t('backup.show') : undefined,
        onAction: on ? () => void openRecoveryCode() : undefined,
        children: (
          <View style={{ gap: 10 }}>
            {codeBox()}
            <Pressable testID="backup-share-code" onPress={shareCode} accessibilityRole="button" style={styles.link}>
              <MaterialIcons name="ios-share" size={18} color={colors.accentText} />
              <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>{t('backup.shareCode')}</Text>
            </Pressable>
            <Pressable
              testID="backup-code-saved"
              onPress={() => setCodeSaved((s) => !s)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: codeSaved }}
              style={styles.check}
            >
              <MaterialIcons
                name={codeSaved ? 'check-box' : 'check-box-outline-blank'}
                size={22}
                color={codeSaved ? colors.accent : colors.ink3}
              />
              <Text style={{ flex: 1, color: colors.ink }}>{t('backup.codeSaved')}</Text>
            </Pressable>
            {primary(t('backup.continue'), () => void acknowledgeCode(), !codeSaved, 'backup-code-continue')}
          </View>
        ),
      },
      {
        id: 'where',
        title: on || statusOf('where') === 'done' ? t('backup.where') : t('backup.whereTitle'),
        hint: t('backup.whereDescription'),
        summary: providerName(backupProviderId() ?? pickedProvider),
        status: statusOf('where'),
        actionLabel: on ? t('backup.change') : undefined,
        onAction: on
          ? () => {
              setPickedProvider(backupProviderId());
              setEditing('where');
            }
          : undefined,
        children: (
          <View style={{ gap: 10 }}>
            {providerChoices(pickedProvider, setPickedProvider, false)}
            {primary(t('backup.continue'), () => void confirmProvider(), !pickedProvider || busy !== null, 'backup-where-continue', busy === pickedProvider)}
          </View>
        ),
      },
      {
        id: 'when',
        title: t('backup.whenTitle'),
        summary: cadenceName(backupCadence()),
        status: statusOf('when'),
        actionLabel: on ? t('backup.change') : undefined,
        onAction: on
          ? () => {
              const c = backupCadence();
              setPickedCadence(c === 'off' ? 'daily' : c);
              setEditing('when');
            }
          : undefined,
        children: (
          <View style={{ gap: 10 }}>
            {CADENCES.map((c) =>
              choice(`backup-cadence-${c}`, cadenceName(c), t(`backup.cadenceHint.${c}`), pickedCadence === c, () => setPickedCadence(c)),
            )}
            {primary(on ? t('common.done') : t('backup.finish'), () => void finishCadence(), false, 'backup-finish')}
          </View>
        ),
      },
    ];
  };

  const statusCard = () => {
    const id = backupProviderId() as BackupProviderId;
    const last = backupLastRunAt();
    const failedAt = backupLastFailedAt();
    const age = last !== null ? Date.now() - last : null;
    const warn = { color: colors.warning, fontSize: 13, lineHeight: 18 } as const;
    const plain = { color: colors.ink2, fontSize: 13, lineHeight: 18 } as const;
    return (
      <View testID="backup-status" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>
          {t('backup.statusProvider', { provider: providerName(id) })}
        </Text>
        <Text style={plain}>{t(id === 'google-drive' ? 'backup.driveHiddenFolder' : 'backup.icloudHiddenFolder')}</Text>
        {/* Each warning only when true (FinalBackup #8). */}
        {failedAt !== null ? (
          <Text testID="backup-status-failed" style={warn}>
            {t('backup.statusFailed', { when: formatWhen(failedAt, language) })}
          </Text>
        ) : null}
        {last === null ? (
          cloudLastAt !== null ? (
            <Text style={plain}>
              {t('backup.statusFromCloud', { when: formatWhen(cloudLastAt, language), provider: providerName(id) })}
            </Text>
          ) : (
            <Text style={plain}>{t('backup.statusNever')}</Text>
          )
        ) : age !== null && age > STALE_BACKUP_MS ? (
          <Text style={warn}>{t('backup.statusStale', { days: Math.floor(age / (24 * 60 * 60 * 1000)) })}</Text>
        ) : (
          <Text style={plain}>{t('backup.statusLast', { when: formatWhen(last, language) })}</Text>
        )}
        {/* Restricted has to be a SENTENCE: with Background App Refresh off,
            backups never run on their own. */}
        {bgAvailable ? null : <Text style={warn}>{t('backup.backgroundRestricted')}</Text>}
        <Text style={plain}>{t('backup.schedule', { cadence: cadenceName(backupCadence()) })}</Text>
      </View>
    );
  };

  const restoreSteps = (): AccordionStep[] => {
    const order: RestoreStep[] = ['where', 'code', 'restoring'];
    const cur = order.indexOf(rstep);
    const statusOf = (s: RestoreStep): AccordionStep['status'] => {
      const i = order.indexOf(s);
      return i < cur ? 'done' : i === cur ? 'open' : 'hidden';
    };
    const foundSummary = found
      ? [t('backup.foundIn', { place: providerName(found.source) }), found.at !== null ? t('backup.foundDate', { date: formatDay(found.at, language) }) : null]
          .filter(Boolean)
          .join(' · ')
      : '';
    return [
      {
        id: 'where',
        title: t('backup.restoreWhereTitle'),
        hint: t('backup.restoreWhereDescription'),
        summary: foundSummary,
        status: statusOf('where'),
        actionLabel: rstep === 'code' ? t('backup.change') : undefined,
        onAction: rstep === 'code' ? () => setRstep('where') : undefined,
        children: (
          <View style={{ gap: 10 }}>
            {providerChoices(rsource, setRsource, true)}
            {primary(t('backup.continue'), () => void lookForBackup(), !rsource || busy !== null, 'restore-where-continue', busy === 'list')}
          </View>
        ),
      },
      {
        id: 'code',
        title: t('backup.adoptTitle'),
        hint: t('backup.restoreCodeHint'),
        summary: t('backup.accepted'),
        status: statusOf('code'),
        children: (
          <View style={{ gap: 10 }}>
            <TextInput
              testID="restore-code-input"
              value={typedCode}
              onChangeText={setTypedCode}
              placeholder={t('backup.adoptPlaceholder')}
              placeholderTextColor={colors.ink3}
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardAppearance={themeMode}
              accessibilityLabel={t('backup.adoptTitle')}
              style={[styles.input, { color: colors.ink, backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}
            />
            {primary(t('backup.restoreConfirmAction'), () => void restore(), typedCode.trim().length === 0 || busy !== null, 'restore-run', busy === 'adopt')}
          </View>
        ),
      },
      {
        id: 'restoring',
        title: t('backup.restoringTitle'),
        status: statusOf('restoring'),
        children: (
          <View style={{ gap: 6 }} accessibilityLiveRegion="polite">
            <Spinner size="small" />
            <Text style={{ color: colors.ink, fontSize: 14 }}>{t('backup.restoredDescription', { count: restored })}</Text>
            <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{t('backup.restoringHint')}</Text>
          </View>
        ),
      },
    ];
  };

  if (state === 'loading') {
    return (
      <View style={{ paddingVertical: 24, alignItems: 'center' }}>
        <Spinner size="small" />
      </View>
    );
  }

  const switchOn = state !== 'off';
  const earnSource = gameAnimationFor('game-mark-earn');

  return (
    <View testID="backup-section" style={{ gap: 12 }}>
      <Group>
        <Row
          testID="backup-switch-row"
          title={t('backup.title')}
          trailing={
            busy === 'setup' || busy === 'off' ? (
              <Spinner size="small" />
            ) : (
              <Switch testID="backup-switch" value={switchOn} onToggle={onSwitch} size="md" />
            )
          }
        />
      </Group>
      <Help>{t('backup.offDescription')}</Help>

      {earned && !reduceMotion && earnSource ? (
        // The one earned moment: backup turned on for the first time.
        <View pointerEvents="none" accessible={false} style={{ alignItems: 'center' }}>
          <LottieView
            source={earnSource as never}
            autoPlay
            loop={false}
            style={{ width: 64, height: 64 }}
            onAnimationFinish={() => setEarned(false)}
          />
        </View>
      ) : null}

      {state === 'on' ? statusCard() : null}
      {state !== 'off' ? <StepsAccordion testID="backup-steps" steps={backupSteps()} /> : null}
      {state === 'on' ? (
        <Group>
          <Row
            testID="backup-run-now"
            title={busy === 'run' ? t('backup.working') : t('backup.runNow')}
            subtitle={t('backup.runNowHint')}
            trailing={busy === 'run' ? <Spinner size="small" /> : null}
            onPress={() => void backUpNow()}
          />
        </Group>
      ) : null}

      {/* Restore: its own card, always on screen and always last. */}
      <View testID="restore-card" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line, marginTop: 8 }]}>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>
          {t('backup.restore')}
        </Text>
        {rstep === 'idle' ? (
          <>
            <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{t('backup.restoreBody')}</Text>
            <Pressable
              testID="restore-start"
              onPress={() => setRstep('where')}
              accessibilityRole="button"
              accessibilityLabel={t('backup.startRestoring')}
              style={[styles.secondary, { borderColor: colors.trackBorder }]}
            >
              <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '600' }}>{t('backup.startRestoring')}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{t('backup.restoreReplaces')}</Text>
            <StepsAccordion testID="restore-steps" steps={restoreSteps()} />
            {rstep !== 'restoring' ? (
              <Pressable
                testID="restore-cancel"
                onPress={() => {
                  setRstep('idle');
                  setFound(null);
                  setTypedCode('');
                  // Re-derive the real backup state; never assume off.
                  refresh();
                }}
                accessibilityRole="button"
                style={styles.link}
              >
                <Text style={{ color: colors.ink2, fontSize: 15 }}>{t('common.cancel')}</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>

      <BottomSheet testID="backup-code-sheet" open={showCode} onClose={() => setShowCode(false)}>
        <View style={{ gap: 12 }}>
          <Text style={{ color: colors.ink, fontSize: 17, fontWeight: '600' }}>{t('backup.codeTitle')}</Text>
          <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{t('backup.codeDescription')}</Text>
          {codeBox()}
          <Pressable onPress={shareCode} accessibilityRole="button" style={styles.link}>
            <MaterialIcons name="ios-share" size={18} color={colors.accentText} />
            <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>{t('backup.shareCode')}</Text>
          </Pressable>
        </View>
      </BottomSheet>
    </View>
  );
};

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 8 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 56 },
  primary: { height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  secondary: { height: 44, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, alignSelf: 'flex-start' },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  codeBox: { borderRadius: 12, borderWidth: 1, padding: 14 },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontFamily: 'monospace', fontSize: 15 },
});

export default BackupSection;
