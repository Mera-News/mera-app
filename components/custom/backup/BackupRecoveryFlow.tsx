// "I already have a backup" — the recovery flow, shared by two surfaces.
//
// It is extracted rather than duplicated because the two entry points must not
// drift. Both need the same confirm wording (a restore REPLACES), the same
// connect-and-verify round trip, and above all the same RELOAD afterwards —
// and a second copy is exactly how one of those quietly stops matching.
//
// Used by:
//   - `components/custom/onboarding/OnboardingScreen` as a pre-wizard step, so
//     a returning user gets their persona back instead of rebuilding it. The
//     rest of onboarding then skips ITSELF: it gates on local facts, and a
//     restore writes facts.
//   - `components/custom/backup/BackupSection` for the same flow in settings.
//
// The flow is: enter the written-down code -> adopt it as the key -> say where
// the backup lives -> see what is actually there -> confirm -> restore ->
// reload. Nothing is destroyed before that confirm.

import React, { useCallback, useRef, useState } from 'react';
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

import { setBackupProviderId, type BackupProviderId } from '@/lib/backup/backup-settings';
import { listBackups, runRestore, verifyProviderAccess } from '@/lib/backup/backup-service';
import { adoptRecoveryCode } from '@/lib/backup/key-store';
import {
  connectGoogleDrive,
  googleDriveProvider,
  isGoogleDriveConfigured,
  type DriveConnectResult,
} from '@/lib/backup/providers/google-drive';
import { icloudProvider, isICloudSupported } from '@/lib/backup/providers/icloud';
import type { BackupProvider } from '@/lib/backup/types';
import logger from '@/lib/logger';

export interface BackupRecoveryFlowProps {
  /** The user declined, or has no backup. */
  onSkip: () => void;
  /** Label for the decline control, so each surface can word it for itself. */
  skipLabel: string;
  /** Optional lead-in above the code field. */
  introText?: string;
  /**
   * Only reached if the post-restore reload FAILED. The data is restored and
   * the app is showing stale state, so a caller that can do something better
   * than "please reopen the app" may.
   */
  onRestoredWithoutReload?: () => void;
}

type Step = 'code' | 'source';

function cloudProviderFor(id: BackupProviderId): BackupProvider | null {
  if (id === 'icloud') return icloudProvider;
  if (id === 'google-drive') return googleDriveProvider;
  return null;
}

const BackupRecoveryFlow: React.FC<BackupRecoveryFlowProps> = ({
  onSkip,
  skipLabel,
  introText,
  onRestoredWithoutReload,
}) => {
  const toast = useToast();
  const { t } = useTranslation();

  const [step, setStep] = useState<Step>('code');
  const [typedCode, setTypedCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [driveReady, setDriveReady] = useState(false);
  const [source, setSource] = useState<BackupProviderId | null>(null);
  const [options, setOptions] = useState<readonly string[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  // Read through refs: neither hook guarantees a stable identity, and an
  // unstable one in a callback dependency list is what made an earlier version
  // of this flow reset itself on every render.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tRef = useRef(t);
  tRef.current = t;

  const notify = useCallback((action: 'success' | 'error', title: string, description: string) => {
    toastRef.current.show({
      placement: 'top',
      render: () => (
        <Toast action={action} variant="solid">
          <ToastTitle>{title}</ToastTitle>
          <ToastDescription>{description}</ToastDescription>
        </Toast>
      ),
    });
  }, []);

  const fail = useCallback(
    (err: unknown, where: string) => {
      logger.captureException(err, { tags: { screen: 'backup-recovery', action: where } });
      notify('error', tRef.current('backup.errorTitle'), tRef.current('backup.errorDescription'));
    },
    [notify],
  );

  const reportDriveFailure = useCallback(
    (result: Exclude<DriveConnectResult, { ok: true }>) => {
      // Cancelling is a choice, not an error to shout about.
      if (result.reason === 'cancelled') return;
      const key =
        result.reason === 'play-services'
          ? 'backup.drivePlayServices'
          : result.reason === 'misconfigured'
            ? 'backup.driveMisconfigured'
            : 'backup.driveFailed';
      const detail = 'detail' in result ? result.detail : '';
      if (detail) {
        logger.captureException(new Error(`Drive connect failed: ${detail}`), {
          tags: { screen: 'backup-recovery', reason: result.reason },
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

  const enterCode = useCallback(async () => {
    try {
      setBusy(true);
      const ok = await adoptRecoveryCode(typedCode);
      if (!ok) {
        // Crockford already forgives case, hyphens and the I/L/O confusions,
        // so a rejection here really does mean the code is wrong.
        notify('error', tRef.current('backup.codeWrongTitle'), tRef.current('backup.codeWrong'));
        return;
      }
      setTypedCode('');
      setStep('source');
    } catch (err) {
      fail(err, 'adopt-code');
    } finally {
      setBusy(false);
    }
  }, [fail, notify, typedCode]);

  const chooseSource = useCallback(
    async (id: BackupProviderId) => {
      try {
        setBusy(true);
        if (id === 'google-drive' && !driveReady) {
          const result = await connectGoogleDrive();
          // An OBJECT, so `!result` would always be false.
          if (!result.ok) {
            reportDriveFailure(result);
            return;
          }
          setDriveReady(true);
        }
        const cloud = cloudProviderFor(id);
        if (!cloud) return;
        // A real round trip first. Without it a permissions problem surfaces as
        // an empty list, and "you have no backups" is the worst possible thing
        // to tell someone who is trying to recover one.
        await verifyProviderAccess(cloud);
        setSource(id);
        setOptions(await listBackups(cloud));
      } catch (err) {
        fail(err, 'choose-source');
      } finally {
        setBusy(false);
      }
    },
    [driveReady, fail, reportDriveFailure],
  );

  const confirmRestore = useCallback(async () => {
    const cloud = source ? cloudProviderFor(source) : null;
    if (!cloud || !target) return;
    const path = target;
    setTarget(null);
    setOptions(null);
    try {
      setBusy(true);
      const result = await runRestore(cloud, path);
      // Where their backup lives is now known, so the settings section lands
      // configured instead of asking them to set up what they plainly have.
      if (source) await setBackupProviderId(source);

      notify(
        'success',
        tRef.current('backup.restoredTitle'),
        tRef.current('backup.restoredDescription', { count: result.rowsRestored }),
      );

      // RELOAD rather than re-hydrate. The restore replaced rows underneath
      // every Zustand store, and those hydrate once at startup — without this
      // the user is told "restored" and shown the same empty persona. Doing it
      // per-store would mean listing them here and forgetting the next one.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Updates = require('expo-updates');
        await Updates.reloadAsync();
      } catch (err) {
        logger.captureException(err, { tags: { screen: 'backup-recovery', action: 'reload' } });
        notify(
          'success',
          tRef.current('backup.restoredTitle'),
          tRef.current('backup.restartNeeded'),
        );
        onRestoredWithoutReload?.();
      }
    } catch (err) {
      fail(err, 'run-restore');
    } finally {
      setBusy(false);
    }
  }, [fail, notify, onRestoredWithoutReload, source, target]);

  const sourceRow = (
    id: BackupProviderId,
    icon: React.ComponentProps<typeof MaterialIcons>['name'],
    label: string,
    hint: string,
    disabled = false,
  ) => (
    <Pressable
      testID={`recovery-source-${id}`}
      className="flex-row items-center py-3 px-4 border border-gray-700 rounded-lg"
      onPress={() => chooseSource(id)}
      disabled={disabled || busy}
    >
      <MaterialIcons name={icon} size={20} color={disabled ? '#4b5563' : '#ffffff'} />
      <VStack className="ml-3 flex-1">
        <Text className={disabled ? 'text-base text-gray-600' : 'text-base text-white'}>
          {label}
        </Text>
        <Text size="xs" className="text-gray-500">
          {hint}
        </Text>
      </VStack>
    </Pressable>
  );

  return (
    <VStack space="sm">
      {step === 'code' ? (
        <>
          <Text className="text-white font-semibold">{t('backup.adoptTitle')}</Text>
          <Text size="sm" className="text-gray-400">
            {introText ?? t('backup.adoptDescription')}
          </Text>
          <Input className="border-gray-700">
            <InputField
              testID="recovery-code-input"
              value={typedCode}
              onChangeText={setTypedCode}
              placeholder={t('backup.adoptPlaceholder')}
              autoCapitalize="characters"
              autoCorrect={false}
              style={{ fontFamily: 'monospace' }}
            />
          </Input>
          <Button
            onPress={enterCode}
            isDisabled={typedCode.trim().length === 0 || busy}
            testID="recovery-continue"
          >
            <ButtonText>{t('backup.continue')}</ButtonText>
          </Button>
        </>
      ) : (
        <>
          <Text className="text-white font-semibold">{t('backup.restoreWhereTitle')}</Text>
          <Text size="sm" className="text-gray-400">
            {t('backup.restoreWhereDescription')}
          </Text>
          {/* A platform that can never support a destination gets no row at
              all; one that is merely blocked outside the app gets a hint. */}
          {isICloudSupported() &&
            sourceRow('icloud', 'cloud', t('backup.icloud'), t('backup.restoreLookHere'))}
          {isGoogleDriveConfigured() &&
            sourceRow(
              'google-drive',
              'add-to-drive',
              t('backup.drive'),
              driveReady ? t('backup.restoreLookHere') : t('backup.driveConnect'),
            )}
        </>
      )}

      <Pressable className="py-3" onPress={onSkip} disabled={busy} testID="recovery-skip">
        <Text size="sm" className="text-gray-500 text-center">
          {skipLabel}
        </Text>
      </Pressable>

      {busy && (
        <Box className="items-center py-2">
          <Spinner size="small" />
        </Box>
      )}

      {/* What is actually there. Shown before anything is replaced. */}
      <Modal isOpen={options !== null} onClose={() => setOptions(null)}>
        <ModalBackdrop />
        <ModalContent className="bg-gray-900 border border-gray-700">
          <ModalHeader>
            <Text className="text-lg font-semibold text-white">{t('backup.restore')}</Text>
          </ModalHeader>
          <ModalBody>
            <VStack space="sm">
              {(options ?? []).length === 0 ? (
                <Text className="text-gray-300">{t('backup.restoreEmpty')}</Text>
              ) : (
                (options ?? []).map((path) => (
                  <Pressable
                    key={path}
                    className="py-3 px-3 border border-gray-700 rounded-lg"
                    onPress={() => setTarget(path)}
                  >
                    <Text className="text-white">{path.split('/').pop()}</Text>
                  </Pressable>
                ))
              )}
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" onPress={() => setOptions(null)}>
              <ButtonText>{t('common.cancel')}</ButtonText>
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Says REPLACE rather than leaning on "restore" to imply it. */}
      <Modal isOpen={target !== null} onClose={() => setTarget(null)}>
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
            <Button variant="outline" onPress={() => setTarget(null)} className="mr-2">
              <ButtonText>{t('common.cancel')}</ButtonText>
            </Button>
            <Button action="negative" onPress={confirmRestore} testID="recovery-confirm">
              <ButtonText>{t('backup.restoreConfirmAction')}</ButtonText>
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </VStack>
  );
};

export default BackupRecoveryFlow;
