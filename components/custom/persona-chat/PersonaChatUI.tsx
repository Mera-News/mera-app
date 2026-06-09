// PersonaChatUI — pure rendering component for persona chat.
// Receives chat state from either useLocalLLM or useCloudPersonaChat and renders MeraChatBaseUI.
// Manages its own inputText, introMessage, and textInputRef (UI state only).

import MeraChatBaseUI from '@/components/custom/chat/MeraChatBaseUI';
import type { ConversationMessage } from '@/lib/llm/types';
import React, { useCallback, useRef, useState } from 'react';
import { Keyboard, TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';

export interface PersonaChatUIProps {
  // Chat hook results
  messages: ConversationMessage[];
  status: 'idle' | 'streaming';
  sendMessage: (text: string) => void;
  latestAssistantContent: string;
  isBlocked: boolean;
  blockedReason: string | null;
  error: string | null;
  surface: 'ONBOARDING' | 'CONFIG';
  // Rendering props from parent
  isLoading: boolean;
  loadingMessage?: string;
  onClose?: () => void;
}

export default function PersonaChatUI({
  status,
  sendMessage,
  latestAssistantContent,
  isBlocked,
  blockedReason,
  error,
  isLoading,
  loadingMessage,
  onClose,
}: PersonaChatUIProps) {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState('');
  const [introMessage, setIntroMessage] = useState<string | null>(t('personaChat.introMessage'));
  const textInputRef = useRef<TextInput>(null);

  const isStreaming = status === 'streaming';

  // Return '' while waiting for the assistant's first token after user sends
  const latestMessage = isStreaming && !latestAssistantContent ? '' : latestAssistantContent;

  // Surface inference errors directly — there's no recovery action the user
  // can take in-app (E2EE is mandatory, local fallback doesn't exist here).
  const displayBlockedMessage = isBlocked
    ? blockedReason
    : error
      ? `${t('chat.inferenceError')} (${error})`
      : null;

  const handleSend = useCallback(() => {
    if (isStreaming || isBlocked || !inputText.trim()) return;
    Keyboard.dismiss();
    textInputRef.current?.blur();
    setIntroMessage(null);
    sendMessage(inputText);
    setInputText('');
  }, [isStreaming, isBlocked, inputText, sendMessage]);

  return (
    <MeraChatBaseUI
      latestMessage={latestMessage}
      isStreaming={isStreaming}
      isLoading={isLoading}
      loadingMessage={loadingMessage}
      introMessage={introMessage}
      inputText={inputText}
      onChangeText={setInputText}
      onSend={handleSend}
      isInputDisabled={isStreaming || isBlocked || !!displayBlockedMessage}
      onClose={onClose}
      blockedMessage={displayBlockedMessage}
      textInputRef={textInputRef}
    />
  );
}
