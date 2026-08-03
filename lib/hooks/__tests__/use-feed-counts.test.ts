// computeFeedCounts — the pure counter behind the header stats sentence AND the
// feed-funnel diagnostic's "header says" line. Both read this one function on
// purpose, so these cases pin the exact arithmetic the user sees on screen.
//
// Only the pure export is exercised here; the `useFeedCounts` hook around it is
// a thin store subscription. The store modules are mocked away so this suite
// stays free of the WatermelonDB/zustand import graph.

jest.mock('@/lib/stores/selectors', () => ({
    useForYouCounts: jest.fn(),
    useForYouSuggestions: jest.fn(),
}));

jest.mock('@/lib/stores/opened-stories-store', () => ({
    useOpenedStoriesStore: jest.fn(),
}));

import { computeFeedCounts } from '@/lib/hooks/use-feed-counts';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { RENDER_GATE } from '@/lib/stores/fact-rows-selector';

const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const HOUR = 3_600_000;

/** A scored, in-window, comfortably-relevant row unless overridden. */
function row(
    articleId: string,
    over: Partial<{ status: string; firstPubDate: string; relevance: number }> = {},
) {
    return {
        articleId,
        status: 'complete',
        firstPubDate: new Date(NOW - HOUR).toISOString(),
        relevance: RENDER_GATE + 0.4,
        ...over,
    };
}

describe('computeFeedCounts', () => {
    it('excludes unscored rows from every counter', () => {
        const counts = computeFeedCounts(
            [
                row('a'),
                row('b', { status: ArticleSuggestionStatus.Unscored }),
                row('c', { status: ArticleSuggestionStatus.Unscored }),
            ],
            { nowMs: NOW, openedArticleIds: new Set(['a', 'b']) },
        );
        expect(counts).toEqual({ analysedCount: 1, relevantCount: 1, readCount: 1 });
    });

    it('drops rows published outside the 48h window (and unparseable dates)', () => {
        const counts = computeFeedCounts(
            [
                row('inside', { firstPubDate: new Date(NOW - 47 * HOUR).toISOString() }),
                row('outside', { firstPubDate: new Date(NOW - 49 * HOUR).toISOString() }),
                row('unparseable', { firstPubDate: 'not-a-date' }),
            ],
            { nowMs: NOW },
        );
        expect(counts.analysedCount).toBe(1);
        expect(counts.relevantCount).toBe(1);
    });

    it('counts as relevant only what is strictly above the render gate', () => {
        const counts = computeFeedCounts(
            [
                row('above', { relevance: RENDER_GATE + 0.01 }),
                // Exactly at the gate is NOT relevant — the feed's own filter is
                // `> RENDER_GATE`, and these two numbers get compared side by
                // side in the funnel diagnostic.
                row('at', { relevance: RENDER_GATE }),
                row('below', { relevance: 0 }),
            ],
            { nowMs: NOW },
        );
        expect(counts.analysedCount).toBe(3);
        expect(counts.relevantCount).toBe(1);
    });

    it('counts as read only rows that are BOTH relevant and opened', () => {
        const counts = computeFeedCounts(
            [
                row('opened-relevant'),
                row('unopened-relevant'),
                row('opened-stale', { firstPubDate: new Date(NOW - 60 * HOUR).toISOString() }),
            ],
            {
                nowMs: NOW,
                openedArticleIds: new Set(['opened-relevant', 'opened-stale', 'ghost-id']),
            },
        );
        expect(counts.analysedCount).toBe(2);
        expect(counts.relevantCount).toBe(2);
        expect(counts.readCount).toBe(1);
    });

    it('reports readCount 0 when no opened set is supplied', () => {
        expect(computeFeedCounts([row('a'), row('b')], { nowMs: NOW }).readCount).toBe(0);
        // …and with no options object at all (default clock, no opened set).
        expect(computeFeedCounts([row('a')]).readCount).toBe(0);
    });

    it('does not count an opened row that never cleared the relevance gate', () => {
        const counts = computeFeedCounts([row('dull', { relevance: 0.05 })], {
            nowMs: NOW,
            openedArticleIds: new Set(['dull']),
        });
        expect(counts).toEqual({ analysedCount: 1, relevantCount: 0, readCount: 0 });
    });
});
