import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme/tokens';

interface ErrorFallbackProps {
  error: Error;
  resetError: () => void;
}

export const FullScreenErrorFallback: React.FC<ErrorFallbackProps> = ({
  error,
  resetError,
}) => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="flex-1 bg-background-0 items-center justify-center px-6">
      <MaterialIcons name="error-outline" size={64} color={colors.error} />
      <Text className="text-typography-950 text-xl font-semibold mt-6 text-center">
        {t('errors.somethingWentWrong')}
      </Text>
      <Text className="text-typography-500 text-base mt-2 text-center">
        {t('errors.unexpectedError')}
      </Text>
      {__DEV__ && (
        <Text className="text-error-500 text-xs mt-4 text-center px-4">
          {error.message}
        </Text>
      )}
      <Button
        onPress={resetError}
        className="mt-8 bg-typography-950 rounded-full px-6"
        size="lg"
      >
        <MaterialIcons name="refresh" size={18} color={colors.background} />
        <ButtonText className="text-background-0 ml-2">{t('common.retry')}</ButtonText>
      </Button>
    </View>
  );
};

export const InlineErrorFallback: React.FC<ErrorFallbackProps> = ({
  error,
  resetError,
}) => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="bg-background-50 rounded-xl p-4 items-center justify-center my-2">
      <MaterialIcons name="error-outline" size={32} color={colors.error} />
      <Text className="text-typography-950 text-sm font-medium mt-3 text-center">
        {t('errors.failedToLoad')}
      </Text>
      {__DEV__ && (
        <Text className="text-error-500 text-xs mt-2 text-center">
          {error.message}
        </Text>
      )}
      <Button
        onPress={resetError}
        className="mt-4 bg-background-100 rounded-full px-4"
        size="sm"
      >
        <MaterialIcons name="refresh" size={14} color={colors.icon} />
        <ButtonText className="text-typography-950 text-sm ml-1">{t('common.retry')}</ButtonText>
      </Button>
    </View>
  );
};

export const MinimalErrorFallback: React.FC<ErrorFallbackProps> = ({
  resetError,
}) => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center justify-center py-2">
      <MaterialIcons name="error-outline" size={16} color={colors.error} />
      <Text className="text-typography-500 text-sm ml-2">{t('errors.errorLoadingContent')}</Text>
      <Button
        onPress={resetError}
        variant="link"
        size="sm"
        className="ml-2"
      >
        <ButtonText className="text-typography-950 text-sm underline">{t('common.retry')}</ButtonText>
      </Button>
    </View>
  );
};
