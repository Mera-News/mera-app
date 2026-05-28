import { create } from 'zustand';

interface ChatPopupState {
    // State
    isExpanded: boolean;
    conversationId: string | null;
    factMutationVersion: number;

    // Actions
    expand: () => void;
    collapse: () => void;
    setConversationId: (id: string) => void;
    notifyFactMutation: () => void;
    reset: () => void;
}

export const useChatPopupStore = create<ChatPopupState>((set) => ({
    isExpanded: false,
    conversationId: null,
    factMutationVersion: 0,

    expand: () => set({ isExpanded: true }),

    collapse: () => set({ isExpanded: false }),

    setConversationId: (id) => set({ conversationId: id }),

    notifyFactMutation: () => set((state) => ({ factMutationVersion: state.factMutationVersion + 1 })),

    reset: () => set({
        isExpanded: false,
        conversationId: null,
        factMutationVersion: 0,
    }),
}));

// Selector hooks for optimized subscriptions
export const useChatPopupIsExpanded = () => useChatPopupStore((state) => state.isExpanded);
export const useChatPopupConversationId = () => useChatPopupStore((state) => state.conversationId);
export const useChatPopupFactMutationVersion = () => useChatPopupStore((state) => state.factMutationVersion);
