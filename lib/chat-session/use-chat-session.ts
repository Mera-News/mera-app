// The view's handle on the chat session: attach from an effect (never during
// render), and send through a stable callback that attaches first, because a
// child's effect (the auto-send of a seeded message) runs before ours.

import { useRestartHold } from '@/lib/app-restart';
import type { PersistedMessage } from '@/lib/database/services/conversation-service';
import type { ChatAgent } from '@/lib/llm/agents/on-device/types';
import { useCallback, useEffect, useRef } from 'react';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { attachChatSession, type EngineKind } from './chat-session';

export function useChatSession(
    kind: EngineKind,
    agent: ChatAgent,
    conversationId: string | null,
    resumeMessages: readonly PersistedMessage[] | undefined,
): { send: (text: string) => void; sendHidden: (text: string) => void } {
    const opts = { kind, agent, conversationId, resumeMessages };
    const ref = useRef(opts);
    ref.current = opts;

    const engine = useCallback(() => {
        const o = ref.current;
        if (!o.conversationId) return null;
        return attachChatSession({
            conversationId: o.conversationId,
            kind: o.kind,
            agent: o.agent,
            persistedIds: (o.resumeMessages ?? []).map((m) => m.id),
        });
    }, []);

    useEffect(() => {
        engine();
    }, [engine, kind, agent, conversationId, resumeMessages]);

    const send = useCallback((text: string) => engine()?.send(text), [engine]);
    const sendHidden = useCallback((text: string) => engine()?.sendHidden(text), [engine]);
    return { send, sendHidden };
}

/**
 * While the chat panel is open, no AUTOMATIC reload (an OTA on a return): the
 * chat is never rebuilt after one. Auto-only, so the reader's own Restart tap
 * still reloads. Called once, from the always-mounted FloatingChatHost, so the
 * hold also covers a locked user's panel that never attaches an engine. Unsent
 * composer text is PromptInput state that dies with the panel, so this covers it.
 */
export function useChatPanelHold(): void {
    const open = useFloatingChatStore((s) => s.isExpanded);
    useRestartHold(open, 'chat-open', 'auto');
}
