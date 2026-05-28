// LocalPersonaChat — on-device inference path for persona chat.
// Creates a PersonaUpdateAgent, calls useLocalLLM, renders PersonaChatUI.

import { PersonaUpdateAgent } from '@/lib/llm/agents/PersonaUpdateAgent';
import { useLocalLLM } from '@/lib/llm/useLocalLLM';
import React, { useMemo } from 'react';
import PersonaChatUI from './PersonaChatUI';

export interface LocalPersonaChatProps {
  userId: string;
  surface: 'ONBOARDING' | 'CONFIG';
  isLoading: boolean;
  loadingMessage?: string;
  onClose?: () => void;
}

export default function LocalPersonaChat({
  userId,
  surface,
  isLoading,
  loadingMessage,
  onClose,
}: LocalPersonaChatProps) {
  const agent = useMemo(() => new PersonaUpdateAgent(userId, surface), [userId, surface]);
  const chat = useLocalLLM(agent);

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
