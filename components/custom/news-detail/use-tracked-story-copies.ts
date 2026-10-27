import { useEffect, useMemo, useState } from 'react';
import type { UserGeoLanguageContext } from '@/lib/algorithms/geo-language-priority';
import { getTrackedStoryById } from '@/lib/database/services/tracked-story-service';
import {
    buildTimeline,
    foldTimeline,
    type TimelineCard,
} from '@/components/custom/tracked-stories/merge-timeline';

/**
 * The other copies of a followed story's member, for a detail page opened from
 * that story's timeline (`trackedStoryId` rides the route). They come from the
 * story's own snapshots and retention rows, so they list the same before and
 * after the 48h sweep that empties `article_suggestions`, which the live
 * sibling grouping cannot do. Empty without a `trackedStoryId`, and on any
 * failure: the page just has no extra block.
 */
export function useTrackedStoryCopies(
    trackedStoryId: string | undefined,
    articleId: string | null,
    userCtx: UserGeoLanguageContext | null,
): TimelineCard[] {
    const [cards, setCards] = useState<TimelineCard[]>([]);
    useEffect(() => {
        if (!trackedStoryId) return;
        let cancelled = false;
        getTrackedStoryById(trackedStoryId)
            .then((story) => {
                if (!cancelled && story) setCards(buildTimeline(story.memberSnapshots ?? []));
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [trackedStoryId]);
    return useMemo(() => {
        if (!articleId || cards.length === 0) return [];
        const entry = foldTimeline(cards, userCtx).find(
            (e) => e.head.articleId === articleId || e.copies.some((c) => c.articleId === articleId),
        );
        return entry ? [entry.head, ...entry.copies].filter((c) => c.articleId !== articleId) : [];
    }, [cards, articleId, userCtx]);
}
