import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, Pressable } from 'react-native';
import * as Updates from 'expo-updates';
import { useTranslation } from 'react-i18next';

import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import logger from '@/lib/logger';

export default function OTAUpdatePrompt() {
  const { isUpdatePending } = Updates.useUpdates();
  const toast = useToast();
  const { t } = useTranslation();
  const shownToastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isUpdatePending) return;
    if (shownToastIdRef.current && toast.isActive(shownToastIdRef.current)) return;

    const id = `ota-update-${Date.now()}`;
    shownToastIdRef.current = id;

    toast.show({
      id,
      placement: 'top',
      duration: null,
      render: ({ id: toastId }: { id: string }) => (
        <Pressable
          onPress={() => {
            Updates.reloadAsync().catch((error) =>
              logger.captureException(error, {
                tags: { component: 'OTAUpdatePrompt', method: 'reloadAsync' },
              }),
            );
          }}
        >
          <Toast nativeID={toastId} action="info" variant="solid">
            <ToastTitle>{t('ota.updateReady')}</ToastTitle>
            <ToastDescription>
              {t('ota.updateDescription')}
            </ToastDescription>
          </Toast>
        </Pressable>
      ),
    });
  }, [isUpdatePending, toast]);

  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return;

    const checkForUpdate = async () => {
      try {
        const result = await Updates.checkForUpdateAsync();
        if (result.isAvailable) {
          await Updates.fetchUpdateAsync();
        }
      } catch (error) {
        logger.captureException(error as Error, {
          tags: { component: 'OTAUpdatePrompt', method: 'checkForUpdate' },
        });
      }
    };

    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') {
        checkForUpdate();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  return null;
}
