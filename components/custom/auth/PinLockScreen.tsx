import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import PinKeypad from '@/components/custom/auth/PinKeypad';
import logger from '@/lib/logger';
import { getCooldownRemainingMs, verifyPin } from '@/lib/security/pin-service';
import { useIsConnected } from '@/lib/stores/network-store';
import { usePinStore } from '@/lib/stores/pin-store';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PIN_LENGTH = 4;

interface PinLockScreenProps {
  onUnlock: () => void;
  // Forgot-PIN routes to OTP re-login. Hidden when this screen is reused to
  // verify the current PIN inside Settings → Change PIN.
  showForgot?: boolean;
  onForgot?: () => void;
  title?: string;
  subtitle?: string;
}

const fmtCountdown = (ms: number): string => {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
};

const PinLockScreen: React.FC<PinLockScreenProps> = ({
  onUnlock,
  showForgot = true,
  onForgot,
  title,
  subtitle,
}) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isConnected = useIsConnected();

  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [cooldownMs, setCooldownMs] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [showForgotModal, setShowForgotModal] = useState(false);
  const submittingRef = useRef(false);

  // Seed any active lockout on mount so a relaunch shows the remaining time.
  useEffect(() => {
    getCooldownRemainingMs().then(setCooldownMs).catch(() => {});
  }, []);

  // Tick down the cooldown.
  useEffect(() => {
    if (cooldownMs <= 0) return;
    const id = setInterval(() => {
      setCooldownMs((prev) => (prev <= 1000 ? 0 : prev - 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownMs > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = useCallback(
    async (candidate: string) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setVerifying(true);
      try {
        const result = await verifyPin(candidate);
        if (result.success) {
          usePinStore.getState().unlock();
          onUnlock();
          return;
        }
        setError(true);
        setPin('');
        if (result.remainingMs && result.remainingMs > 0) {
          setCooldownMs(result.remainingMs);
        }
      } catch (err) {
        logger.captureException(err, {
          tags: { screen: 'PinLockScreen', method: 'submit' },
        });
        setError(true);
        setPin('');
      } finally {
        setVerifying(false);
        submittingRef.current = false;
      }
    },
    [onUnlock],
  );

  // Auto-submit once the PIN is complete.
  useEffect(() => {
    if (pin.length === PIN_LENGTH && !submittingRef.current) {
      void submit(pin);
    }
  }, [pin, submit]);

  const handleChange = (next: string) => {
    if (cooldownMs > 0 || verifying) return;
    if (error) setError(false);
    setPin(next);
  };

  const locked = cooldownMs > 0;

  return (
    <Box className="flex-1 bg-black" style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}>
      <VStack className="flex-1 px-6 items-center justify-center" space="lg">
        <MeraLogo size={88} />

        <VStack className="items-center" space="xs">
          <Text className="text-white text-xl font-semibold">
            {title ?? t('pin.lockTitle')}
          </Text>
          <Text className="text-typography-500 text-sm text-center">
            {subtitle ?? t('pin.lockSubtitle')}
          </Text>
        </VStack>

        <Box className="mt-6">
          <PinKeypad
            value={pin}
            onChange={handleChange}
            length={PIN_LENGTH}
            disabled={locked || verifying}
            error={error}
          />
        </Box>

        <Box className="h-6 items-center justify-center">
          {locked ? (
            <Text className="text-error-400 text-sm">
              {t('pin.lockedTryAgain', { time: fmtCountdown(cooldownMs) })}
            </Text>
          ) : error ? (
            <Text className="text-error-400 text-sm">{t('pin.incorrect')}</Text>
          ) : null}
        </Box>

        {showForgot && (
          <Pressable onPress={() => setShowForgotModal(true)} hitSlop={8}>
            <Text className="text-primary-400 text-sm">{t('pin.forgot')}</Text>
          </Pressable>
        )}
      </VStack>

      <Modal isOpen={showForgotModal} onClose={() => setShowForgotModal(false)} size="sm">
        <ModalBackdrop />
        <ModalContent>
          <ModalHeader className="border-gray-700 pb-4">
            <Text className="text-xl font-semibold text-white">{t('pin.forgotTitle')}</Text>
          </ModalHeader>
          <ModalBody className="py-6">
            <Text className="text-gray-300 text-base leading-relaxed">
              {isConnected ? t('pin.forgotBody') : t('pin.forgotOffline')}
            </Text>
          </ModalBody>
          <ModalFooter className="border-t border-gray-700 pt-4">
            <VStack className="w-full" space="md">
              <Button
                action="primary"
                onPress={() => {
                  setShowForgotModal(false);
                  onForgot?.();
                }}
                isDisabled={!isConnected}
                className="w-full"
              >
                <ButtonText>{t('pin.forgotConfirm')}</ButtonText>
              </Button>
              <Button
                variant="outline"
                action="secondary"
                onPress={() => setShowForgotModal(false)}
                className="w-full"
              >
                <ButtonText>{t('common.cancel')}</ButtonText>
              </Button>
            </VStack>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
};

export default PinLockScreen;
