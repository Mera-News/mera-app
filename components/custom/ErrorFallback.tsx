import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';

interface ErrorFallbackProps {
  error: Error;
  resetError: () => void;
}

export const FullScreenErrorFallback: React.FC<ErrorFallbackProps> = ({
  error,
  resetError,
}) => {
  const { t } = useTranslation();
  const c = useColors();
  return (
    // No opaque fill. This renders INSIDE the route that failed, so it inherits
    // whatever page background that route mounts (the AbstractGradientBackdrop
    // on every screen that has one). `bg-page` here punched a hole through it.
    <View className="flex-1 items-center justify-center px-6">
      <MaterialIcons name="error-outline" size={64} color={c.negative} />
      <Text className="text-ink text-xl font-semibold mt-6 text-center">
        {t('errors.somethingWentWrong')}
      </Text>
      <Text className="text-ink-2 text-base mt-2 text-center">
        {t('errors.unexpectedError')}
      </Text>
      {__DEV__ && (
        <Text className="text-red-400 text-xs mt-4 text-center px-4">
          {error.message}
        </Text>
      )}
      <Button
        onPress={resetError}
        className="mt-8 bg-ink rounded-full px-6"
        size="lg"
      >
        <MaterialIcons name="refresh" size={18} color={c.base} />
        <ButtonText className="text-page ml-2">{t('common.retry')}</ButtonText>
      </Button>
    </View>
  );
};

export const InlineErrorFallback: React.FC<ErrorFallbackProps> = ({
  error,
  resetError,
}) => {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View className="bg-surface rounded-xl p-4 items-center justify-center my-2">
      <MaterialIcons name="error-outline" size={32} color={c.negative} />
      <Text className="text-ink text-sm font-medium mt-3 text-center">
        {t('errors.failedToLoad')}
      </Text>
      {__DEV__ && (
        <Text className="text-red-400 text-xs mt-2 text-center">
          {error.message}
        </Text>
      )}
      <Button
        onPress={resetError}
        className="mt-4 bg-surface-raised rounded-full px-4"
        size="sm"
      >
        <MaterialIcons name="refresh" size={14} color={c.ink} />
        <ButtonText className="text-ink text-sm ml-1">{t('common.retry')}</ButtonText>
      </Button>
    </View>
  );
};

export const MinimalErrorFallback: React.FC<ErrorFallbackProps> = ({
  resetError,
}) => {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View className="flex-row items-center justify-center py-2">
      <MaterialIcons name="error-outline" size={16} color={c.negative} />
      <Text className="text-ink-2 text-sm ml-2">{t('errors.errorLoadingContent')}</Text>
      <Button
        onPress={resetError}
        variant="link"
        size="sm"
        className="ml-2"
      >
        <ButtonText className="text-ink text-sm underline">{t('common.retry')}</ButtonText>
      </Button>
    </View>
  );
};
