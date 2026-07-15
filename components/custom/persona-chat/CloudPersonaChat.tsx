// CloudPersonaChat — cloud inference path for the floating chat session.
// Creates the context-appropriate agent, calls useCloudPersonaChat, renders
// ChatSessionView.

import ChatSessionView from '@/components/custom/floating-chat/ChatSessionView';
import { createAgentForContext } from '@/components/custom/floating-chat/agent-registry';
import type { PersistedMessage } from '@/lib/database/services/conversation-service';
import { useCloudPersonaChat } from '@/lib/hooks/useCloudPersonaChat';
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
  const chat = useCloudPersonaChat(agent);

  return (
    <ChatSessionView
      messages={chat.messages}
      status={chat.status}
      sendMessage={chat.sendMessage}
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
