import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

interface ErrorFallbackProps {
  error: Error;
  resetError: () => void;
}

export const FullScreenErrorFallback: React.FC<ErrorFallbackProps> = ({
  error,
  resetError,
}) => {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-black items-center justify-center px-6">
      <MaterialIcons name="error-outline" size={64} color="#EF4444" />
      <Text className="text-white text-xl font-semibold mt-6 text-center">
        {t('errors.somethingWentWrong')}
      </Text>
      <Text className="text-gray-400 text-base mt-2 text-center">
        {t('errors.unexpectedError')}
      </Text>
      {__DEV__ && (
        <Text className="text-red-400 text-xs mt-4 text-center px-4">
          {error.message}
        </Text>
      )}
      <Button
        onPress={resetError}
        className="mt-8 bg-white rounded-full px-6"
        size="lg"
      >
        <MaterialIcons name="refresh" size={18} color="#000" />
        <ButtonText className="text-black ml-2">{t('common.retry')}</ButtonText>
      </Button>
    </View>
  );
};

export const InlineErrorFallback: React.FC<ErrorFallbackProps> = ({
  error,
  resetError,
}) => {
  const { t } = useTranslation();
  return (
    <View className="bg-gray-900 rounded-xl p-4 items-center justify-center my-2">
      <MaterialIcons name="error-outline" size={32} color="#EF4444" />
      <Text className="text-white text-sm font-medium mt-3 text-center">
        {t('errors.failedToLoad')}
      </Text>
      {__DEV__ && (
        <Text className="text-red-400 text-xs mt-2 text-center">
          {error.message}
        </Text>
      )}
      <Button
        onPress={resetError}
        className="mt-4 bg-gray-800 rounded-full px-4"
        size="sm"
      >
        <MaterialIcons name="refresh" size={14} color="#fff" />
        <ButtonText className="text-white text-sm ml-1">{t('common.retry')}</ButtonText>
      </Button>
    </View>
  );
};

export const MinimalErrorFallback: React.FC<ErrorFallbackProps> = ({
  resetError,
}) => {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center justify-center py-2">
      <MaterialIcons name="error-outline" size={16} color="#EF4444" />
      <Text className="text-gray-400 text-sm ml-2">{t('errors.errorLoadingContent')}</Text>
      <Button
        onPress={resetError}
        variant="link"
        size="sm"
        className="ml-2"
      >
        <ButtonText className="text-white text-sm underline">{t('common.retry')}</ButtonText>
      </Button>
    </View>
  );
};
