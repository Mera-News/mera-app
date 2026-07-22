import ChatPopover from '@/components/custom/floating-chat/ChatPopover';
import MeraChatSession from '@/components/custom/floating-chat/MeraChatSession';
import { prewarmCloudChat } from '@/lib/llm/prewarm';
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * Absolute-fill overlay hosting ONLY the chat popover.
 *
 * The chat-head BUBBLE is now rendered per-screen (ScreenChatBubble) as the
 * last child of each surface's root, so it unmounts with its screen during the
 * native navigation transition and can never visibly linger on the outgoing
 * screen.
 *
 * The POPOVER stays app-level here so it remains the topmost popup (above every
 * card screen) and keeps a single conversation alive across navigations — both
 * of which a per-screen mount would break. `pointerEvents="box-none"` keeps the
 * underlying screens interactive; only the popover itself captures touches.
 */
const FloatingChatHost: React.FC = () => {
    // This overlay is the always-mounted, single-instance chat surface (mounted
    // once by app/logged-in/_layout), so an empty-dep effect fires exactly once
    // per logged-in session — the earliest point to warm the cloud-chat path
    // (attestation + JWT + a throwaway model completion) ahead of the user ever
    // opening the panel or tapping the floating bubble. prewarmCloudChat is
    // internally guarded (on-device no-op, JWT-gated) and deduped, so this is a
    // safe fire-and-forget.
    useEffect(() => {
        prewarmCloudChat();
    }, []);

    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            {/* Always mounted — ChatPopover renders nothing while collapsed. */}
            <ChatPopover>
                <MeraChatSession />
            </ChatPopover>
        </View>
    );
};

export default FloatingChatHost;
