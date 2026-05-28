import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useRef } from 'react';
import {
    Pressable,
    StyleSheet,
    TextInput,
    View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import StreamingIndicator from './StreamingIndicator';

export interface MeraChatBaseUIProps {
    // Message display
    latestMessage: string;
    isStreaming: boolean;
    isLoading: boolean;
    loadingMessage?: string;

    // Intro message (shown before first interaction)
    introMessage?: string | null;

    // Input
    inputText: string;
    onChangeText: (text: string) => void;
    onSend: () => void;
    isInputDisabled: boolean;

    // Close button
    onClose?: () => void;

    // Blocked message (shown inline in LLM bubble)
    blockedMessage?: string | null;

    // Optional action button for blocked state (e.g. "Go to Settings")
    blockedActionLabel?: string;
    onBlockedAction?: () => void;

    // Ref forwarding for TextInput focus control
    textInputRef?: React.RefObject<TextInput | null>;
}

const MeraChatBaseUI: React.FC<MeraChatBaseUIProps> = ({
    latestMessage,
    isStreaming,
    isLoading,
    loadingMessage,
    introMessage,
    inputText,
    onChangeText,
    onSend,
    isInputDisabled,
    onClose,
    blockedMessage,
    blockedActionLabel,
    onBlockedAction,
    textInputRef: externalTextInputRef,
}) => {
    const internalTextInputRef = useRef<TextInput>(null);
    const textInputRef = externalTextInputRef ?? internalTextInputRef;

    // --- Derived ---
    const isSendDisabled = isInputDisabled || !inputText.trim() || !!blockedMessage;
    const showStreamingIndicator = isStreaming && !latestMessage;

    // --- Loading state ---
    if (isLoading) {
        return (
            <View style={styles.loadingContainer}>
                <Spinner size="large" />
                <Text style={styles.loadingText}>{loadingMessage ?? 'Starting chat...'}</Text>
            </View>
        );
    }

    return (
        <View style={{ backgroundColor: 'transparent', paddingBottom: 32 }}>
            {/* LLM Text Bubble — only visible when there's content */}
            {(blockedMessage || showStreamingIndicator || introMessage || latestMessage) && (
                <View style={styles.messageBubble}>
                    {blockedMessage ? (
                        <View style={styles.blockedContainer}>
                            <MaterialIcons name="block" size={24} color="#F87171" />
                            <View style={{ flex: 1 }}>
                                <Text style={styles.blockedText}>{blockedMessage}</Text>
                                {blockedActionLabel && onBlockedAction && (
                                    <Pressable
                                        onPress={onBlockedAction}
                                        style={{ marginTop: 8, alignSelf: 'flex-start', backgroundColor: 'rgba(239,68,68,0.15)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 }}
                                    >
                                        <Text style={{ color: '#F87171', fontSize: 13, fontWeight: '600' }}>{blockedActionLabel}</Text>
                                    </Pressable>
                                )}
                            </View>
                        </View>
                    ) : (
                        <View style={{ maxHeight: 130 }}>
                            {showStreamingIndicator ? (
                                <StreamingIndicator />
                            ) : introMessage ? (
                                <Markdown style={markdownStyles}>{introMessage}</Markdown>
                            ) : latestMessage ? (
                                <Markdown style={markdownStyles}>{latestMessage}</Markdown>
                            ) : null}
                            {isStreaming && latestMessage ? (
                                <View style={styles.processingRow}>
                                    <Spinner size="small" />
                                </View>
                            ) : null}
                        </View>
                    )}
                </View>
            )}



            {/* Input Row */}
            <View style={styles.inputContainer}>
                {onClose && (
                    <Pressable onPress={onClose} style={styles.closeButton}>
                        <MaterialIcons name="close" size={20} color="#FFFFFF" />
                    </Pressable>
                )}
                <TextInput
                    ref={textInputRef}
                    multiline
                    value={inputText}
                    onChangeText={onChangeText}
                    placeholder={isStreaming ? 'Waiting for response...' : 'Type a message...'}
                    placeholderTextColor="#6B7280"
                    editable={!isInputDisabled && !blockedMessage}
                    keyboardAppearance="dark"
                    returnKeyType="default"
                    blurOnSubmit={false}
                    style={styles.textInput}
                />
                <Pressable
                    onPress={isSendDisabled ? undefined : onSend}
                    disabled={isSendDisabled}
                    style={styles.sendButton}
                >
                    <MaterialIcons name="arrow-upward" size={20} color="#FFFFFF" />
                </Pressable>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    chatContainer: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: 'rgb(231, 138, 83)',
        borderRadius: 16,
        overflow: 'hidden',
    },
    loadingContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 48,
        paddingHorizontal: 24,
        gap: 16,
    },
    loadingText: {
        color: '#FFFFFF',
        fontSize: 15,
        textAlign: 'center',
    },
    processingRow: {
        marginTop: 8,
        alignItems: 'center',
    },
    messageBubble: {
        backgroundColor: '#1a1a1a',
        borderRadius: 16,
        borderWidth: 1,
        borderColor: 'rgb(231, 138, 83)',
        marginHorizontal: 12,
        marginBottom: 12,
        padding: 16,
        maxHeight: 300,
    },
    blockedContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    blockedText: {
        color: '#F87171',
        fontSize: 14,
        flex: 1,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 12,
        paddingBottom: 12,
        paddingTop: 4,
        gap: 8,
    },
    closeButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgb(231, 138, 83)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    sendButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgb(231, 138, 83)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    textInput: {
        flex: 1,
        backgroundColor: 'rgb(34, 34, 34)',
        borderRadius: 20,
        color: 'rgb(193, 193, 193)',
        fontSize: 14,
        paddingHorizontal: 14,
        paddingTop: 10,
        paddingBottom: 10,
        maxHeight: 100,
        textAlignVertical: 'top',
    },
});

const markdownStyles = StyleSheet.create({
    body: {
        color: 'rgb(193, 193, 193)',
        fontSize: 14,
        textAlign: 'center',
    },
    strong: {
        fontWeight: 'bold' as const,
    },
    em: {
        fontStyle: 'italic' as const,
    },
    paragraph: {
        textAlign: 'center',
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

export default MeraChatBaseUI;
