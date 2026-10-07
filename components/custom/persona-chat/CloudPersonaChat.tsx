// CloudPersonaChat: the cloud path's view. Creates the context-appropriate
// agent, attaches it to the chat session and draws cloud-chat-store's state
// with ChatSessionView. The turn runs in the session, not here.

import ChatSessionView from '@/components/custom/floating-chat/ChatSessionView';
import { createAgentForContext } from '@/components/custom/floating-chat/agent-registry';
import type { PersistedMessage } from '@/lib/database/services/conversation-service';
import { useChatSession } from '@/lib/chat-session/use-chat-session';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useShallow } from 'zustand/react/shallow';
import type { ChatContext } from '@/lib/stores/floating-chat-store';
import React, { useMemo } from 'react';

export interface CloudPersonaChatProps {
  userId: string;
  surface: 'ONBOARDING' | 'CONFIG';
  context: ChatContext;
  conversationId: string | null;
  resumeMessages?: PersistedMessage[];
  isLoading: boolean;
  loadingMessage?: string;
}

export default function CloudPersonaChat({
  userId,
  surface,
  context,
  conversationId,
  resumeMessages,
  isLoading,
  loadingMessage,
}: CloudPersonaChatProps) {
  const agent = useMemo(
    () => createAgentForContext(context, userId, surface),
    [context, userId, surface],
  );
  const session = useChatSession('cloud', agent, conversationId, resumeMessages);
  const chat = useCloudChatStore(
    useShallow((st) => ({
      messages: st.messages,
      status: st.status,
      isBlocked: st.isBlocked,
      blockedReason: st.blockedReason,
      error: st.error,
    })),
  );

  return (
    <ChatSessionView
      messages={chat.messages}
      status={chat.status}
      sendMessage={session.send}
      sendHiddenTurn={session.sendHidden}
      isBlocked={chat.isBlocked}
      blockedReason={chat.blockedReason}
      error={chat.error}
      context={context}
      userId={userId}
      conversationId={conversationId}
      resumeMessages={resumeMessages}
      isLoading={isLoading}
      loadingMessage={loadingMessage}
    />
  );
}
