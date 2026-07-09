import ChatPopover from '@/components/custom/floating-chat/ChatPopover';
import FloatingMeraBubble from '@/components/custom/floating-chat/FloatingMeraBubble';
import MeraChatSession from '@/components/custom/floating-chat/MeraChatSession';
import { useConfigPanelActiveTab } from '@/lib/stores/config-panel-store';
import {
    useFloatingChatIsExpanded,
    useFloatingChatSuppressed,
    type ChatContext,
} from '@/lib/stores/floating-chat-store';
import { usePathname } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

// Routes where the persona ChatContext is available today.
const CONFIG_PANEL_ROUTE = '/logged-in/config-panel';
const ONBOARDING_ROUTE = '/logged-in/onboarding';

/**
 * Maps the current route to the default chat context the bubble opens with.
 * v1: everything opens the persona chat. Future routes (article-suggestion
 * detail etc.) plug in here by matching on the pathname.
 */
function deriveContextFromRoute(pathname: string): ChatContext {
    void pathname; // reserved for route-specific contexts
    return { kind: 'persona' };
}

/**
 * Absolute-fill overlay hosting the floating chat-head bubble and its popover.
 * `pointerEvents="box-none"` keeps the underlying screens fully interactive —
 * only the bubble/popover themselves capture touches.
 */
const FloatingChatHost: React.FC = () => {
    const pathname = usePathname();
    const isExpanded = useFloatingChatIsExpanded();
    const suppressed = useFloatingChatSuppressed();
    const configPanelTab = useConfigPanelActiveTab();

    // TEMPORARY ALLOWLIST — the bubble surfaces only where a persona ChatContext
    // exists today: the config-panel's Persona tab, and the onboarding persona
    // step (where OnboardingWizard's `suppressed` flag hides it on other steps).
    // As new surfaces gain their own ChatContext (agent-registry.ts is the
    // extension point), widen this allowlist alongside the new context case.
    // Only the bubble is gated — the popover stays mounted and switching tabs
    // never force-closes an open chat (bubble visibility ⟂ popover expansion).
    const routeAllowed =
        (pathname === CONFIG_PANEL_ROUTE && configPanelTab === 'persona') ||
        pathname === ONBOARDING_ROUTE;
    const showBubble = routeAllowed && !isExpanded && !suppressed;

    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            {showBubble && <FloatingMeraBubble context={deriveContextFromRoute(pathname)} />}
            {/* Always mounted — ChatPopover renders nothing while collapsed. */}
            <ChatPopover>
                <MeraChatSession />
            </ChatPopover>
        </View>
    );
};

export default FloatingChatHost;
