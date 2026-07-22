import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import PinLockScreen from '@/components/custom/auth/PinLockScreen';
import PinSetupScreen from '@/components/custom/auth/PinSetupScreen';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface SecuritySettingsScreenProps {
  onBack: () => void;
}

// menu → verify current PIN → set new PIN.
type Mode = 'menu' | 'verify' | 'set';

const SecuritySettingsScreen: React.FC<SecuritySettingsScreenProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('menu');

  const handleNewPinComplete = async () => {
    // PinSetupScreen already persisted via its own setPin; nothing extra to do
    // besides confirming and returning to the menu.
    setMode('menu');
    toast.show({
      placement: 'top',
      render: () => (
        <Toast action="success" variant="solid">
          <ToastTitle>{t('security.pinChangedTitle')}</ToastTitle>
          <ToastDescription>{t('security.pinChangedDescription')}</ToastDescription>
        </Toast>
      ),
    });
  };

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
    <Box className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
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
        <Pressable
          className="flex-row items-center justify-between py-3 px-4 mb-3 border border-gray-700 rounded-lg"
          onPress={() => setMode('verify')}
        >
          <Text className="text-base text-white">{t('security.changePin')}</Text>
          <MaterialIcons name="chevron-right" size={20} color="#999999" />
        </Pressable>
      </VStack>
    </Box>
  );
};

export default SecuritySettingsScreen;
