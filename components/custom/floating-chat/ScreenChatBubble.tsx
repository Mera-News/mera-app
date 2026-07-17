import FloatingMeraBubble from '@/components/custom/floating-chat/FloatingMeraBubble';
import {
    useFloatingChatIsExpanded,
    useFloatingChatSuppressed,
    type ChatContext,
} from '@/lib/stores/floating-chat-store';
import React from 'react';
import { StyleSheet, View } from 'react-native';

interface ScreenChatBubbleProps {
    /** Chat context this screen opens the bubble with. */
    readonly context: ChatContext;
    /**
     * Extra bottom clearance to pass through to FloatingMeraBubble — set this
     * to TAB_BAR_HEIGHT (lib/navigation/tab-bar.ts) when the host screen sits
     * inside the bottom tab shell. Omit for screens with no tab bar.
     */
    readonly extraBottomOffset?: number;
}

/**
 * Per-screen host for the floating Mera chat-head. Rendered as the LAST child
 * of a screen's root container so the bubble draws above that screen's own
 * content (scrollviews, footers, FABs).
 *
 * Living inside the screen (rather than an app-level overlay) means the bubble
 * unmounts together with its screen during the native navigation transition —
 * so it can never visibly linger on the outgoing screen. The chat POPOVER stays
 * app-level (FloatingChatHost) to remain topmost and preserve conversation
 * continuity across navigations.
 *
 * The bubble renders statically — no enter/exit animation. It appears and
 * disappears with the screen itself (mount/unmount), so there is no transition
 * to linger. The bubble's internal ambient pulse and drag motion are untouched.
 *
 * Visibility is gated on the same store flags the old app-level host used:
 * hidden while the popover is expanded or while chat is suppressed.
 */
const ScreenChatBubble: React.FC<ScreenChatBubbleProps> = ({ context, extraBottomOffset }) => {
    const isExpanded = useFloatingChatIsExpanded();
    const suppressed = useFloatingChatSuppressed();

    if (isExpanded || suppressed) return null;

    return (
        // absoluteFill + box-none: a full-screen passthrough layer so the
        // bubble's own absolute positioning / drag translation isn't clipped
        // and the screen's content stays fully interactive underneath.
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            <FloatingMeraBubble context={context} extraBottomInset={extraBottomOffset} />
        </View>
    );
};

export default ScreenChatBubble;
