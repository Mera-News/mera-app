// cloud-chat-store — Zustand store for cloud persona chat state.
// Persists across component mount/unmount cycles so remounts don't lose data.

import { create } from 'zustand';
import type { AgentTurnState } from '../mera-harness';
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
  /**
   * The agent loop's turn state. P1's loop is the ONLY writer; the thread
   * reads `turnActive` and the ask_choice card reads nothing at all — a card
   * that cleared `pendingChoice` on tap would delete the payload the loop is
   * about to read, which is the whole reason this is not component state.
   *
   * Lifetime, and both halves matter:
   *  - it SURVIVES closing and reopening the popover, or the guarantee lapses
   *    at exactly the moment a user comes back to answer a question;
   *  - it is CLEARED on a new conversation, because a pending choice belongs
   *    to the thread that asked it. `reset()` is called only from
   *    MeraChatSession's ensure-conversation effect (conversationId === null),
   *    never on popover close, so living in `initialState` gives both.
   *
   * An app restart drops it with its conversation, which is the same rule
   * rather than a gap: this store has no persist middleware and a launch
   * always begins a new conversation.
   */
  agentTurnState: AgentTurnState | null;

  // Actions
  setMessages: (messages: ConversationMessage[] | ((prev: ConversationMessage[]) => ConversationMessage[])) => void;
  setStatus: (status: 'idle' | 'streaming') => void;
  setIsBlocked: (blocked: boolean) => void;
  setBlockedReason: (reason: string | null) => void;
  setError: (error: string | null) => void;
  setThinking: (thinking: boolean) => void;
  setAgentTurnState: (state: AgentTurnState | null) => void;
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
  agentTurnState: null as AgentTurnState | null,
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

  setAgentTurnState: (agentTurnState) => set({ agentTurnState }),

  pushWireMessage: (msg) =>
    set((state) => ({ wireMessages: [...state.wireMessages, msg] })),

  getWireMessages: () => get().wireMessages,

  reset: () => set({ ...initialState }),
}));
