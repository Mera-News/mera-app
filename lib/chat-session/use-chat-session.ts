// The view's handle on the chat session: attach from an effect (never during
// render), and send through a stable callback that attaches first, because a
// child's effect (the auto-send of a seeded message) runs before ours.

import type { PersistedMessage } from '@/lib/database/services/conversation-service';
import type { IAgent } from '@/lib/llm/types';
import { useCallback, useEffect, useRef } from 'react';
import { attachChatSession, type EngineKind } from './chat-session';

export function useChatSession(
    kind: EngineKind,
    agent: IAgent,
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
