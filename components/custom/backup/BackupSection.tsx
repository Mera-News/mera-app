// Backup and restore, as a section inside Manage Data.
//
// **Backup is optional and stays off.** `backup_cadence` defaults to `off` and
// `backup_provider` to null, so `scheduledBackupEnabled()` is false and the
// scheduler's condition never passes. Someone who wants no backups should be
// able to read the first paragraph once and never think about this again; the
// resting state is an offer, not an unfinished setup.
//
// **Setup reveals one step at a time, in place**, and the RECOVERY CODE COMES
// FIRST. That order is not cosmetic: `runBackup` refuses until the code is
// acknowledged, because a backup taken before then is written under a key that
// exists only in the keychain — and the next logout
// wipes the keychain, leaving a file nobody can ever open that the user
// believes is their backup. A provider-first flow would end at a button the
// service declines.
//
// **Every destination here can be written to unattended.** A "save to a file"
// destination was built and removed on 2026-08-18: a share sheet needs a human,
// so it could never be automated, and a backup nobody remembers to take is not
// a backup. Anything added here has to clear that bar first.
//
// **The backup itself does NOT run here.** It runs in an OS background task
// (`lib/background/backup-task.ts`), so the compression, encryption and upload
// never compete with the app the user is actually using. This screen reads
// `backup_last_run_at` and offers a button; that button is the only foreground
// path that does real work, and it is a deliberate tap.
//
// The system decides when the background task runs, and on iOS that is usually
// overnight. It can also decline entirely — Background App Refresh off, or Low
// Power Mode — so the status is READ and said out loud rather than assumed.
//
// **`useToast()` and `useTranslation()` are read through refs.** Neither
// guarantees a stable identity, and when they were in the load effect's
// dependency list the effect re-ran on every render and re-set the stage,
// snapping the wizard back to its first screen and making every later step
// unreachable. Measured, not theoretical.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Share } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MaterialIcons } from '@expo/vector-icons';

import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';

import {
  backupCadence,
  backupLastRunAt,
  backupProviderId,
  backupWifiOnly,
  hydrateBackupSettings,
  setBackupCadence,
  setBackupProviderId,
  setBackupWifiOnly,
  type BackupProviderId,
} from '@/lib/backup/backup-settings';
import {
  listBackups,
  runBackup,
  runRestore,
  verifyProviderAccess,
} from '@/lib/backup/backup-service';
import {
  adoptRecoveryCode,
  clearBackupKey,
  ensureBackupKey,
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
import { backgroundBackupIsAvailable } from '@/lib/background/backup-task';
import type { BackupCadence, BackupProvider } from '@/lib/backup/types';
import logger from '@/lib/logger';

/** Past this, the "save a new copy" nudge turns amber. */
export const STALE_BACKUP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `where` and `restoreWhere` ask DIFFERENT questions and must stay separate.
 * `where` is "where should backups go" (setup). `restoreWhere` is "where is my
 * existing backup" (recovery). Wiring the recovery path to `where` — which is
 * what shipped first — meant entering a recovery code silently configured
 * backup and never restored anything.
 */
type Stage = 'loading' | 'off' | 'code' | 'where' | 'when' | 'on' | 'adopt' | 'restoreWhere';

const CADENCES: Exclude<BackupCadence, 'off'>[] = ['daily', 'weekly', 'manual'];

function cloudProviderFor(id: BackupProviderId): BackupProvider | null {
  if (id === 'icloud') return icloudProvider;
  if (id === 'google-drive') return googleDriveProvider;
  return null;
}

const BackupSection: React.FC = () => {
  const toast = useToast();
  const { t } = useTranslation();

  const [stage, setStage] = useState<Stage>('loading');
  const [code, setCode] = useState<string | null>(null);
  const [codeSaved, setCodeSaved] = useState(false);
  const [typedCode, setTypedCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [icloudReady, setIcloudReady] = useState(false);
  const [bgAvailable, setBgAvailable] = useState(true);
  const [driveReady, setDriveReady] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [restoreOptions, setRestoreOptions] = useState<readonly string[] | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  /** Set only on the recovery path: where the EXISTING backup is being read from. */
  const [restoreSource, setRestoreSource] = useState<BackupProviderId | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // See the header: stable identities, or the load effect re-runs forever.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tRef = useRef(t);
  tRef.current = t;

  const notify = useCallback(
    (action: 'success' | 'error', title: string, description: string) => {
      toastRef.current.show({
        placement: 'top',
        render: () => (
          <Toast action={action} variant="solid">
            <ToastTitle>{title}</ToastTitle>
            <ToastDescription>{description}</ToastDescription>
          </Toast>
        ),
      });
    },
    [],
  );

  const fail = useCallback(
    (err: unknown, where: string) => {
      logger.captureException(err, { tags: { screen: 'backup', action: where } });
      notify('error', tRef.current('backup.errorTitle'), tRef.current('backup.errorDescription'));
    },
    [notify],
  );

  // Provider availability is a RUNTIME question, re-asked on every entry.
  // iCloud reports unavailable for a window right after launch, so a value
  // cached at startup would be wrong for exactly the people who look here first.
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
        const configured = backupProviderId() !== null && (await isRecoveryCodeConfirmed());
        if (cancelled) return;
        setStage(configured ? 'on' : 'off');
      } catch (err) {
        if (!cancelled) {
          fail(err, 'load');
          setStage('off');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fail, version]);

  // ---- setup ---------------------------------------------------------------

  const beginSetup = useCallback(async () => {
    try {
      setBusy('setup');
      // Idempotent: a second run must not mint a new key and orphan every blob
      // written under the old one.
      setCode(await ensureBackupKey());
      setCodeSaved(false);
      setStage('code');
    } catch (err) {
      fail(err, 'begin-setup');
    } finally {
      setBusy(null);
    }
  }, [fail]);

  const acknowledgeCode = useCallback(async () => {
    try {
      await markRecoveryCodeConfirmed();
      setStage('where');
    } catch (err) {
      fail(err, 'acknowledge-code');
    }
  }, [fail]);

  /** Maps a failed connect onto copy. `cancelled` is silent: it is a choice. */
  const reportDriveFailure = useCallback(
    (result: Exclude<DriveConnectResult, { ok: true }>) => {
      if (result.reason === 'cancelled') return;
      const key =
        result.reason === 'play-services'
          ? 'backup.drivePlayServices'
          : result.reason === 'misconfigured'
            ? 'backup.driveMisconfigured'
            : 'backup.driveFailed';
      // A misconfigured build can only ever be a developer's problem, and they
      // are the only ones who can act on the detail, so it is shown in dev and
      // logged always.
      const detail = 'detail' in result ? result.detail : '';
      if (detail) {
        logger.captureException(new Error(`Drive connect failed: ${detail}`), {
          tags: { screen: 'backup', action: 'connect-drive', reason: result.reason },
        });
      }
      notify(
        'error',
        tRef.current('backup.driveFailedTitle'),
        __DEV__ && detail ? `${tRef.current(key)} (${detail})` : tRef.current(key),
      );
    },
    [notify],
  );

  /**
   * Connect (if needed) and prove the credential really works. Shared by both
   * pickers so the recovery path gets the same round trip as setup: without it
   * a Drive scope problem would surface as an empty backup list rather than an
   * error, which reads as "you have no backups" — the worst possible lie to
   * tell someone who is restoring.
   */
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

  /** Recovery path: read the existing backups from the chosen destination. */
  const chooseRestoreSource = useCallback(
    async (id: BackupProviderId) => {
      try {
        setBusy(id);
        const cloud = await reachProvider(id);
        if (!cloud) return;
        setRestoreSource(id);
        setRestoreOptions(await listBackups(cloud));
      } catch (err) {
        fail(err, 'choose-restore-source');
      } finally {
        setBusy(null);
      }
    },
    [fail, reachProvider],
  );

  const chooseProvider = useCallback(
    async (id: BackupProviderId) => {
      try {
        setBusy(id);
        // Returns null when the user cancelled or the connect failed; the
        // failure has already been reported. `!result.ok` matters here — an
        // earlier version compared the result OBJECT with `!result`, which is
        // always false, and advanced on failure.
        if (!(await reachProvider(id))) return;
        await setBackupProviderId(id);
        setStage('when');
      } catch (err) {
        fail(err, 'choose-provider');
      } finally {
        setBusy(null);
      }
    },
    [fail, reachProvider],
  );

  const chooseCadence = useCallback(
    async (cadence: BackupCadence) => {
      try {
        await setBackupCadence(cadence);
        setStage('on');
        refresh();
      } catch (err) {
        fail(err, 'choose-cadence');
      }
    },
    [fail, refresh],
  );

  // ---- the new-phone path --------------------------------------------------

  const adoptCode = useCallback(async () => {
    try {
      setBusy('adopt');
      const ok = await adoptRecoveryCode(typedCode);
      if (!ok) {
        // Every failure here is a typo, and Crockford already forgives case,
        // hyphens and the I/L/O confusions. So this really does mean wrong.
        notify('error', tRef.current('backup.codeWrongTitle'), tRef.current('backup.codeWrong'));
        return;
      }
      setTypedCode('');
      // The recovery picker, not the setup picker. See the Stage comment.
      setStage('restoreWhere');
    } catch (err) {
      fail(err, 'adopt-code');
    } finally {
      setBusy(null);
    }
  }, [fail, notify, typedCode]);

  // ---- actions -------------------------------------------------------------

  const backUpNow = useCallback(async () => {
    const id = backupProviderId();
    if (!id) return;
    try {
      setBusy('run');
      const result = await runBackup(cloudProviderFor(id) as BackupProvider);
      const rows = result.header.tables.reduce((n, tb) => n + tb.rows, 0);
      notify(
        'success',
        tRef.current('backup.doneTitle'),
        tRef.current('backup.doneDescription', { count: rows }),
      );
      refresh();
    } catch (err) {
      fail(err, 'run-backup');
    } finally {
      setBusy(null);
    }
  }, [fail, notify, refresh]);

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

  const openCloudRestore = useCallback(async () => {
    const id = backupProviderId();
    const cloud = id ? cloudProviderFor(id) : null;
    if (!cloud) return;
    try {
      setBusy('list');
      setRestoreOptions(await listBackups(cloud));
    } catch (err) {
      fail(err, 'list-backups');
    } finally {
      setBusy(null);
    }
  }, [fail]);

  /**
   * Restart the JS runtime so every store re-hydrates from the restored
   * database. Same mechanism `OTAUpdateModal` uses for an in-place restart.
   *
   * If it fails there is nothing clever to do — the data IS restored, the app
   * is just showing stale state — so the user is told to reopen the app rather
   * than left with a success message and an unchanged screen.
   */
  const reloadApp = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Updates = require('expo-updates');
      await Updates.reloadAsync();
    } catch (err) {
      logger.captureException(err, { tags: { screen: 'backup', action: 'reload' } });
      notify(
        'success',
        tRef.current('backup.restoredTitle'),
        tRef.current('backup.restartNeeded'),
      );
    }
  }, [notify]);

  const doCloudRestore = useCallback(async () => {
    // `restoreSource` on the recovery path, the configured provider otherwise.
    const id = restoreSource ?? backupProviderId();
    const cloud = id ? cloudProviderFor(id) : null;
    if (!cloud || !restoreTarget) return;
    const target = restoreTarget;
    setRestoreTarget(null);
    setRestoreOptions(null);
    try {
      setBusy('restore');
      const result = await runRestore(cloud, target);

      // Remember where the backup came from, so the section lands configured
      // rather than asking the user to set up something they clearly already
      // have. Cadence stays at its default until they choose one.
      if (restoreSource) await setBackupProviderId(restoreSource);

      notify(
        'success',
        tRef.current('backup.restoredTitle'),
        tRef.current('backup.restoredDescription', { count: result.rowsRestored }),
      );

      // RELOAD, do not try to re-hydrate. The restore replaced rows underneath
      // every Zustand store in the app, and those stores hydrated once at
      // startup — without this the user is told "13 items restored" and then
      // sees exactly the empty persona they had a moment ago, until they kill
      // the app themselves. Re-hydrating each store individually would mean
      // enumerating them here and getting it wrong the next time one is added.
      await reloadApp();
    } catch (err) {
      fail(err, 'run-restore');
    } finally {
      setBusy(null);
    }
  }, [fail, notify, reloadApp, restoreSource, restoreTarget]);


  const turnOff = useCallback(async () => {
    setConfirmOff(false);
    try {
      setBusy('off');
      await setBackupCadence('off');
      // The key goes too. Anything already saved stays where it is and stays
      // readable only with the written-down code: turning backup off must not
      // silently destroy backups the user already has.
      await clearBackupKey();
      setStage('off');
      refresh();
    } catch (err) {
      fail(err, 'turn-off');
    } finally {
      setBusy(null);
    }
  }, [fail, refresh]);

  // ---- rendering -----------------------------------------------------------

  const row = (
    icon: React.ComponentProps<typeof MaterialIcons>['name'],
    title: string,
    description: string,
    onPress: () => void,
    options: { destructive?: boolean; disabled?: boolean; testID?: string } = {},
  ) => (
    <Pressable
      key={options.testID ?? title}
      testID={options.testID}
      className="flex-row items-center py-3 px-4 border border-gray-700 rounded-lg"
      onPress={onPress}
      disabled={options.disabled || busy !== null}
    >
      <MaterialIcons
        name={icon}
        size={20}
        color={options.disabled ? '#4b5563' : options.destructive ? '#ef4444' : '#ffffff'}
      />
      <VStack className="ml-3 flex-1">
        <Text
          className={
            options.disabled
              ? 'text-base text-gray-600'
              : options.destructive
                ? 'text-base text-red-400'
                : 'text-base text-white'
          }
        >
          {title}
        </Text>
        <Text size="xs" className="text-gray-500">
          {description}
        </Text>
      </VStack>
    </Pressable>
  );

  const codeBox = () => (
    <Box className="bg-gray-900 border border-gray-700 rounded-lg p-4">
      <Text className="text-white text-center" style={{ fontFamily: 'monospace', lineHeight: 26 }}>
        {code ?? ''}
      </Text>
    </Box>
  );

  /** Where the backup actually lives, because neither is visible to the user. */
  const destinationHint = (id: BackupProviderId): string =>
    t(id === 'google-drive' ? 'backup.driveHiddenFolder' : 'backup.icloudHiddenFolder');

  const stalenessLine = (id: BackupProviderId) => {
    const last = backupLastRunAt();
    if (last === null) {
      return (
        <Text size="sm" className="text-amber-400">
          {t('backup.statusNever')}
        </Text>
      );
    }
    const age = Date.now() - last;
    // A scheduled backup can still go stale, because the schedule only advances
    // while the app is OPEN. Someone who does not launch the app for a month
    // has a month-old backup and no reason to suspect it.
    const stale = age > STALE_BACKUP_MS;
    return (
      <Text size="sm" className={stale ? 'text-amber-400' : 'text-gray-400'}>
        {stale
          ? t('backup.statusStale', { days: Math.floor(age / (24 * 60 * 60 * 1000)) })
          : t('backup.statusLast', { when: new Date(last).toLocaleDateString() })}
      </Text>
    );
  };

  const body = () => {
    if (stage === 'loading') {
      return (
        <Box className="items-center py-6">
          <Spinner size="small" />
        </Box>
      );
    }

    if (stage === 'off') {
      return (
        <VStack space="sm">
          <Text size="sm" className="text-gray-400">
            {t('backup.offDescription')}
          </Text>
          <Text size="sm" className="text-gray-400">
            {t('backup.offPrivacy')}
          </Text>
          <Button onPress={beginSetup} isDisabled={busy !== null} testID="backup-set-up">
            <ButtonText>{t('backup.setUp')}</ButtonText>
          </Button>
          {/* The new-phone path. Reachable with backup off, because a fresh
              install has no key and nothing yet to configure. */}
          <Pressable
            testID="backup-already-have"
            className="py-2"
            onPress={() => setStage('adopt')}
            disabled={busy !== null}
          >
            <Text size="sm" className="text-blue-400 text-center">
              {t('backup.alreadyHave')}
            </Text>
          </Pressable>
        </VStack>
      );
    }

    if (stage === 'adopt') {
      return (
        <VStack space="sm">
          <Text className="text-white font-semibold">{t('backup.adoptTitle')}</Text>
          <Text size="sm" className="text-gray-400">
            {t('backup.adoptDescription')}
          </Text>
          <Input className="border-gray-700">
            <InputField
              testID="backup-code-input"
              value={typedCode}
              onChangeText={setTypedCode}
              placeholder={t('backup.adoptPlaceholder')}
              autoCapitalize="characters"
              autoCorrect={false}
              style={{ fontFamily: 'monospace' }}
            />
          </Input>
          <Button
            onPress={adoptCode}
            isDisabled={typedCode.trim().length === 0 || busy !== null}
            testID="backup-adopt-continue"
          >
            <ButtonText>{t('backup.continue')}</ButtonText>
          </Button>
          <Pressable className="py-2" onPress={() => setStage('off')} disabled={busy !== null}>
            <Text size="sm" className="text-gray-500 text-center">
              {t('common.cancel')}
            </Text>
          </Pressable>
        </VStack>
      );
    }

    if (stage === 'code') {
      return (
        <VStack space="sm">
          <Text className="text-white font-semibold">{t('backup.codeTitle')}</Text>
          <Text size="sm" className="text-gray-400">
            {t('backup.codeDescription')}
          </Text>
          {codeBox()}
          <Button variant="outline" onPress={shareCode} testID="backup-share-code">
            <ButtonText>{t('backup.shareCode')}</ButtonText>
          </Button>
          <Pressable
            className="flex-row items-center py-2"
            onPress={() => setCodeSaved((s) => !s)}
            testID="backup-code-saved"
          >
            <MaterialIcons
              name={codeSaved ? 'check-box' : 'check-box-outline-blank'}
              size={22}
              color={codeSaved ? '#22c55e' : '#9ca3af'}
            />
            <Text className="ml-3 flex-1 text-gray-300">{t('backup.codeSaved')}</Text>
          </Pressable>
          <Button onPress={acknowledgeCode} isDisabled={!codeSaved} testID="backup-code-continue">
            <ButtonText>{t('backup.continue')}</ButtonText>
          </Button>
        </VStack>
      );
    }

    if (stage === 'where') {
      return (
        <VStack space="sm">
          <Text className="text-white font-semibold">{t('backup.whereTitle')}</Text>
          <Text size="sm" className="text-gray-400">
            {t('backup.whereDescription')}
          </Text>


          {/* A provider the platform cannot ever support is not rendered at
              all: iCloud on Android is noise, not an option. One that IS
              supported but blocked outside the app renders with a hint,
              because there is something the user can go and do. */}
          {isICloudSupported() &&
            (icloudReady
              ? row('cloud', t('backup.icloud'), t('backup.icloudReady'), () =>
                  chooseProvider('icloud'), { testID: 'backup-pick-icloud' })
              : row('cloud-off', t('backup.icloud'), t('backup.icloudUnavailable'), () => {}, {
                  disabled: true,
                  testID: 'backup-pick-icloud',
                }))}

          {isGoogleDriveConfigured() &&
            row(
              'add-to-drive',
              t('backup.drive'),
              driveReady ? t('backup.driveReady') : t('backup.driveConnect'),
              () => chooseProvider('google-drive'),
              { testID: 'backup-pick-drive' },
            )}
        </VStack>
      );
    }

    if (stage === 'restoreWhere') {
      return (
        <VStack space="sm">
          <Text className="text-white font-semibold">{t('backup.restoreWhereTitle')}</Text>
          <Text size="sm" className="text-gray-400">
            {t('backup.restoreWhereDescription')}
          </Text>
          {isICloudSupported() &&
            (icloudReady
              ? row('cloud', t('backup.icloud'), t('backup.restoreLookHere'), () =>
                  chooseRestoreSource('icloud'), { testID: 'backup-restore-from-icloud' })
              : row('cloud-off', t('backup.icloud'), t('backup.icloudUnavailable'), () => {}, {
                  disabled: true,
                  testID: 'backup-restore-from-icloud',
                }))}
          {isGoogleDriveConfigured() &&
            row(
              'add-to-drive',
              t('backup.drive'),
              driveReady ? t('backup.restoreLookHere') : t('backup.driveConnect'),
              () => chooseRestoreSource('google-drive'),
              { testID: 'backup-restore-from-drive' },
            )}
        </VStack>
      );
    }

    if (stage === 'when') {
      return (
        <VStack space="sm">
          <Text className="text-white font-semibold">{t('backup.whenTitle')}</Text>
          {CADENCES.map((c) =>
            row(
              c === 'manual' ? 'touch-app' : 'schedule',
              t(`backup.cadence.${c}`),
              t(`backup.cadenceHint.${c as Exclude<BackupCadence, 'off'>}`),
              () => chooseCadence(c),
              { testID: `backup-cadence-${c}` },
            ),
          )}
        </VStack>
      );
    }

    const id = backupProviderId() as BackupProviderId;
    return (
      <VStack space="sm">
        <Box className="bg-gray-900 border border-gray-700 rounded-lg p-4">
          <Text className="text-white">
            {t('backup.statusProvider', {
              provider: t(id === 'icloud' ? 'backup.icloud' : 'backup.drive'),
            })}
          </Text>
          <Text size="xs" className="text-gray-500 mt-1">
            {destinationHint(id)}
          </Text>
          <Box className="mt-2">{stalenessLine(id)}</Box>
          <Text size="sm" className="text-gray-400 mt-1">
            {t('backup.statusCadence', { cadence: t(`backup.cadence.${backupCadence()}`) })}
          </Text>
          {/* Restricted has to be a SENTENCE. Background App Refresh off or Low
              Power Mode means backups never run on their own, and silence would
              leave the user believing in a schedule they do not have. */}
          <Text size="xs" className={bgAvailable ? 'text-gray-500 mt-1' : 'text-amber-400 mt-1'}>
            {t(bgAvailable ? 'backup.runsInBackground' : 'backup.backgroundRestricted')}
          </Text>
        </Box>

        {row('backup', t('backup.runNow'), t('backup.runNowHint'), backUpNow, {
          testID: 'backup-run-now',
        })}

        {row(
            backupWifiOnly() ? 'wifi' : 'signal-cellular-alt',
            t('backup.wifiOnly'),
            backupWifiOnly() ? t('backup.wifiOnlyOn') : t('backup.wifiOnlyOff'),
            async () => {
              await setBackupWifiOnly(!backupWifiOnly());
              refresh();
            },
          { testID: 'backup-wifi-toggle' },
        )}

        {/* Without this the cadence chosen during setup was permanent: the
            picker only existed in the setup flow. */}
        {row(
          'schedule',
          t('backup.changeSchedule'),
          t(`backup.cadence.${backupCadence()}`),
          () => setStage('when'),
          { testID: 'backup-change-schedule' },
        )}

        {row('vpn-key', t('backup.showCode'), t('backup.showCodeHint'), openRecoveryCode, {
          testID: 'backup-show-code',
        })}

        {row('settings-backup-restore', t('backup.restore'), t('backup.restoreHint'),
          openCloudRestore, { destructive: true, testID: 'backup-restore' })}


        {row('cloud-off', t('backup.turnOff'), t('backup.turnOffHint'), () => setConfirmOff(true), {
          destructive: true,
          testID: 'backup-turn-off',
        })}
      </VStack>
    );
  };

  return (
    <Box className="border border-gray-700 rounded-lg p-4 mb-5" testID="backup-section">
      <Box className="flex-row items-center mb-3">
        <MaterialIcons name="cloud-upload" size={22} color="#ffffff" />
        <Text className="ml-3 text-base text-white flex-1">{t('backup.title')}</Text>
      </Box>

      {body()}

      {busy !== null && (
        <Box className="items-center py-4">
          <Spinner size="small" />
          <Text size="xs" className="text-gray-500 mt-2">
            {t(busy === 'restore' ? 'backup.restoring' : 'backup.working')}
          </Text>
        </Box>
      )}

      <Modal isOpen={showCode} onClose={() => setShowCode(false)}>
        <ModalBackdrop />
        <ModalContent className="bg-gray-900 border border-gray-700">
          <ModalHeader>
            <Text className="text-lg font-semibold text-white">{t('backup.codeTitle')}</Text>
          </ModalHeader>
          <ModalBody>
            <VStack space="md">
              <Text className="text-gray-300">{t('backup.codeDescription')}</Text>
              {codeBox()}
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" onPress={shareCode} className="mr-2">
              <ButtonText>{t('backup.shareCode')}</ButtonText>
            </Button>
            <Button onPress={() => setShowCode(false)}>
              <ButtonText>{t('common.done')}</ButtonText>
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={restoreOptions !== null} onClose={() => setRestoreOptions(null)}>
        <ModalBackdrop />
        <ModalContent className="bg-gray-900 border border-gray-700">
          <ModalHeader>
            <Text className="text-lg font-semibold text-white">{t('backup.restore')}</Text>
          </ModalHeader>
          <ModalBody>
            <VStack space="sm">
              {(restoreOptions ?? []).length === 0 ? (
                <Text className="text-gray-300">{t('backup.restoreEmpty')}</Text>
              ) : (
                (restoreOptions ?? []).map((path) => (
                  <Pressable
                    key={path}
                    className="py-3 px-3 border border-gray-700 rounded-lg"
                    onPress={() => setRestoreTarget(path)}
                  >
                    <Text className="text-white">{path.split('/').pop()}</Text>
                  </Pressable>
                ))
              )}
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" onPress={() => setRestoreOptions(null)}>
              <ButtonText>{t('common.cancel')}</ButtonText>
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Both restore confirmations say REPLACE rather than leaning on the word
          "restore" to imply it. */}
      <Modal isOpen={restoreTarget !== null} onClose={() => setRestoreTarget(null)}>
        <ModalBackdrop />
        <ModalContent className="bg-gray-900 border border-gray-700">
          <ModalHeader>
            <Text className="text-lg font-semibold text-red-400">
              {t('backup.restoreConfirmTitle')}
            </Text>
          </ModalHeader>
          <ModalBody>
            <Text className="text-gray-300">{t('backup.restoreConfirmDescription')}</Text>
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" onPress={() => setRestoreTarget(null)} className="mr-2">
              <ButtonText>{t('common.cancel')}</ButtonText>
            </Button>
            <Button action="negative" onPress={doCloudRestore} testID="backup-restore-confirm">
              <ButtonText>{t('backup.restoreConfirmAction')}</ButtonText>
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>


      <Modal isOpen={confirmOff} onClose={() => setConfirmOff(false)}>
        <ModalBackdrop />
        <ModalContent className="bg-gray-900 border border-gray-700">
          <ModalHeader>
            <Text className="text-lg font-semibold text-red-400">{t('backup.turnOff')}</Text>
          </ModalHeader>
          <ModalBody>
            <Text className="text-gray-300">{t('backup.turnOffConfirm')}</Text>
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" onPress={() => setConfirmOff(false)} className="mr-2">
              <ButtonText>{t('common.cancel')}</ButtonText>
            </Button>
            <Button action="negative" onPress={turnOff} testID="backup-turn-off-confirm">
              <ButtonText>{t('backup.turnOffAction')}</ButtonText>
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
};

export default BackupSection;
