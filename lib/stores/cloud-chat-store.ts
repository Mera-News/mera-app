// cloud-chat-store — Zustand store for cloud persona chat state.
// Persists across component mount/unmount cycles so remounts don't lose data.

import { create } from 'zustand';
import type { ConversationMessage } from '../llm/types';
import type { WireMessage } from '../llm/cloudComplete';

interface CloudChatState {
  // State
  messages: ConversationMessage[];
  status: 'idle' | 'streaming';
  isBlocked: boolean;
  blockedReason: string | null;
  error: string | null;
  wireMessages: WireMessage[];
  /** True while the model is streaming a reasoning trace and nothing visible
   *  has arrived yet. The trace itself is never stored or shown; this only
   *  lets the typing bubble say "Thinking…" instead of pulsing in silence. */
  thinking: boolean;

  // Actions
  setMessages: (messages: ConversationMessage[] | ((prev: ConversationMessage[]) => ConversationMessage[])) => void;
  setStatus: (status: 'idle' | 'streaming') => void;
  setIsBlocked: (blocked: boolean) => void;
  setBlockedReason: (reason: string | null) => void;
  setError: (error: string | null) => void;
  setThinking: (thinking: boolean) => void;
  pushWireMessage: (msg: WireMessage) => void;
  getWireMessages: () => WireMessage[];
  reset: () => void;
}

const initialState = {
  messages: [] as ConversationMessage[],
  status: 'idle' as const,
  isBlocked: false,
  blockedReason: null as string | null,
  error: null as string | null,
  wireMessages: [] as WireMessage[],
  thinking: false,
};

export const useCloudChatStore = create<CloudChatState>((set, get) => ({
  ...initialState,

  setMessages: (messagesOrUpdater) =>
    set((state) => ({
      messages: typeof messagesOrUpdater === 'function'
        ? messagesOrUpdater(state.messages)
        : messagesOrUpdater,
    })),

  setStatus: (status) => set({ status }),

  setIsBlocked: (blocked) => set({ isBlocked: blocked }),

  setBlockedReason: (reason) => set({ blockedReason: reason }),

  setError: (error) => set({ error }),

  setThinking: (thinking) => set((state) => (state.thinking === thinking ? state : { thinking })),

  pushWireMessage: (msg) =>
    set((state) => ({ wireMessages: [...state.wireMessages, msg] })),

  getWireMessages: () => get().wireMessages,

  reset: () => set({ ...initialState }),
}));
