// The windowed visits behind the Activity detail screens, read each time the
// screen is focused (a visit made meanwhile shows on return), plus the Stats
// figures computed from the same rows for the screens that share a card image.
// Reads only `publication_visits`; nothing is written.

import { getAllVisitedArticles, type VisitedArticle } from '@/lib/database/services/publication-visit-service';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import logger from '@/lib/logger';
import { computeReadingStats, type ReadingStats } from '@/lib/stats/reading-stats';
import { useEffect, useMemo, useState } from 'react';

export interface ActivityVisits {
    readonly visits: readonly VisitedArticle[];
    readonly loading: boolean;
    readonly stats: ReadingStats;
}

export function useActivityVisits(): ActivityVisits {
    const focused = useIsFocusedSafe();
    const [visits, setVisits] = useState<VisitedArticle[]>([]);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        if (!focused) return;
        let live = true;
        getAllVisitedArticles()
            .then((rows) => live && setVisits(rows))
            .catch((error) => logger.captureException(error, { tags: { hook: 'useActivityVisits' } }))
            .finally(() => live && setLoading(false));
        return () => {
            live = false;
        };
    }, [focused]);
    const stats = useMemo(() => computeReadingStats({ visits, nowMs: Date.now() }), [visits]);
    return { visits, loading, stats };
}
