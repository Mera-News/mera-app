import ChatPopover from '@/components/custom/floating-chat/ChatPopover';
import MeraChatSession from '@/components/custom/floating-chat/MeraChatSession';
import { prewarmCloudChat } from '@/lib/llm/prewarm';
import { useAiAccess } from '@/lib/stores/subscription-store';
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
    const aiAccess = useAiAccess();

    // This overlay is the always-mounted, single-instance chat surface (mounted
    // once by app/logged-in/_layout), so this effect is the earliest point to
    // warm the cloud-chat path (attestation + JWT + a throwaway model
    // completion) ahead of the user ever opening the panel or tapping the
    // floating bubble. prewarmCloudChat is internally guarded (on-device
    // no-op, JWT-gated) and deduped to a 30-min TTL, so re-firing this effect
    // is cheap.
    //
    // The hook itself must still run unconditionally (React rules), so the
    // gate lives in the effect BODY rather than the hook call. Deliberately
    // the OPPOSITE polarity from the render gate below (`=== 'locked'`):
    // `aiAccess` starts 'unknown' for EVERY user including locked ones, so
    // gating on `!== 'locked'` would fire prewarm during that unknown window
    // and 403 server-side for a companion-mode user. Waiting for a CONFIRMED
    // 'entitled' costs a subscriber nothing (still fires the moment
    // entitlement resolves) and keeps a locked user's token request off the
    // wire entirely.
    useEffect(() => {
        if (aiAccess !== 'entitled') return;
        prewarmCloudChat();
    }, [aiAccess]);

    // Companion mode: no chat surface anywhere. `'unknown'` (cold-start, not
    // yet heard from RevenueCat/server) must fall through to rendering — only
    // a confirmed 'locked' hides the host.
    if (aiAccess === 'locked') return null;

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
