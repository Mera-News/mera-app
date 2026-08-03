import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import PinLockScreen from '@/components/custom/auth/PinLockScreen';
import PinSetupScreen from '@/components/custom/auth/PinSetupScreen';
import logger from '@/lib/logger';
import { useBlurImagesStore } from '@/lib/stores/blur-images-store';
import { usePinStore } from '@/lib/stores/pin-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface SecuritySettingsScreenProps {
  onBack: () => void;
}

// menu → verify current PIN → set new PIN (change flow), plus enable → set the
// first PIN (turning the lock on).
type Mode = 'menu' | 'verify' | 'set' | 'enable';

const SecuritySettingsScreen: React.FC<SecuritySettingsScreenProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('menu');
  // Tracks the full verify→set journey (two sequential pin-service hashes,
  // split across PinLockScreen and PinSetupScreen) for [pin-timing] logging.
  const changePinStartRef = useRef(0);

  const lockEnabled = usePinStore((s) => s.lockEnabled);
  const setLockEnabled = usePinStore((s) => s.setLockEnabled);
  const blurImages = useBlurImagesStore((s) => s.blurImages);
  const setBlurImages = useBlurImagesStore((s) => s.setBlurImages);
  // Guards the toggle against a second tap while the secure-store write from
  // the first is still in flight.
  const [lockBusy, setLockBusy] = useState(false);

  const showToast = (title: string, description: string) => {
    toast.show({
      placement: 'top',
      render: () => (
        <Toast action="success" variant="solid">
          <ToastTitle>{title}</ToastTitle>
          <ToastDescription>{description}</ToastDescription>
        </Toast>
      ),
    });
  };

  const handleLockToggle = async () => {
    if (lockBusy) return;
    // Turning it ON means choosing a PIN first — the flag is only written once
    // a fresh record exists, so a cancelled setup leaves the lock off.
    if (!lockEnabled) {
      setMode('enable');
      return;
    }
    setLockBusy(true);
    try {
      await setLockEnabled(false);
      showToast(t('security.lockDisabledTitle'), t('security.lockDisabledDescription'));
    } catch (err) {
      logger.captureException(err, {
        tags: { screen: 'SecuritySettingsScreen', method: 'handleLockToggle' },
      });
    } finally {
      setLockBusy(false);
    }
  };

  // Turning the lock on: PinSetupScreen has already persisted the new record,
  // so all that's left is recording the opt-in.
  const handleEnableComplete = async () => {
    setLockBusy(true);
    try {
      await setLockEnabled(true);
      setMode('menu');
      showToast(t('security.lockEnabledTitle'), t('security.lockEnabledDescription'));
    } catch (err) {
      logger.captureException(err, {
        tags: { screen: 'SecuritySettingsScreen', method: 'handleEnableComplete' },
      });
      setMode('menu');
    } finally {
      setLockBusy(false);
    }
  };

  const handleNewPinComplete = async () => {
    // PinSetupScreen already persisted via its own setPin; nothing extra to do
    // besides confirming and returning to the menu.
    logger.info(
      `[pin-timing] SecuritySettingsScreen submit→done ${Date.now() - changePinStartRef.current}ms`,
    );
    setMode('menu');
    showToast(t('security.pinChangedTitle'), t('security.pinChangedDescription'));
  };

  if (mode === 'enable') {
    return (
      <PinSetupScreen
        onComplete={handleEnableComplete}
        onCancel={() => setMode('menu')}
        title={t('security.setPinTitle')}
        subtitle={t('security.setPinSubtitle')}
      />
    );
  }

  if (mode === 'verify') {
    return (
      <PinLockScreen
        onUnlock={() => setMode('set')}
        showForgot={false}
        title={t('security.verifyCurrentTitle')}
        subtitle={t('security.verifyCurrentSubtitle')}
      />
    );
  }

  if (mode === 'set') {
    return (
      <PinSetupScreen
        onComplete={handleNewPinComplete}
        onCancel={() => setMode('menu')}
        title={t('security.newPinTitle')}
        subtitle={t('security.newPinSubtitle')}
      />
    );
  }

  return (
    // Unpadded wrapper. The backdrop hangs off THIS box, not the padded one
    // below, so it spans the FULL screen including the safe areas — an
    // absolute fill resolves against its parent's CONTENT box, so mounting it
    // inside the padded box left a black strip in the inset.
    <Box className="flex-1">
        {/* Page background. Must be the FIRST child so it paints behind
            everything else on the page. */}
        <AbstractGradientBackdrop />

        {/* No opaque fill: the backdrop above is the page background. */}
        <Box className="flex-1" style={{ paddingTop: insets.top }}>

      <HStack className="items-center px-4 py-3" space="sm">
        <Pressable onPress={onBack} hitSlop={8} className="p-1">
          <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
        </Pressable>
        <Text className="text-white text-lg font-semibold">{t('security.title')}</Text>
      </HStack>

      <VStack className="px-5 pt-2 pb-3">
        <Text size="sm" className="text-gray-400">
          {t('security.subtitle')}
        </Text>
      </VStack>

      <VStack className="px-5">
        <HStack className="items-center justify-between py-3 px-4 mb-3 border border-gray-700 rounded-lg">
          <HStack space="md" className="items-center flex-1 pr-3">
            <MaterialIcons
              name={lockEnabled ? 'lock' : 'lock-open'}
              size={24}
              color={lockEnabled ? '#10b981' : '#9ca3af'}
            />
            <VStack className="flex-1">
              <Text className="text-base text-white">{t('security.requirePinTitle')}</Text>
              <Text size="sm" className="text-gray-400 mt-0.5">
                {t('security.requirePinDescription')}
              </Text>
            </VStack>
          </HStack>

          {lockBusy ? (
            <Spinner size="small" />
          ) : (
            <Switch value={lockEnabled} onToggle={handleLockToggle} size="md" />
          )}
        </HStack>

        {/* Changing the PIN is only meaningful while the lock is on — with it
            off there is no record to change. */}
        {lockEnabled && (
          <Pressable
            className="flex-row items-center justify-between py-3 px-4 mb-3 border border-gray-700 rounded-lg"
            onPress={() => {
              changePinStartRef.current = Date.now();
              setMode('verify');
            }}
          >
            <Text className="text-base text-white">{t('security.changePin')}</Text>
            <MaterialIcons name="chevron-right" size={20} color="#999999" />
          </Pressable>
        )}

        <HStack className="items-center justify-between py-3 px-4 mb-3 border border-gray-700 rounded-lg">
          <HStack space="md" className="items-center flex-1 pr-3">
            <MaterialIcons
              name="blur-on"
              size={24}
              color={blurImages ? '#10b981' : '#9ca3af'}
            />
            <VStack className="flex-1">
              <Text className="text-base text-white">{t('security.blurImagesTitle')}</Text>
              <Text size="sm" className="text-gray-400 mt-0.5">
                {t('security.blurImagesDescription')}
              </Text>
            </VStack>
          </HStack>

          <Switch testID="blur-images-switch" value={blurImages} onToggle={setBlurImages} size="md" />
        </HStack>
      </VStack>
    </Box>
    </Box>
  );
};

export default SecuritySettingsScreen;
