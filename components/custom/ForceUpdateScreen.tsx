import { MaterialIcons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, View } from 'react-native';

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import logger from '@/lib/logger';
import { useThemeColors } from '@/lib/theme/tokens';
import { isTransientNetworkError } from '@/lib/utils/transient-error';
import { openInAppBrowser } from '@/lib/web-browser-utils';

/**
 * Full-screen, non-dismissible mandatory-update screen. Rendered by
 * NativeUpdateGate in place of the entire app when the installed version is
 * below the server's minimum-supported floor. There is no navigation out of
 * here — the rest of the app tree is unmounted while this is shown.
 */
export default function ForceUpdateScreen({ storeUrl }: { storeUrl: string | null }) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  // Swallow the Android hardware back button so the user can't escape the gate.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, []);

  const onUpdate = () => {
    if (!storeUrl) return;
    openInAppBrowser(storeUrl).catch((error) => {
      if (isTransientNetworkError(error)) return;
      logger.captureException(error, {
        tags: { component: 'ForceUpdateScreen', method: 'onUpdate' },
      });
    });
  };

  return (
    <View className="flex-1 bg-background-0 items-center justify-center px-8">
      <MaterialIcons name="system-update" size={64} color={colors.icon} />
      <Text className="text-typography-950 text-2xl font-bold mt-6 text-center">
        {t('nativeUpdate.updateRequiredTitle')}
      </Text>
      <Text className="text-typography-500 text-base mt-3 text-center">
        {t('nativeUpdate.updateRequiredBody')}
      </Text>
      <Button
        onPress={onUpdate}
        isDisabled={!storeUrl}
        className="mt-8 bg-typography-950 rounded-full px-8"
        size="lg"
      >
        <ButtonText className="text-background-0">{t('nativeUpdate.updateCta')}</ButtonText>
      </Button>
    </View>
  );
}
