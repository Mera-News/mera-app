// In-memory mirror of the on-device `fact_checks` table.
//
// Why a store at all rather than each surface querying WatermelonDB: three
// unrelated places write to that table — a chat-driven check being enqueued,
// F2's runner landing a result, and the list screen's delete — and two places
// read it. Without a shared subscription, deleting a row on the list screen
// leaves the Dashboard's block showing it until the Dashboard happens to
// remount, and a result that lands while the Dashboard is elsewhere never
// appears until the next explicit read.
//
// Deliberately NOT a WatermelonDB observable: the table is tiny (one row per
// claim the user personally asked about), the surfaces are two, and an
// explicit `load()` on each (re)selection is three lines against a
// subscription lifecycle to manage. Revisit if a third reader appears.
//
// `refresh` used to also RECONCILE every unresolved row against the server —
// that pipeline is gone. There is nothing left to reconcile against: the
// on-device runner writes straight to this table (via `fact-check-queue.ts`),
// so a local read is already the up-to-date answer. `refresh` is kept as a
// distinct action (rather than folded into `load`) only so the list's
// `RefreshControl` has something with its own in-flight flag to bind to.

import { create } from 'zustand';
import {
    deleteFactCheck,
    listFactChecks,
    type StoredFactCheck,
} from '../database/services/fact-check-record-service';
import { releaseFactCheckRetention } from '../database/services/saved-article-suggestion-service';

/** How many the Dashboard block shows before "View all". */
export const DASHBOARD_FACT_CHECK_PREVIEW = 3;

interface FactChecksState {
    /** Newest request first. Empty until the first `load()`. */
    items: StoredFactCheck[];
    /** False until a load has completed once — lets a surface tell "nothing
     *  stored" apart from "not read yet" and skip rendering an empty state that
     *  is about to be replaced. */
    hydrated: boolean;
    /** A read is in flight — drives the list's pull-to-refresh spinner. */
    refreshing: boolean;
    /** Read the local table. Cheap, offline, no network — this is the ONLY
     *  read there is now. */
    load: () => Promise<void>;
    /** Same read as `load`, behind the `refreshing` flag the pull-to-refresh
     *  control binds to. */
    refresh: () => Promise<void>;
    remove: (id: string) => Promise<void>;
}

export const useFactChecksStore = create<FactChecksState>((set, get) => ({
    items: [],
    hydrated: false,
    refreshing: false,

    load: async () => {
        const items = await listFactChecks();
        set({ items, hydrated: true });
    },

    refresh: async () => {
        if (get().refreshing) return;
        set({ refreshing: true });
        try {
            const items = await listFactChecks();
            set({ items, hydrated: true });
        } finally {
            set({ refreshing: false });
        }
    },

    remove: async (id: string) => {
        // Captured before the optimistic filter drops it — the retention
        // release below needs the article id.
        const item = get().items.find((it) => it.id === id);
        // Optimistic: the delete is local-only and the service swallows its own
        // failures, so waiting would only make the row linger under the finger.
        set((state) => ({ items: state.items.filter((it) => it.id !== id) }));
        await deleteFactCheck(id);
        // Deleting the LAST fact check for an article releases its retention
        // snapshot (the release checks that itself, and never touches a row the
        // user saved). Hooked here rather than in the record service so the two
        // DB services stay import-cycle free.
        if (item?.articleId) {
            await releaseFactCheckRetention(item.articleId);
        }
    },
}));

/**
 * The whole list, newest first. Consumers slice it themselves inside a `useMemo`
 * — a `.slice()` INSIDE the selector would allocate a fresh array on every store
 * read, and zustand compares with `Object.is`, so it would re-render forever.
 */
export const useFactCheckItems = () => useFactChecksStore((state) => state.items);
export const useFactChecksHydrated = () => useFactChecksStore((state) => state.hydrated);
export const useFactChecksRefreshing = () =>
    useFactChecksStore((state) => state.refreshing);
