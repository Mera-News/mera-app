import { createContext, useContext, useSyncExternalStore } from 'react';

// Whether the page a node sits in is the visible one. Warm neighbours stay
// mounted one width to the side; a translatable node there must not re-ask.
// A leaf that imports only react: TranslatableDynamic sits under every card,
// and importing TabPages from it would close a cycle through the pages.
//
// The context carries a STABLE source per panel, never a boolean: a boolean
// value re-renders every consumer under the panel (every card) on each page
// flip. A node that only needs to know at the moment it asks holds the source
// and reads `isActive()`; `usePageActive` subscribes for those that render on it.

export interface PageActiveSource {
    isActive(): boolean;
    subscribe(listener: () => void): () => void;
}

/** Outside TabPages a screen is always the visible one. */
const ALWAYS_ACTIVE: PageActiveSource = { isActive: () => true, subscribe: () => () => {} };

export const PageActiveContext = createContext<PageActiveSource>(ALWAYS_ACTIVE);

/** One panel's source. TabPages keeps one per page id and calls `set` when the visible page changes. */
export function createPageActiveSource(initial: boolean): PageActiveSource & { set(active: boolean): void } {
    let active = initial;
    const listeners = new Set<() => void>();
    return {
        isActive: () => active,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        set: (next) => {
            if (next === active) return;
            active = next;
            listeners.forEach((listener) => listener());
        },
    };
}

export function usePageActiveSource(): PageActiveSource {
    return useContext(PageActiveContext);
}

export function usePageActive(): boolean {
    const source = usePageActiveSource();
    return useSyncExternalStore(source.subscribe, source.isActive, source.isActive);
}
