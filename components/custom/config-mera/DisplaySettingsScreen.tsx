import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface DisplaySettingsScreenProps {
  onBack: () => void;
}

const DisplaySettingsScreen: React.FC<DisplaySettingsScreenProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);
  const setStaticGradient = useDisplayPrefsStore((s) => s.setStaticGradient);

  return (
    // Unpadded wrapper. The backdrop hangs off THIS box, not the padded one
    // below, so it spans the FULL screen including the safe areas — an
    // absolute fill resolves against its parent's CONTENT box, so mounting it
    // inside the padded box left a black strip in the inset.
    <Box className="flex-1">
      {/* Page background. Must be the FIRST child so it paints behind
          everything else on the page — and it is the very thing this screen
          configures, so the toggle below is seen taking effect immediately. */}
      <AbstractGradientBackdrop />

      {/* No opaque fill: the backdrop above is the page background. */}
      <Box className="flex-1" style={{ paddingTop: insets.top }}>
        <HStack className="items-center px-4 py-3" space="sm">
          <Pressable testID="display-back" onPress={onBack} hitSlop={8} className="p-1">
            <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
          </Pressable>
          <Text className="text-white text-lg font-semibold">{t('display.title')}</Text>
        </HStack>

        <VStack className="px-5 pt-2 pb-3">
          <Text size="sm" className="text-gray-400">
            {t('display.subtitle')}
          </Text>
        </VStack>

        <VStack className="px-5">
          <HStack className="items-center justify-between py-3 px-4 mb-3 border border-gray-700 rounded-lg">
            <HStack space="md" className="items-center flex-1 pr-3">
              <MaterialIcons
                name="gradient"
                size={24}
                color={staticGradient ? '#10b981' : '#9ca3af'}
              />
              <VStack className="flex-1">
                <Text className="text-base text-white">{t('display.staticGradientTitle')}</Text>
                <Text size="sm" className="text-gray-400 mt-0.5">
                  {t('display.staticGradientDescription')}
                </Text>
              </VStack>
            </HStack>

            <Switch
              testID="static-gradient-switch"
              value={staticGradient}
              onToggle={setStaticGradient}
              size="md"
            />
          </HStack>
        </VStack>
      </Box>
    </Box>
  );
};

export default DisplaySettingsScreen;
