// CloudPersonaChat — cloud inference path for persona chat.
// Creates a PersonaUpdateAgent, calls useCloudPersonaChat, renders PersonaChatUI.

import { useCloudPersonaChat } from '@/lib/hooks/useCloudPersonaChat';
import { PersonaUpdateAgent } from '@/lib/llm/agents/PersonaUpdateAgent';
import React, { useMemo } from 'react';
import PersonaChatUI from './PersonaChatUI';

export interface CloudPersonaChatProps {
  userId: string;
  surface: 'ONBOARDING' | 'CONFIG';
  isLoading: boolean;
  loadingMessage?: string;
  onClose?: () => void;
}

export default function CloudPersonaChat({
  userId,
  surface,
  isLoading,
  loadingMessage,
  onClose,
}: CloudPersonaChatProps) {
  const agent = useMemo(() => new PersonaUpdateAgent(userId, surface), [userId, surface]);
  const chat = useCloudPersonaChat(agent);

  return (
    <PersonaChatUI
      {...chat}
      surface={surface}
      isLoading={isLoading}
      loadingMessage={loadingMessage}
      onClose={onClose}
    />
  );
}
