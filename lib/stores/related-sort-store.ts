import { create } from 'zustand';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import type { RelatedSortMode } from '@/lib/feed-grouping/related-articles-sort';
import logger from '@/lib/logger';

const KEY = 'related_articles_sort';

/** Menu order for the Related Articles sort control. */
export const RELATED_SORT_MODES: readonly RelatedSortMode[] = [
    'relevance',
    'oldest',
    'newest',
] as const;

/** Today's ordering — country blocks, then language/publication/date. */
export const DEFAULT_RELATED_SORT_MODE: RelatedSortMode = 'relevance';

/** Narrows an untrusted stored value; anything unrecognised falls back. */
export function parseRelatedSortMode(
    raw: string | null | undefined,
    fallback: RelatedSortMode = DEFAULT_RELATED_SORT_MODE,
): RelatedSortMode {
    return RELATED_SORT_MODES.includes(raw as RelatedSortMode)
        ? (raw as RelatedSortMode)
        : fallback;
}

interface RelatedSortState {
    /** How the Related Articles list on BOTH detail routes is ordered.
     *  Deliberately ONE setting shared by the two screens: they render the same
     *  list of the same story, so a per-route preference would read as the
     *  control forgetting itself when the reader chains between them. */
    mode: RelatedSortMode;
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setMode: (mode: RelatedSortMode) => void;
    /** Back to the default, unhydrated. Called from clearAllStores() — the
     *  settings row behind this is dropped with the database, so the in-memory
     *  copy must go too. */
    reset: () => void;
}

// Optimistic set + background persist, same as importance-filter-store: the
// list re-sorts off the set() alone, so the menu feels instant.
function persist(mode: RelatedSortMode) {
    setSetting(KEY, mode).catch((err) =>
        logger.captureException(err, { tags: { store: 'related-sort-store' } }),
    );
}

export const useRelatedSortStore = create<RelatedSortState>()((set) => ({
    mode: DEFAULT_RELATED_SORT_MODE,
    hydrated: false,

    reset: () => set({ mode: DEFAULT_RELATED_SORT_MODE, hydrated: false }),

    hydrate: async () => {
        try {
            const raw = await getSetting(KEY);
            set({ mode: parseRelatedSortMode(raw), hydrated: true });
        } catch (err) {
            logger.captureException(err, { tags: { store: 'related-sort-store' } });
            set({ hydrated: true });
        }
    },

    setMode: (mode) => {
        set({ mode });
        persist(mode);
    },
}));
