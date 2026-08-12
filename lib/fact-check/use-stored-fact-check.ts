/**
 * Read the locally-stored fact checks for one article. Local only — no network,
 * no reconcile, no writes. One-shot, not live: this exists for a single mount
 * (see below), not a screen that stays open while a check resolves.
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
 * not found" and show nothing else, having thrown away every fact check the
 * device still holds for it.
 *
 * PLURAL, post-v52. An article can carry a legacy whole-article row plus one
 * row per claim the user picked, and the orphan card must show all of them —
 * showing only the first would silently drop every claim after it the moment a
 * reader ever asked about a second one.
 *
 * `enabled` is what keeps this off the happy path. It only runs once the screen
 * KNOWS the article failed to load, so a normal article open costs no extra
 * query — `FactCheckPanel`'s own observer already covers that case.
 */

import { useEffect, useState } from 'react';
import {
    listFactChecksForArticle,
    type StoredFactCheck,
} from '../database/services/fact-check-record-service';

export function useStoredFactCheck(
    articleId: string | null | undefined,
    enabled: boolean,
): StoredFactCheck[] {
    const [stored, setStored] = useState<StoredFactCheck[]>([]);

    useEffect(() => {
        if (!articleId || !enabled) return;
        let cancelled = false;
        void (async () => {
            const rows = await listFactChecksForArticle(articleId);
            if (!cancelled) setStored(rows);
        })();
        return () => { cancelled = true; };
    }, [articleId, enabled]);

    return stored;
}
