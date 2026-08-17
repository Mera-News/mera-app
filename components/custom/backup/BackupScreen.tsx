// Backup and restore, the whole user-facing surface.
//
// **Backup is opt-in and stays opt-in.** Nothing here runs until the user
// finishes setup: `backup_cadence` defaults to `off` and `backup_provider` to
// null, so `scheduledBackupEnabled()` is false and the scheduler's condition
// never passes. A user who never opens this screen pays four settings reads at
// startup and nothing else.
//
// **The recovery code comes FIRST in setup, and that order is not cosmetic.**
// `runBackup` refuses until the code has been acknowledged, because a backup
// taken before then uploads under a key that exists only in the keychain — and
// the next logout wipes the keychain, leaving an unopenable blob in the cloud
// that the user believes is their backup. Putting the provider picker first
// would make the finish button look broken instead.
//
// **Restore is destructive and says so before it runs.** It replaces every
// backed-up table on this device. The confirm step spells that out rather than
// leaning on the word "restore" to imply it.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Share } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MaterialIcons } from '@expo/vector-icons';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
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
import { listBackups, runBackup, runRestore } from '@/lib/backup/backup-service';
import {
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
} from '@/lib/backup/providers/google-drive';
import { icloudProvider } from '@/lib/backup/providers/icloud';
import type { BackupCadence, BackupProvider } from '@/lib/backup/types';
import logger from '@/lib/logger';

interface BackupScreenProps {
  onBack?: () => void;
}

type Stage = 'loading' | 'off' | 'code' | 'where' | 'when' | 'on';

const CADENCES: Exclude<BackupCadence, 'off'>[] = ['daily', 'weekly', 'manual'];

function providerFor(id: BackupProviderId): BackupProvider {
  return id === 'icloud' ? icloudProvider : googleDriveProvider;
}

const BackupScreen: React.FC<BackupScreenProps> = ({ onBack }) => {
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { t } = useTranslation();

  const [stage, setStage] = useState<Stage>('loading');
  const [code, setCode] = useState<string | null>(null);
  const [codeSaved, setCodeSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [icloudReady, setIcloudReady] = useState(false);
  const [driveReady, setDriveReady] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [restoreOptions, setRestoreOptions] = useState<readonly string[] | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  // Bumped after any settings write, because backup-settings.ts is a module
  // mirror rather than a store — nothing here re-renders on its own.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // Read through a ref so `notify` and `fail` are STABLE. `useToast()` is not
  // guaranteed to return the same object across renders, and an unstable
  // identity here propagates into the load effect's dependency list: the effect
  // re-runs on every render and re-sets the stage, which snaps the setup wizard
  // straight back to its first screen the moment any state changes. Measured —
  // it made every step past "Set up backup" unreachable.
  const toastRef = useRef(toast);
  toastRef.current = toast;

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

  const tRef = useRef(t);
  tRef.current = t;

  const fail = useCallback(
    (err: unknown, where: string) => {
      logger.captureException(err, { tags: { screen: 'backup', action: where } });
      notify('error', tRef.current('backup.errorTitle'), tRef.current('backup.errorDescription'));
    },
    [notify],
  );

  // Provider availability is a RUNTIME question and is re-asked on every entry.
  // iCloud in particular reports unavailable for a window right after launch,
  // and a value cached at startup would be wrong for exactly the users who
  // open this screen first.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await hydrateBackupSettings();
        const [ic, gd] = await Promise.all([
          icloudProvider.isAvailable(),
          isGoogleDriveConfigured() ? googleDriveProvider.isAvailable() : Promise.resolve(false),
        ]);
        if (cancelled) return;
        setIcloudReady(ic);
        setDriveReady(gd);
        const configured =
          backupProviderId() !== null && (await isRecoveryCodeConfirmed());
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
      // already uploaded under the old one.
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

  const chooseProvider = useCallback(
    async (id: BackupProviderId) => {
      try {
        setBusy(id);
        if (id === 'google-drive' && !driveReady) {
          // Interactive, and only ever from a button press. A scheduled backup
          // that pops an account chooser is a bug.
          const connected = await connectGoogleDrive();
          if (!connected) return;
          setDriveReady(true);
        }
        await setBackupProviderId(id);
        setStage('when');
      } catch (err) {
        fail(err, 'choose-provider');
      } finally {
        setBusy(null);
      }
    },
    [driveReady, fail],
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

  // ---- actions -------------------------------------------------------------

  const backUpNow = useCallback(async () => {
    const id = backupProviderId();
    if (!id) return;
    try {
      setBusy('run');
      const result = await runBackup(providerFor(id));
      const rows = result.header.tables.reduce((n, tb) => n + tb.rows, 0);
      notify('success', t('backup.doneTitle'), t('backup.doneDescription', { count: rows }));
      refresh();
    } catch (err) {
      fail(err, 'run-backup');
    } finally {
      setBusy(null);
    }
  }, [fail, notify, refresh, t]);

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
      // The user dismissing the sheet is not an error.
    }
  }, [code]);

  const openRestore = useCallback(async () => {
    const id = backupProviderId();
    if (!id) return;
    try {
      setBusy('list');
      setRestoreOptions(await listBackups(providerFor(id)));
    } catch (err) {
      fail(err, 'list-backups');
    } finally {
      setBusy(null);
    }
  }, [fail]);

  const doRestore = useCallback(async () => {
    const id = backupProviderId();
    if (!id || !restoreTarget) return;
    const target = restoreTarget;
    setRestoreTarget(null);
    setRestoreOptions(null);
    try {
      setBusy('restore');
      const result = await runRestore(providerFor(id), target);
      notify(
        'success',
        t('backup.restoredTitle'),
        t('backup.restoredDescription', { count: result.rowsRestored }),
      );
    } catch (err) {
      fail(err, 'run-restore');
    } finally {
      setBusy(null);
    }
  }, [fail, notify, restoreTarget, t]);

  const turnOff = useCallback(async () => {
    setConfirmOff(false);
    try {
      setBusy('off');
      await setBackupCadence('off');
      // The key goes too. Anything already in the cloud stays there and stays
      // readable only by the written-down code, which is the honest outcome:
      // turning backup off must not silently delete backups the user has.
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
      key={title}
      testID={options.testID}
      className="flex-row items-center py-4 px-4 border border-gray-700 rounded-lg"
      onPress={onPress}
      disabled={options.disabled || busy !== null}
    >
      <MaterialIcons name={icon} size={22} color={options.destructive ? '#ef4444' : '#ffffff'} />
      <VStack className="ml-3 flex-1">
        <Text className={options.destructive ? 'text-base text-red-400' : 'text-base text-white'}>
          {title}
        </Text>
        <Text size="xs" className="text-gray-500">
          {description}
        </Text>
      </VStack>
    </Pressable>
  );

  const renderCode = () => (
    <Box className="bg-gray-900 border border-gray-700 rounded-lg p-4">
      <Text className="text-white text-center" style={{ fontFamily: 'monospace', lineHeight: 26 }}>
        {code ?? ''}
      </Text>
    </Box>
  );

  const body = () => {
    if (stage === 'loading') {
      return (
        <Box className="items-center py-10">
          <Spinner size="small" />
        </Box>
      );
    }

    if (stage === 'off') {
      return (
        <VStack space="md">
          <Text size="sm" className="text-gray-400">
            {t('backup.offDescription')}
          </Text>
          <Text size="sm" className="text-gray-400">
            {t('backup.offPrivacy')}
          </Text>
          <Button onPress={beginSetup} isDisabled={busy !== null} testID="backup-set-up">
            <ButtonText>{t('backup.setUp')}</ButtonText>
          </Button>
        </VStack>
      );
    }

    if (stage === 'code') {
      return (
        <VStack space="md">
          <Text className="text-white text-lg font-semibold">{t('backup.codeTitle')}</Text>
          <Text size="sm" className="text-gray-400">
            {t('backup.codeDescription')}
          </Text>
          {renderCode()}
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
        <VStack space="md">
          <Text className="text-white text-lg font-semibold">{t('backup.whereTitle')}</Text>
          <Text size="sm" className="text-gray-400">
            {t('backup.whereDescription')}
          </Text>
          {icloudReady
            ? row(
                'cloud',
                t('backup.icloud'),
                t('backup.icloudReady'),
                () => chooseProvider('icloud'),
                { testID: 'backup-pick-icloud' },
              )
            : row('cloud-off', t('backup.icloud'), t('backup.icloudUnavailable'), () => {}, {
                disabled: true,
              })}
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

    if (stage === 'when') {
      return (
        <VStack space="md">
          <Text className="text-white text-lg font-semibold">{t('backup.whenTitle')}</Text>
          {CADENCES.map((c) =>
            row(
              c === 'manual' ? 'touch-app' : 'schedule',
              t(`backup.cadence.${c}`),
              // `backup.cadenceHint` deliberately has no `off` member — `off`
              // is a status, not something you can schedule — so the key type
              // is narrowed here rather than adding a string nobody renders.
              t(`backup.cadenceHint.${c as Exclude<BackupCadence, 'off'>}`),
              () => chooseCadence(c),
              { testID: `backup-cadence-${c}` },
            ),
          )}
        </VStack>
      );
    }

    const id = backupProviderId();
    const last = backupLastRunAt();
    return (
      <VStack space="md">
        <Box className="bg-gray-900 border border-gray-700 rounded-lg p-4">
          <Text className="text-white">
            {t('backup.statusProvider', {
              provider: t(id === 'icloud' ? 'backup.icloud' : 'backup.drive'),
            })}
          </Text>
          <Text size="sm" className="text-gray-400 mt-1">
            {t('backup.statusCadence', { cadence: t(`backup.cadence.${backupCadence()}`) })}
          </Text>
          <Text size="sm" className="text-gray-400 mt-1">
            {last
              ? t('backup.statusLast', { when: new Date(last).toLocaleString() })
              : t('backup.statusNever')}
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
        {row('vpn-key', t('backup.showCode'), t('backup.showCodeHint'), openRecoveryCode, {
          testID: 'backup-show-code',
        })}
        {row('settings-backup-restore', t('backup.restore'), t('backup.restoreHint'), openRestore, {
          destructive: true,
          testID: 'backup-restore',
        })}
        {row('cloud-off', t('backup.turnOff'), t('backup.turnOffHint'), () => setConfirmOff(true), {
          destructive: true,
          testID: 'backup-turn-off',
        })}
      </VStack>
    );
  };

  return (
    <GluestackUIProvider mode="dark">
      <Box className="flex-1">
        {/* Page background. Must be the FIRST child so it paints behind
            everything else on the page. */}
        <AbstractGradientBackdrop />

        {onBack && (
          <Box style={{ position: 'absolute', top: insets.top + 16, left: 16, zIndex: 20 }}>
            <Pressable onPress={onBack} className="bg-gray-900 rounded-full p-3 shadow-hard-2">
              <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
            </Pressable>
          </Box>
        )}

        <VStack className="px-5 pb-5" style={{ paddingTop: insets.top + 16 }}>
          <Text className="text-xl font-semibold text-white text-center">{t('backup.title')}</Text>
        </VStack>

        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        >
          {body()}
          {busy !== null && (
            <Box className="items-center py-6">
              <Spinner size="small" />
              <Text size="xs" className="text-gray-500 mt-2">
                {t(busy === 'restore' ? 'backup.restoring' : 'backup.working')}
              </Text>
            </Box>
          )}
        </ScrollView>

        {/* Recovery code, re-shown on request. */}
        <Modal isOpen={showCode} onClose={() => setShowCode(false)}>
          <ModalBackdrop />
          <ModalContent className="bg-gray-900 border border-gray-700">
            <ModalHeader>
              <Text className="text-lg font-semibold text-white">{t('backup.codeTitle')}</Text>
            </ModalHeader>
            <ModalBody>
              <VStack space="md">
                <Text className="text-gray-300">{t('backup.codeDescription')}</Text>
                {renderCode()}
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

        {/* Pick a backup to restore. */}
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

        {/* Restore confirmation. Says REPLACE rather than leaning on the word
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
              <Button action="negative" onPress={doRestore} testID="backup-restore-confirm">
                <ButtonText>{t('backup.restoreConfirmAction')}</ButtonText>
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>

        {/* Turning backup off. */}
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
    </GluestackUIProvider>
  );
};

export default BackupScreen;
