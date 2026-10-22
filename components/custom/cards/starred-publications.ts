// The publications a reader tagged More from or Subscribed, for the star
// before a publication name on every card and the article page. Imports no
// database code (the card graph must stay jest-safe); its one writer is
// `useStarredPublicationsSync`, mounted once in the tab layout.

import { normPublicationName } from '@/lib/algorithms/geo-language-priority';
import { create } from 'zustand';

interface StarredPublicationsState {
    readonly names: ReadonlySet<string>;
}

export const useStarredPublicationsStore = create<StarredPublicationsState>(() => ({
    names: new Set(),
}));

/** Pure match: `names` holds normalized RAW publication names (the key, never a display name). */
export function isStarredPublication(names: ReadonlySet<string>, raw: string | null | undefined): boolean {
    const name = normPublicationName(raw);
    return name !== null && names.has(name);
}

export function useIsStarredPublication(raw: string | null | undefined): boolean {
    return useStarredPublicationsStore((s) => isStarredPublication(s.names, raw));
}
