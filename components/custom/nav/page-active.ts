import { createContext, useContext } from 'react';

// Whether the page a node sits in is the visible one. Warm neighbours stay
// mounted one width to the side; a translatable node there must not re-ask.
// True outside TabPages (a pushed screen is always the visible one). A leaf
// that imports only react: TranslatableDynamic sits under every card, and
// importing TabPages from it would close a cycle through the pages.
export const PageActiveContext = createContext(true);

export function usePageActive(): boolean {
    return useContext(PageActiveContext);
}
