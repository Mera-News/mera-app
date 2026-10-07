// The on-device chat's live state. It used to be `useState` inside
// useLocalLLM, so closing the chat (which unmounts the view) threw away a turn
// still running on device. In a store it lives with the chat session
// (chat-session.ts) instead, whatever is mounted.

import { create } from 'zustand';
import type { ConversationMessage } from '@/lib/llm/types';

export interface LocalChatState {
    messages: ConversationMessage[];
    /** Whether text is arriving: a composer concern. */
    status: 'idle' | 'streaming';
    /** True until the WHOLE turn settles, tool execution included, which
     *  runs after `status` is already idle. */
    turnBusy: boolean;
    isBlocked: boolean;
    blockedReason: string | null;
    error: string | null;
}

const initialState: LocalChatState = {
    messages: [],
    status: 'idle',
    turnBusy: false,
    isBlocked: false,
    blockedReason: null,
    error: null,
};

export const useLocalChatStore = create<LocalChatState>(() => ({ ...initialState }));

export function resetLocalChat(): void {
    useLocalChatStore.setState({ ...initialState });
}
