// MeraPersonaUpdateChat — init + routing for persona chat.
// Handles session, surface detection, and model loading.
// Delegates rendering to LocalPersonaChat or CloudPersonaChat.

import { AccountService } from '@/lib/account-service';
import { authClient } from '@/lib/auth-client';
import { getFacts } from '@/lib/database/services/fact-service';
import logger from '@/lib/logger';
import { disposeModel, initBaseModel, isModelDownloaded } from '@/lib/mera-protocol-toolkit/core/modelManager';
import {
  useIsOnDeviceProcessing,
  useMeraProtocolStore,
  useModelState,
} from '@/lib/stores/mera-protocol-store';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CloudPersonaChat from '../persona-chat/CloudPersonaChat';
import LocalPersonaChat from '../persona-chat/LocalPersonaChat';

export interface MeraPersonaUpdateChatProps {
  onClose?: () => void;
}

const MeraPersonaUpdateChat: React.FC<MeraPersonaUpdateChatProps> = ({
  onClose,
}) => {
  const { t } = useTranslation();
  const [isInitLoading, setIsInitLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [surface, setSurface] = useState<'ONBOARDING' | 'CONFIG'>('ONBOARDING');
  const [userId, setUserId] = useState<string | null>(null);

  const hasInitialized = useRef(false);

  const isOnDevice = useIsOnDeviceProcessing();
  const modelState = useModelState();

  // --- Init ---
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    const init = async () => {
      setLoadingMessage(t('chat.startingChat'));
      try {
        const session = await authClient.getSession();
        const currentUserId = session?.data?.user?.id;
        if (currentUserId) {
          setUserId(currentUserId);
        } else {
          logger.warn('[MeraPersonaUpdateChat] no userId from session — chat will open without user context');
        }

        // Fetch persona + local facts in parallel (independent calls)
        const [persona, facts] = await Promise.all([
          currentUserId
            ? AccountService.getUserPersona(currentUserId).catch(() => null)
            : Promise.resolve(null),
          getFacts(),
        ]);

        if (persona?.processingMode) {
          useMeraProtocolStore
            .getState()
            .setProcessingMode(persona.processingMode);
        }

        const currentSurface = facts.length > 0 ? 'CONFIG' : 'ONBOARDING';
        setSurface(currentSurface);

        // For local path: load model into memory if downloaded but not yet ready
        const isOnDeviceMode =
          useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice;
        if (isOnDeviceMode) {
          const downloaded = await isModelDownloaded();
          const currentModelState = useMeraProtocolStore.getState().modelState;
          if (downloaded && currentModelState !== 'ready' && currentModelState !== 'loading') {
            setLoadingMessage(t('chat.loadingModel'));
            useMeraProtocolStore.getState().setModelState('loading');
            try {
              await initBaseModel(undefined, (progress) => {
                setLoadingMessage(t('chat.loadingModelProgress', { percent: Math.round(progress) }));
              });
              useMeraProtocolStore.getState().setModelState('ready');
            } catch (modelError) {
              logger.error('[MeraPersonaUpdateChat] model load failed', { error: String(modelError) });
              useMeraProtocolStore.getState().setModelError(String(modelError));
            }
          }
        }
      } catch (error) {
        logger.captureException(error, {
          tags: { component: 'MeraPersonaUpdateChat', method: 'init' },
        });
      } finally {
        setIsInitLoading(false);
      }
    };

    init();
  }, [t]);

  // Show loading if model is loading for local path
  const isModelLoading =
    isOnDevice &&
    modelState !== 'ready' &&
    modelState !== 'not_downloaded' &&
    modelState !== 'error';

  const isLoaderVisible = isInitLoading || isModelLoading;

  // Keep loadingMessage in sync when model reloads (e.g. after foreground return)
  useEffect(() => {
    if (isModelLoading && !isInitLoading) {
      setLoadingMessage(t('chat.loadingModel'));
    }
  }, [isModelLoading, isInitLoading, t]);

  // Safety timeout: if the model is stuck in 'loading' after init completes, force-dispose and reload.
  // Only fires after isInitLoading = false to avoid racing with the initial load (which can take 15-30s).
  // Uses a 60s timeout to accommodate slow devices.
  useEffect(() => {
    if (isInitLoading || !isModelLoading) return;

    const timer = setTimeout(async () => {
      logger.warn('[MeraPersonaUpdateChat] Model stuck in loading — force reloading');
      try {
        await disposeModel();
        const store = useMeraProtocolStore.getState();
        store.setModelState('loading');
        await initBaseModel(undefined, (progress) => {
          setLoadingMessage(t('chat.reloadingModel', { percent: Math.round(progress) }));
        });
        store.setModelState('ready');
      } catch (err) {
        logger.error('[MeraPersonaUpdateChat] Force reload failed', { error: String(err) });
        useMeraProtocolStore.getState().setModelError(String(err));
      }
    }, 60_000);

    return () => clearTimeout(timer);
  }, [isInitLoading, isModelLoading, t]);

  const sharedProps = {
    userId: userId ?? '',
    surface,
    isLoading: isLoaderVisible,
    loadingMessage,
    onClose,
  };

  return isOnDevice
    ? <LocalPersonaChat {...sharedProps} />
    : <CloudPersonaChat {...sharedProps} />;
};

export default MeraPersonaUpdateChat;
