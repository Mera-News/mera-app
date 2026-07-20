// PersonaUpdateChatStep — the persona chat rendered inline as onboarding wizard
// step 1 (full-bleed under the OnboardingNavBar), replacing the old floating
// bubble/popover flow.
//
// CLOUD-ONLY BY DESIGN. This deliberately does NOT reuse MeraChatSession:
//
//   1. MeraChatSession branches to LocalPersonaChat and drives on-device model
//      loading whenever processingMode === OnDevice. During onboarding the local
//      model has not been downloaded yet (that happens after onboarding), so the
//      chat must always run on the cloud path — there is no local model to load.
//
//   2. MeraChatSession keeps its conversation identity in the shared
//      floating-chat-store (app-session scoped, shared with the floating bubble/
//      popover). The wizard needs a self-contained conversation that isn't
//      entangled with the floating bubble, so identity lives in LOCAL state here.
//
// It DOES replicate MeraChatSession's init spine — auth → userId, surface
// detection (facts present → CONFIG, else ONBOARDING), cloud-store reset +
// createConversation, resume messages — and renders CloudPersonaChat directly.

import { authClient } from '@/lib/auth-client';
import {
  createConversation,
  fetchMessagesForConversation,
  type PersistedMessage,
} from '@/lib/database/services/conversation-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { prewarmCloudChat } from '@/lib/llm/prewarm';
import logger from '@/lib/logger';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import type { ChatContext } from '@/lib/stores/floating-chat-store';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import CloudPersonaChat from '../persona-chat/CloudPersonaChat';

const PERSONA_CONTEXT: ChatContext = { kind: 'persona' };

interface PersonaUpdateChatStepProps {
  /** Authenticated user id (from the wizard's preferences). Falls back to a
   *  session fetch if empty so the step is robust to an unpopulated prop. */
  userId: string;
}

export default function PersonaUpdateChatStep({
  userId: userIdProp,
}: PersonaUpdateChatStepProps) {
  const { t } = useTranslation();
  const [isInitLoading, setIsInitLoading] = useState(true);
  const [surface, setSurface] = useState<'ONBOARDING' | 'CONFIG'>('ONBOARDING');
  const [userId, setUserId] = useState<string | null>(userIdProp || null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [resumeMessages, setResumeMessages] = useState<PersistedMessage[]>([]);
  const [resumeLoadedForId, setResumeLoadedForId] = useState<string | null>(null);

  const hasInitialized = useRef(false);
  const surfaceRef = useRef<'ONBOARDING' | 'CONFIG'>('ONBOARDING');

  // Warm the cloud-chat critical path (attestation + JWT) the moment the step
  // mounts, so the user's first message isn't gated on the cold fetches.
  useEffect(() => {
    prewarmCloudChat();
  }, []);

  // --- Init (once per mount): auth → userId, surface detection ---
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    const init = async () => {
      try {
        let currentUserId = userIdProp || null;
        if (!currentUserId) {
          const session = await authClient.getSession();
          currentUserId = session?.data?.user?.id ?? null;
        }
        if (currentUserId) {
          setUserId(currentUserId);
        } else {
          logger.warn(
            '[PersonaUpdateChatStep] no userId — chat will open without user context',
          );
        }

        const facts = await getFacts();
        const currentSurface = facts.length > 0 ? 'CONFIG' : 'ONBOARDING';
        setSurface(currentSurface);
        surfaceRef.current = currentSurface;
      } catch (error) {
        logger.captureException(error, {
          tags: { component: 'PersonaUpdateChatStep', method: 'init' },
        });
      } finally {
        setIsInitLoading(false);
      }
    };

    init();
  }, [userIdProp]);

  // --- Ensure a conversation exists (level-triggered, LOCAL identity) ---
  // Mirrors MeraChatSession's ensure-conversation effect, but writes the id to
  // local state instead of the shared floating-chat-store. Resetting the cloud
  // store before createConversation guarantees a fresh thread for onboarding.
  const creatingConversationRef = useRef(false);
  useEffect(() => {
    if (conversationId !== null || isInitLoading || creatingConversationRef.current) return;
    creatingConversationRef.current = true;
    void (async () => {
      try {
        useCloudChatStore.getState().reset();
        const cid = await createConversation(surfaceRef.current);
        setConversationId(cid);
      } catch (error) {
        logger.captureException(error, {
          tags: { component: 'PersonaUpdateChatStep', method: 'ensureConversation' },
        });
      } finally {
        creatingConversationRef.current = false;
      }
    })();
  }, [conversationId, isInitLoading]);

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
        logger.error('[PersonaUpdateChatStep] failed to load resume messages', {
          error: String(error),
        });
        if (cancelled) return;
        setResumeMessages([]);
        setResumeLoadedForId(conversationId);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Gate the chat until a conversation row exists and its resume load has landed
  // for THAT id — so the thread never renders against a stale/empty resume set.
  if (conversationId === null || resumeLoadedForId !== conversationId) {
    return (
      <View style={styles.loadingContainer}>
        <Spinner size="large" />
        <Text size="sm" style={styles.loadingText}>
          {t('chat.startingChat')}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CloudPersonaChat
        key={conversationId}
        userId={userId ?? ''}
        surface={surface}
        context={PERSONA_CONTEXT}
        conversationId={conversationId}
        resumeMessages={resumeMessages}
        isLoading={false}
        loadingMessage={t('chat.startingChat')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
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
