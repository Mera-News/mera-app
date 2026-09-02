// LocalPersonaChat — on-device inference path for the floating chat session.
// Creates the context-appropriate agent, calls useLocalLLM, renders
// ChatSessionView.

import ChatSessionView from '@/components/custom/floating-chat/ChatSessionView';
import { createAgentForContext } from '@/components/custom/floating-chat/agent-registry';
import type { PersistedMessage } from '@/lib/database/services/conversation-service';
import { useLocalLLM } from '@/lib/llm/useLocalLLM';
import type { ChatContext } from '@/lib/stores/floating-chat-store';
import type { OnboardingRunToken } from '@/lib/chat-tools/onboarding-run';
import React, { useMemo } from 'react';

export interface LocalPersonaChatProps {
  userId: string;
  surface: 'ONBOARDING' | 'CONFIG';
  context: ChatContext;
  conversationId: string | null;
  resumeMessages?: PersistedMessage[];
  isLoading: boolean;
  loadingMessage?: string;
  /** D29: passed straight through to ChatSessionView. See onboarding-run.ts. */
  onboardingRun?: OnboardingRunToken | null;
}

export default function LocalPersonaChat({
  userId,
  surface,
  context,
  conversationId,
  resumeMessages,
  isLoading,
  loadingMessage,
  onboardingRun = null,
}: LocalPersonaChatProps) {
  const agent = useMemo(
    () => createAgentForContext(context, userId, surface),
    [context, userId, surface],
  );
  const chat = useLocalLLM(agent);

  return (
    <ChatSessionView
      onboardingRun={onboardingRun}
      messages={chat.messages}
      status={chat.status}
      sendMessage={chat.sendMessage}
      sendHiddenTurn={chat.sendHiddenTurn}
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
