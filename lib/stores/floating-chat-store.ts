import { create } from 'zustand';

export type ChatContext =
    | { kind: 'persona' }
    | { kind: 'article-suggestion'; suggestionId: string }
    | { kind: 'generic'; route: string };

interface FloatingChatState {
    // State
    isExpanded: boolean;
    context: ChatContext;
    bubbleSnapSide: 'left' | 'right';
    bubbleY: number; // top-referenced px
    bubbleCenter: { x: number; y: number };
    isGenerating: boolean;
    suppressed: boolean;
    factMutationVersion: number;
    // Conversation identity for the whole APP SESSION (not per popover open).
    // In-memory only (no persist middleware) so it naturally dies on app kill,
    // giving fresh-conversation-per-launch for free. Closing/reopening the
    // popover reuses this id, so messages resume.
    conversationId: string | null;
    // Bumped by the header "New chat" button; MeraChatSession watches it to spin
    // up a fresh conversation and remount the thread.
    newChatNonce: number;

    // Actions
    expand: (context?: ChatContext) => void;
    collapse: () => void;
    toggle: () => void;
    setBubblePosition: (side: 'left' | 'right', y: number) => void;
    setBubbleCenter: (c: { x: number; y: number }) => void;
    setGenerating: (v: boolean) => void;
    setSuppressed: (v: boolean) => void;
    notifyFactMutation: () => void;
    setConversationId: (id: string | null) => void;
    requestNewChat: () => void;
    reset: () => void;
}

const DEFAULT_CONTEXT: ChatContext = { kind: 'persona' };
// Sane bottom-ish default (top-referenced px); refined at runtime once the
// bubble measures the actual screen height via setBubblePosition.
const DEFAULT_BUBBLE_Y = 560;

const initialState = {
    isExpanded: false,
    context: DEFAULT_CONTEXT,
    bubbleSnapSide: 'right' as const,
    bubbleY: DEFAULT_BUBBLE_Y,
    bubbleCenter: { x: 0, y: 0 },
    isGenerating: false,
    suppressed: false,
    factMutationVersion: 0,
    conversationId: null as string | null,
    newChatNonce: 0,
};

export const useFloatingChatStore = create<FloatingChatState>((set) => ({
    ...initialState,

    expand: (context) =>
        set((state) => ({
            isExpanded: true,
            context: context ?? state.context,
        })),

    collapse: () => set({ isExpanded: false }),

    toggle: () => set((state) => ({ isExpanded: !state.isExpanded })),

    setBubblePosition: (side, y) => set({ bubbleSnapSide: side, bubbleY: y }),

    setBubbleCenter: (c) => set({ bubbleCenter: c }),

    setGenerating: (v) => set({ isGenerating: v }),

    setSuppressed: (v) => set({ suppressed: v }),

    notifyFactMutation: () => set((state) => ({ factMutationVersion: state.factMutationVersion + 1 })),

    setConversationId: (id) => set({ conversationId: id }),

    requestNewChat: () => set((state) => ({ newChatNonce: state.newChatNonce + 1 })),

    reset: () => set({ ...initialState }),
}));

// Selector hooks for optimized subscriptions
export const useFloatingChatIsExpanded = () => useFloatingChatStore((state) => state.isExpanded);
export const useFloatingChatFactMutationVersion = () =>
    useFloatingChatStore((state) => state.factMutationVersion);
export const useFloatingChatIsGenerating = () => useFloatingChatStore((state) => state.isGenerating);
export const useFloatingChatSuppressed = () => useFloatingChatStore((state) => state.suppressed);
export const useFloatingChatConversationId = () => useFloatingChatStore((state) => state.conversationId);
export const useFloatingChatNewChatNonce = () => useFloatingChatStore((state) => state.newChatNonce);
