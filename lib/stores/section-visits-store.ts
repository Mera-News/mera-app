// section-visits-store — persisted map of factId → last-visited epoch ms for
// Dashboard sections. Mirrors for-you-prefs-store's persistence pattern (single
// JSON blob under one settings KV key) and opened-stories-store's optimistic-
// merge rule (a markVisited() that races ahead of hydrate() must not be lost —
// and since both sides are timestamps rather than set members, "merge" means
// keeping the newer of the two per factId, not just the union of keys).

import { create } from 'zustand';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

const SETTING_KEY = 'section_last_visited_v1';

/** Feed window is 24h; 7d is a generous retention so we don't grow unbounded
 *  across long-tail facts while still comfortably covering the feed window. */
export const SECTION_VISIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface SectionVisitsState {
    /** factId → lastVisitedAt epoch ms. */
    visits: Record<string, number>;
    hydrated: boolean;
    /** One-shot JSON load from settings KV; prunes entries older than retention;
     *  merges any optimistic markVisited that raced ahead (optimistic value wins
     *  if newer). */
    hydrate: () => Promise<void>;
    /** visits[factId] = atMs (default Date.now()); persists serialized map
     *  fire-and-forget. */
    markVisited: (factId: string, atMs?: number) => void;
}

function parseVisits(raw: string | null): Record<string, number> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, number>;
        }
        return {};
    } catch {
        return {};
    }
}

function pruneStale(visits: Record<string, number>, now: number): Record<string, number> {
    const pruned: Record<string, number> = {};
    for (const [factId, atMs] of Object.entries(visits)) {
        if (now - atMs <= SECTION_VISIT_RETENTION_MS) {
            pruned[factId] = atMs;
        }
    }
    return pruned;
}

let hydrating: Promise<void> | null = null;

export const useSectionVisitsStore = create<SectionVisitsState>()((set, get) => ({
    visits: {},
    hydrated: false,

    hydrate: async () => {
        if (hydrating) return hydrating;
        hydrating = (async () => {
            try {
                const raw = await getSetting(SETTING_KEY);
                const now = Date.now();
                const stored = pruneStale(parseVisits(raw), now);

                // Merge, don't replace — a markVisited() may have landed while the
                // settings read was in flight; that write must not be lost. For each
                // factId, the newer of the stored value and the current in-memory
                // (optimistic) value wins.
                const current = get().visits;
                const merged: Record<string, number> = { ...stored };
                for (const [factId, atMs] of Object.entries(current)) {
                    if (!(factId in merged) || atMs > merged[factId]) {
                        merged[factId] = atMs;
                    }
                }

                set({ visits: merged, hydrated: true });
            } catch (err) {
                logger.captureException(err, { tags: { store: 'section-visits-store' } });
                set({ hydrated: true });
            } finally {
                hydrating = null;
            }
        })();
        return hydrating;
    },

    markVisited: (factId, atMs) => {
        const next = { ...get().visits, [factId]: atMs ?? Date.now() };
        set({ visits: next });
        setSetting(SETTING_KEY, JSON.stringify(next)).catch((err) =>
            logger.captureException(err, { tags: { store: 'section-visits-store' } }),
        );
    },
}));
