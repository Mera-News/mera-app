'use client';
// Vendored, hand-adapted "chat-ai" primitives.
//
// Modeled on Gluestack's chat-ai component set (Conversation, ConversationContent,
// Message, MessageContent, MessageResponse, PromptInput, PromptInputProvider) but
// stripped of the Vercel AI SDK / attachments and re-typed to this repo's domain.
// Purely presentational — no data fetching, no stores.
//
// These are chat-domain primitives, so they use StyleSheet (matching the sibling
// chat components MeraChatBaseUI / StreamingIndicator and the harvested dark
// markdown styles) rather than tva, while keeping the gluestack forwardRef /
// context conventions for API compatibility.

import { MaterialIcons } from '@expo/vector-icons';
import React, {
  createContext,
  forwardRef,
  useContext,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  type FlatListProps,
  type ListRenderItem,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { Button } from '@/components/ui/button';

const ACCENT = 'rgb(231, 138, 83)';
// Bubble surfaces float on the #1a1a1a panel: assistant slightly lighter than
// the panel, user lighter still, so the two roles read apart without borders.
const ASSISTANT_SURFACE = '#232323';
const USER_SURFACE = '#2e2e2e';
// Input field surface (kept distinct from the user bubble tone).
const INPUT_SURFACE = '#262626';
const TEXT_COLOR = 'rgb(210, 210, 210)';
// Uniform chat type scale — assistant markdown, user bubble, and the input all
// share this size/line-height so the conversation reads as one system.
const CHAT_FONT_SIZE = 15;
const CHAT_LINE_HEIGHT = 21;

// ---------------------------------------------------------------------------
// Conversation — outer container
// ---------------------------------------------------------------------------

export interface ConversationProps {
  children: React.ReactNode;
  style?: View['props']['style'];
}

const Conversation = forwardRef<View, ConversationProps>(function Conversation(
  { children, style },
  ref,
) {
  return (
    <View ref={ref} style={[styles.conversation, style]}>
      {children}
    </View>
  );
});

// ---------------------------------------------------------------------------
// ConversationContent — inverted FlatList over generic thread items
// ---------------------------------------------------------------------------

export interface ConversationContentProps<T extends { key: string }>
  extends Pick<FlatListProps<T>, 'ListEmptyComponent'> {
  /** Items ordered newest LAST — this component reverses + inverts internally. */
  items: T[];
  renderItem: (item: T) => React.ReactElement | null;
  onLoadOlder: () => void;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  /** Rendered above the list body (visually at the bottom of the inverted view). */
  header?: React.ReactElement | null;
}

function ConversationContentInner<T extends { key: string }>(
  { items, renderItem, onLoadOlder, hasOlder, isLoadingOlder, header, ListEmptyComponent }: ConversationContentProps<T>,
) {
  // Inverted FlatList renders data[0] at the bottom. Reverse so the newest item
  // (last in `items`) sits at index 0 and therefore at the bottom of the view.
  const data = React.useMemo(() => [...items].reverse(), [items]);

  const listRenderItem: ListRenderItem<T> = ({ item }) => renderItem(item);

  return (
    <FlatList
      data={data}
      inverted
      renderItem={listRenderItem}
      keyExtractor={(item) => item.key}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      onEndReached={hasOlder && !isLoadingOlder ? onLoadOlder : undefined}
      onEndReachedThreshold={0.4}
      // In an inverted list the "footer" is drawn at the top of the view — the
      // right place for the older-messages loading spinner.
      ListFooterComponent={
        isLoadingOlder ? (
          <View style={styles.olderSpinnerRow}>
            <MaterialIcons name="hourglass-empty" size={18} color={ACCENT} />
          </View>
        ) : null
      }
      // In an inverted list the "header" is drawn at the bottom of the view.
      ListHeaderComponent={header ?? null}
      ListEmptyComponent={ListEmptyComponent}
      contentContainerStyle={styles.listContent}
    />
  );
}

// Preserve the generic signature through forwardRef.
const ConversationContent = ConversationContentInner as <T extends { key: string }>(
  props: ConversationContentProps<T>,
) => React.ReactElement;

// ---------------------------------------------------------------------------
// Message — role-based alignment wrapper
// ---------------------------------------------------------------------------

export interface MessageProps {
  role: 'user' | 'assistant';
  children: React.ReactNode;
}

const Message = forwardRef<View, MessageProps>(function Message({ role, children }, ref) {
  return (
    <View
      ref={ref}
      style={[styles.messageRow, role === 'user' ? styles.messageRowUser : styles.messageRowAssistant]}
    >
      {children}
    </View>
  );
});

// ---------------------------------------------------------------------------
// MessageContent — the bubble
// ---------------------------------------------------------------------------

export interface MessageContentProps {
  role: 'user' | 'assistant';
  children: React.ReactNode;
}

const MessageContent = forwardRef<View, MessageContentProps>(function MessageContent(
  { role, children },
  ref,
) {
  return (
    <View
      ref={ref}
      style={[styles.bubble, role === 'user' ? styles.bubbleUser : styles.bubbleAssistant]}
    >
      {children}
    </View>
  );
});

// ---------------------------------------------------------------------------
// MessageResponse — markdown body (left-aligned dark styles)
// ---------------------------------------------------------------------------

export interface MessageResponseProps {
  children: string;
}

const MessageResponse = forwardRef<View, MessageResponseProps>(function MessageResponse(
  { children },
  ref,
) {
  return (
    <View ref={ref}>
      <Markdown style={markdownStyles}>{children}</Markdown>
    </View>
  );
});

// ---------------------------------------------------------------------------
// PromptInputProvider — minimal context (API-compat passthrough)
// ---------------------------------------------------------------------------

interface PromptInputContextValue {
  text: string;
  setText: (t: string) => void;
}

const PromptInputContext = createContext<PromptInputContextValue | null>(null);

export interface PromptInputProviderProps {
  children: React.ReactNode;
}

/**
 * Kept for API compatibility with the upstream component. `PromptInput` is
 * self-contained, so this simply exposes an optional shared text state for
 * consumers that want to drive the input externally. Passthrough by default.
 */
const PromptInputProvider: React.FC<PromptInputProviderProps> = ({ children }) => {
  const [text, setText] = useState('');
  return (
    <PromptInputContext.Provider value={{ text, setText }}>
      {children}
    </PromptInputContext.Provider>
  );
};

export function usePromptInput(): PromptInputContextValue | null {
  return useContext(PromptInputContext);
}

// ---------------------------------------------------------------------------
// PromptInput — multiline text field + round send button
// ---------------------------------------------------------------------------

export interface PromptInputHandle {
  focus: () => void;
  blur: () => void;
  clear: () => void;
}

export interface PromptInputProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

const PromptInput = forwardRef<PromptInputHandle, PromptInputProps>(function PromptInput(
  { onSubmit, placeholder, disabled = false },
  ref,
) {
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    blur: () => inputRef.current?.blur(),
    clear: () => setText(''),
  }));

  const isSendDisabled = disabled || text.trim().length === 0;

  const handleSend = () => {
    const trimmed = text.trim();
    if (disabled || trimmed.length === 0) return;
    onSubmit(trimmed);
    setText('');
  };

  return (
    <View style={styles.inputRow}>
      <TextInput
        ref={inputRef}
        multiline
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor="#6B7280"
        editable={!disabled}
        keyboardAppearance="dark"
        returnKeyType="send"
        // Return sends instead of inserting a newline, and keeps the keyboard up
        // so the user can keep typing. handleSend already ignores empty/disabled.
        submitBehavior="submit"
        onSubmitEditing={handleSend}
        style={styles.textInput}
      />
      {/* Gluestack Button (className/tva-driven) rather than a Pressable with a
          function-form style prop — NativeWind v4's babel interop drops that
          form, which erased this button's orange fill at runtime (item-13 bug).
          Dark-mode primary-400 = rgb(231,138,83); isDisabled dims via the
          Button's built-in data-[disabled=true]:opacity-40. */}
      <Button
        onPress={handleSend}
        isDisabled={isSendDisabled}
        accessibilityLabel="Send"
        hitSlop={8}
        className="w-9 h-9 p-0 rounded-full bg-primary-400 data-[active=true]:bg-primary-300 data-[active=true]:scale-90"
      >
        <MaterialIcons name="arrow-upward" size={20} color="#FFFFFF" />
      </Button>
    </View>
  );
});

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  conversation: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  listContent: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  olderSpinnerRow: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  messageRow: {
    width: '100%',
    marginVertical: 2,
  },
  messageRowUser: {
    alignItems: 'flex-end',
  },
  messageRowAssistant: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '88%',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    // Soft float. Shadows are faint on dark, so this pairs with the lighter
    // bubble surfaces above to make the elevation read.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 5,
    elevation: 4,
  },
  bubbleUser: {
    backgroundColor: USER_SURFACE,
  },
  bubbleAssistant: {
    // No border — the panel keeps the only orange outline. Role is signaled by
    // surface tone + alignment instead.
    backgroundColor: ASSISTANT_SURFACE,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingBottom: 12,
    paddingTop: 4,
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: INPUT_SURFACE,
    borderRadius: 20,
    color: TEXT_COLOR,
    fontSize: CHAT_FONT_SIZE,
    lineHeight: CHAT_LINE_HEIGHT,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    maxHeight: 140,
    textAlignVertical: 'top',
  },
});

const markdownStyles = StyleSheet.create({
  body: {
    color: TEXT_COLOR,
    fontSize: CHAT_FONT_SIZE,
    lineHeight: CHAT_LINE_HEIGHT,
    textAlign: 'left',
  },
  strong: {
    fontWeight: 'bold' as const,
  },
  em: {
    fontStyle: 'italic' as const,
  },
  paragraph: {
    textAlign: 'left',
    marginTop: 0,
    marginBottom: 6,
  },
  bullet_list: {
    marginVertical: 2,
  },
  ordered_list: {
    marginVertical: 2,
  },
  list_item: {
    marginVertical: 1,
  },
});

export {
  Conversation,
  ConversationContent,
  Message,
  MessageContent,
  MessageResponse,
  PromptInput,
  PromptInputProvider,
};
