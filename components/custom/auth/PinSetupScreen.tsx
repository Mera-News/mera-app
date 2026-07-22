import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import PinKeypad from '@/components/custom/auth/PinKeypad';
import logger from '@/lib/logger';
import { setPin as savePin } from '@/lib/security/pin-service';
import { usePinStore } from '@/lib/stores/pin-store';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PIN_LENGTH = 4;

interface PinSetupScreenProps {
  // Called once the new PIN is persisted. The caller owns navigation (route
  // wrapper → /logged-in; onboarding step → advance; settings → back).
  onComplete: () => void;
  title?: string;
  subtitle?: string;
  // Change-PIN flows can offer an escape hatch; setup/onboarding cannot.
  onCancel?: () => void;
}

type Phase = 'enter' | 'confirm';

const PinSetupScreen: React.FC<PinSetupScreenProps> = ({
  onComplete,
  title,
  subtitle,
  onCancel,
}) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<Phase>('enter');
  const [firstPin, setFirstPin] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const persist = useCallback(
    async (value: string) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      const submitStart = Date.now();
      try {
        await savePin(value);
        logger.info(`[pin-timing] PinSetupScreen submit→done ${Date.now() - submitStart}ms`);
        usePinStore.getState().setPinSet(true);
        onComplete();
      } catch (err) {
        logger.captureException(err, {
          tags: { screen: 'PinSetupScreen', method: 'persist' },
        });
        // Reset the whole flow on a storage failure.
        setError(true);
        setPhase('enter');
        setFirstPin('');
        setPin('');
      } finally {
        setSaving(false);
        savingRef.current = false;
      }
    },
    [onComplete],
  );

  // Drive phase transitions when a 4-digit entry completes.
  useEffect(() => {
    if (pin.length !== PIN_LENGTH) return;
    if (phase === 'enter') {
      setFirstPin(pin);
      setPin('');
      setPhase('confirm');
      return;
    }
    // confirm phase
    if (pin === firstPin) {
      void persist(pin);
    } else {
      setError(true);
      setPin('');
      setFirstPin('');
      setPhase('enter');
    }
  }, [pin, phase, firstPin, persist]);

  const handleChange = (next: string) => {
    if (saving) return;
    if (error) setError(false);
    setPin(next);
  };

  const heading = phase === 'enter' ? (title ?? t('pin.setupTitle')) : t('pin.confirmTitle');
  const sub = phase === 'enter' ? (subtitle ?? t('pin.setupSubtitle')) : t('pin.confirmSubtitle');

  return (
    <Box className="flex-1 bg-black" style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}>
      <VStack className="flex-1 px-6 items-center justify-center" space="lg">
        <MeraLogo size={88} />

        <VStack className="items-center" space="xs">
          <Text className="text-white text-xl font-semibold">{heading}</Text>
          <Text className="text-typography-500 text-sm text-center">{sub}</Text>
        </VStack>

        <Box className="mt-6">
          <PinKeypad
            value={pin}
            onChange={handleChange}
            length={PIN_LENGTH}
            disabled={saving}
            error={error}
          />
        </Box>

        <Box className="h-6 items-center justify-center">
          {saving ? (
            <Spinner size="small" />
          ) : error ? (
            <Text className="text-error-400 text-sm">{t('pin.mismatch')}</Text>
          ) : null}
        </Box>

        {onCancel && (
          <Pressable onPress={onCancel} hitSlop={8}>
            <Text className="text-primary-400 text-sm">{t('common.cancel')}</Text>
          </Pressable>
        )}
      </VStack>
    </Box>
  );
};

export default PinSetupScreen;
