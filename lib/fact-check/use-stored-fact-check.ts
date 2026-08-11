/**
 * Read the locally-stored fact check for one article. Local only — no network,
 * no reconcile, no writes.
 *
 * Exists for ONE caller with a specific need: the article-detail screen's
 * "article is no longer available" state.
 *
 * `NewsArticle` rows are swept at 48h, while `fact_checks` rows deliberately
 * outlive them (which is why the serving path is keyed on `articleIds` at all).
 * So any fact check older than about two days points at an article that no
 * longer exists — that is the NORMAL state of an older row, not an edge case.
 * Tapping such a card lands on the unavailable state, and without this the
 * reader would lose the very thing they tapped: the screen would say "Article
 * not found" and show nothing else, having thrown away a fact check the device
 * still holds in full.
 *
 * `enabled` is what keeps this off the happy path. It only runs once the screen
 * KNOWS the article failed to load, so a normal article open costs no extra
 * query — the FactCheckPanel's own read already covers that case.
 */

import { useEffect, useState } from 'react';
import {
    getFactCheckForArticle,
    type StoredFactCheck,
} from '../database/services/fact-check-record-service';

export function useStoredFactCheck(
    articleId: string | null | undefined,
    enabled: boolean,
): StoredFactCheck | null {
    const [stored, setStored] = useState<StoredFactCheck | null>(null);

    useEffect(() => {
        if (!articleId || !enabled) return;
        let cancelled = false;
        void (async () => {
            const row = await getFactCheckForArticle(articleId);
            if (!cancelled) setStored(row);
        })();
        return () => { cancelled = true; };
    }, [articleId, enabled]);

    return stored;
}
