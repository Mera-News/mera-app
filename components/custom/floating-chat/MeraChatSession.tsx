// MeraChatSession — session container for the floating chat.
//
// Owns everything that must happen once per chat session (i.e. per mount):
// - auth session → userId
// - surface detection (facts present → CONFIG, else ONBOARDING)
// - persona fetch → processing-mode sync
// - on-device model load with progress + stuck-loading watchdog
// - cloud-chat store reset (fresh conversation — cloud state survives
//   remounts by design, so it must be cleared explicitly)
// - durable conversation row creation (createConversation)
//
// Children (Local/CloudPersonaChat → ChatSessionView) are NOT rendered until
// the conversation row exists, which also guarantees the cloud store reset in
// the same init effect runs before any child hook touches that store.

import { AccountService } from '@/lib/account-service';
import { authClient } from '@/lib/auth-client';
import {
  createConversation,
  fetchMessagesForConversation,
  type PersistedMessage,
} from '@/lib/database/services/conversation-service';
import { getFacts } from '@/lib/database/services/fact-service';
import logger from '@/lib/logger';
import {
  disposeModel,
  initBaseModel,
  isModelDownloaded,
} from '@/lib/mera-protocol-toolkit/core/modelManager';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import {
  useFloatingChatConversationId,
  useFloatingChatNewChatNonce,
  useFloatingChatStore,
} from '@/lib/stores/floating-chat-store';
import {
  useIsOnDeviceProcessing,
  useMeraProtocolStore,
  useModelState,
} from '@/lib/stores/mera-protocol-store';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import CloudPersonaChat from '../persona-chat/CloudPersonaChat';
import LocalPersonaChat from '../persona-chat/LocalPersonaChat';

export default function MeraChatSession() {
  const { t } = useTranslation();
  const [isInitLoading, setIsInitLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [surface, setSurface] = useState<'ONBOARDING' | 'CONFIG'>('ONBOARDING');
  const [userId, setUserId] = useState<string | null>(null);

  // Conversation identity lives in the store (app-session scoped), so it
  // survives popover close/reopen and is shared with the header's "New chat".
  const conversationId = useFloatingChatConversationId();
  const newChatNonce = useFloatingChatNewChatNonce();

  // Resumed messages for the CURRENT conversation, loaded on (re)open so the
  // thread comes back with its history even after the live session was torn
  // down on collapse (local path) — and gating render until the load matches
  // the current id avoids flashing a stale/empty thread.
  const [resumeMessages, setResumeMessages] = useState<PersistedMessage[]>([]);
  const [resumeLoadedForId, setResumeLoadedForId] = useState<string | null>(null);

  const hasInitialized = useRef(false);
  const surfaceRef = useRef<'ONBOARDING' | 'CONFIG'>('ONBOARDING');

  const isOnDevice = useIsOnDeviceProcessing();
  const modelState = useModelState();
  const context = useFloatingChatStore((state) => state.context);

  // --- Init (once per mount) ---
  // Auth, surface detection, persona/model load, and — only if no conversation
  // exists yet this app session — creating the first one. Does NOT reset the
  // cloud store on plain reopen: retained in-memory messages resuming is now
  // desired (cloud store is reset only when a fresh conversation is created).
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
          logger.warn('[MeraChatSession] no userId from session — chat will open without user context');
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
        surfaceRef.current = currentSurface;

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
              logger.error('[MeraChatSession] model load failed', { error: String(modelError) });
              useMeraProtocolStore.getState().setModelError(String(modelError));
            }
          }
        }

        // First conversation of the app session — reuse any existing store id
        // (popover reopen), else create one and clear the cloud store so a
        // brand-new conversation starts empty.
        if (useFloatingChatStore.getState().conversationId === null) {
          useCloudChatStore.getState().reset();
          const newConversationId = await createConversation(currentSurface);
          useFloatingChatStore.getState().setConversationId(newConversationId);
        }
      } catch (error) {
        logger.captureException(error, {
          tags: { component: 'MeraChatSession', method: 'init' },
        });
      } finally {
        setIsInitLoading(false);
      }
    };

    init();
  }, [t]);

  // --- "New chat" button: create a fresh conversation and remount the thread ---
  // Skips the initial nonce (mount) so only genuine button presses fire.
  const prevNonceRef = useRef(newChatNonce);
  useEffect(() => {
    if (prevNonceRef.current === newChatNonce) return;
    prevNonceRef.current = newChatNonce;

    let cancelled = false;
    void (async () => {
      try {
        useCloudChatStore.getState().reset();
        const cid = await createConversation(surfaceRef.current);
        if (!cancelled) useFloatingChatStore.getState().setConversationId(cid);
      } catch (error) {
        logger.captureException(error, {
          tags: { component: 'MeraChatSession', method: 'newChat' },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [newChatNonce]);

  // --- Resume the current conversation's persisted messages ---
  useEffect(() => {
    if (!conversationId) {
      setResumeMessages([]);
      setResumeLoadedForId(null);
      return;
    }
    let cancelled = false;
    fetchMessagesForConversation(conversationId)
      .then((msgs) => {
        if (cancelled) return;
        setResumeMessages(msgs);
        setResumeLoadedForId(conversationId);
      })
      .catch((error) => {
        logger.error('[MeraChatSession] failed to load resume messages', { error: String(error) });
        if (cancelled) return;
        setResumeMessages([]);
        setResumeLoadedForId(conversationId);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

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
      logger.warn('[MeraChatSession] Model stuck in loading — force reloading');
      try {
        await disposeModel();
        const store = useMeraProtocolStore.getState();
        store.setModelState('loading');
        await initBaseModel(undefined, (progress) => {
          setLoadingMessage(t('chat.reloadingModel', { percent: Math.round(progress) }));
        });
        store.setModelState('ready');
      } catch (err) {
        logger.error('[MeraChatSession] Force reload failed', { error: String(err) });
        useMeraProtocolStore.getState().setModelError(String(err));
      }
    }, 60_000);

    return () => clearTimeout(timer);
  }, [isInitLoading, isModelLoading, t]);

  // Gate children until (a) a conversation row exists and (b) its resume load
  // has landed for THAT id — so the thread never renders against a stale/empty
  // resume set during the create-or-switch window.
  if (conversationId === null || resumeLoadedForId !== conversationId) {
    return (
      <View style={styles.loadingContainer}>
        <Spinner size="large" />
        <Text size="sm" style={styles.loadingText}>
          {loadingMessage || t('chat.startingChat')}
        </Text>
      </View>
    );
  }

  const sharedProps = {
    userId: userId ?? '',
    surface,
    context,
    conversationId,
    resumeMessages,
    isLoading: isLoaderVisible,
    loadingMessage,
  };

  // Key by conversationId so "New chat" fully remounts the inference hook and
  // its live state (fresh thread, intro + starter chips again).
  return isOnDevice
    ? <LocalPersonaChat key={conversationId} {...sharedProps} />
    : <CloudPersonaChat key={conversationId} {...sharedProps} />;
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  loadingText: {
    color: 'rgb(160, 160, 160)',
    textAlign: 'center',
  },
});
