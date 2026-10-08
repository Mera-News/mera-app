// The Stats page's in-place share flow as one reducer (RN-free): Share enters
// select mode with every card picked; Cancel leaves it; Preview opens the
// modal; closing the modal by ANY route (✕, scrim, back, or Share finishing)
// leaves select mode too (owner), so the page is back to plain cards + Share.

import type { StatsCardId } from '@/lib/stats/reading-stats';

export interface ShareFlow {
    readonly selecting: boolean;
    readonly picked: readonly StatsCardId[];
    readonly previewOpen: boolean;
}

export type ShareFlowAction =
    | { readonly type: 'start'; readonly cards: readonly StatsCardId[] }
    | { readonly type: 'toggle'; readonly id: StatsCardId }
    | { readonly type: 'cancel' }
    | { readonly type: 'preview' }
    | { readonly type: 'closePreview' };

export const IDLE: ShareFlow = { selecting: false, picked: [], previewOpen: false };

export function shareFlow(state: ShareFlow, action: ShareFlowAction): ShareFlow {
    switch (action.type) {
        case 'start':
            return { selecting: true, picked: [...action.cards], previewOpen: false };
        case 'toggle':
            if (!state.selecting) return state;
            return {
                ...state,
                picked: state.picked.includes(action.id)
                    ? state.picked.filter((p) => p !== action.id)
                    : [...state.picked, action.id],
            };
        case 'preview':
            return state.selecting && state.picked.length > 0 ? { ...state, previewOpen: true } : state;
        case 'cancel':
        case 'closePreview':
            return IDLE;
    }
}
