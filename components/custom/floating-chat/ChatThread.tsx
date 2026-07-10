// ChatThread — presentational chat surface. Renders a flat ChatThreadItem[] via
// the vendored chat-ai primitives, plus starter chips, a blocked banner, and the
// prompt input. Everything comes in via props (ChatThreadProps) — no data
// fetching, no stores.

import StreamingIndicator from '@/components/custom/chat/StreamingIndicator';
import { Text } from '@/components/ui/text';
import {
  Conversation,
  ConversationContent,
  Message,
  MessageContent,
  MessageResponse,
  PromptInput,
  type PromptInputHandle,
} from '@/components/ui/chat-ai';
import { useThemeColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useContext, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { PopoverPhaseContext } from './ChatPopover';
import FactCard from './FactCard';
import StarterChips from './StarterChips';
import type { ChatThreadItem, ChatThreadProps } from './types';

// Short, snappy spring for freshly-arrived message bubbles. Applied ONLY to
// live-session items (keys prefixed `live-`); prepended history pages (`hist-`)
// must not replay this animation when they load in behind the current session.
const MESSAGE_ENTERING = FadeInDown.springify().damping(20).stiffness(220).mass(0.5);

const ChatThread: React.FC<ChatThreadProps> = ({
  items,
  isStreaming: _isStreaming,
  onLoadOlder,
  hasOlder,
  isLoadingOlder,
  starterChips,
  onChipPress,
  blockedMessage,
  onSend,
  isInputDisabled,
}) => {
  const { t } = useTranslation();
  const colors = useThemeColors();

  // Autofocus the input once the popover's open morph fully settles. Focusing
  // mid-morph fights the scale transform and janks the keyboard slide-up, so we
  // wait for phase 'open'. If the session finishes loading after the morph, this
  // ChatThread mounts with phase already 'open' and the effect still fires.
  const phase = useContext(PopoverPhaseContext);
  const promptRef = useRef<PromptInputHandle>(null);
  useEffect(() => {
    if (phase === 'open') {
      promptRef.current?.focus();
    }
  }, [phase]);

  // Starter chips show only when the thread has no real user/assistant messages
  // (the intro pseudo-message, id 'intro', does not count).
  const hasRealMessage = items.some(
    (item) => item.kind === 'message' && item.message.id !== 'intro',
  );
  const showChips = !hasRealMessage && starterChips.length > 0;

  const renderItem = (item: ChatThreadItem): React.ReactElement | null => {
    switch (item.kind) {
      case 'message': {
        const { message } = item;
        const inner =
          message.role === 'user' ? (
            <Message role="user">
              <MessageContent role="user">
                <Text size="sm" style={[styles.userText, { color: colors.icon }]}>
                  {message.content}
                </Text>
              </MessageContent>
            </Message>
          ) : (
            <Message role="assistant">
              <MessageContent role="assistant">
                <MessageResponse>{message.content}</MessageResponse>
              </MessageContent>
            </Message>
          );
        // Only animate in live-session bubbles; history pages load without replay.
        return item.key.startsWith('live-') ? (
          <Animated.View entering={MESSAGE_ENTERING}>{inner}</Animated.View>
        ) : (
          inner
        );
      }

      case 'fact-card':
        return <FactCard action={item.action} statements={item.statements} />;

      case 'divider':
        return (
          <View style={styles.dividerRow}>
            <View style={[styles.hairline, { backgroundColor: colors.border }]} />
            <Text size="xs" style={[styles.dividerLabel, { color: colors.iconFaint }]}>
              {item.label}
            </Text>
            <View style={[styles.hairline, { backgroundColor: colors.border }]} />
          </View>
        );

      case 'typing':
        return (
          <Message role="assistant">
            <MessageContent role="assistant">
              <StreamingIndicator />
            </MessageContent>
          </Message>
        );

      default:
        return null;
    }
  };

  return (
    <Conversation>
      <View style={styles.listWrap}>
        <ConversationContent
          items={items}
          renderItem={renderItem}
          onLoadOlder={onLoadOlder}
          hasOlder={hasOlder}
          isLoadingOlder={isLoadingOlder}
          header={
            showChips ? (
              <StarterChips chips={starterChips} onChipPress={onChipPress} />
            ) : null
          }
        />
      </View>

      {blockedMessage && (
        <View style={styles.blockedBanner}>
          <MaterialIcons name="block" size={20} color={colors.error} />
          <Text size="sm" style={[styles.blockedText, { color: colors.error }]}>
            {blockedMessage}
          </Text>
        </View>
      )}

      <PromptInput
        ref={promptRef}
        onSubmit={onSend}
        placeholder={t('floatingChat.inputPlaceholder')}
        disabled={isInputDisabled || blockedMessage !== null}
      />
    </Conversation>
  );
};

const styles = StyleSheet.create({
  listWrap: {
    flex: 1,
  },
  userText: {
    // Match the assistant markdown / input type scale for a uniform chat UI.
    fontSize: 15,
    lineHeight: 21,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  hairline: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  blockedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
  },
  blockedText: {
    flex: 1,
  },
});

export default ChatThread;
