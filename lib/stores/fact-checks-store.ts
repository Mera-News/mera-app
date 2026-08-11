// In-memory mirror of the on-device `fact_checks` table.
//
// Why a store at all rather than each surface querying WatermelonDB: three
// unrelated places write to that table — the detail panel (a check the reader
// just asked for), the push handler (an answer arriving while the app is
// backgrounded), and the list screen's delete — and two places read it. Without
// a shared subscription, deleting a row on the list screen leaves the
// Dashboard's block showing it until the Dashboard happens to remount, and a
// push-delivered result never appears at all.
//
// Deliberately NOT a WatermelonDB observable: the table is tiny (one row per
// story the user personally asked about), the surfaces are two, and an explicit
// `load()` after each write is three lines against a subscription lifecycle to
// manage. Revisit if a third reader appears.

import { create } from 'zustand';
import {
    deleteFactCheck,
    listFactChecks,
    type StoredFactCheck,
} from '../database/services/fact-check-record-service';

/** How many the Dashboard block shows before "View all". */
export const DASHBOARD_FACT_CHECK_PREVIEW = 3;

interface FactChecksState {
    /** Newest request first. Empty until the first `load()`. */
    items: StoredFactCheck[];
    /** False until a load has completed once — lets a surface tell "nothing
     *  stored" apart from "not read yet" and skip rendering an empty state that
     *  is about to be replaced. */
    hydrated: boolean;
    load: () => Promise<void>;
    remove: (id: string) => Promise<void>;
}

export const useFactChecksStore = create<FactChecksState>((set) => ({
    items: [],
    hydrated: false,

    load: async () => {
        const items = await listFactChecks();
        set({ items, hydrated: true });
    },

    remove: async (id: string) => {
        // Optimistic: the delete is local-only and the service swallows its own
        // failures, so waiting would only make the row linger under the finger.
        set((state) => ({ items: state.items.filter((it) => it.id !== id) }));
        await deleteFactCheck(id);
    },
}));

/**
 * The whole list, newest first. Consumers slice it themselves inside a `useMemo`
 * — a `.slice()` INSIDE the selector would allocate a fresh array on every store
 * read, and zustand compares with `Object.is`, so it would re-render forever.
 */
export const useFactCheckItems = () => useFactChecksStore((state) => state.items);
export const useFactChecksHydrated = () => useFactChecksStore((state) => state.hydrated);
