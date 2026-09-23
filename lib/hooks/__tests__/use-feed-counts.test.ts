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
    over: Partial<{
        status: string;
        firstPubDate: string;
        relevance: number;
        rawScore: number | null;
        eventType: string | null;
    }> = {},
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

    it('counts as relevant everything at or above the render gate (relevance v3: inclusive)', () => {
        const counts = computeFeedCounts(
            [
                row('above', { relevance: RENDER_GATE + 0.01 }),
                // Exactly at the gate IS relevant — the feed's own filter is
                // `>= RENDER_GATE`, and these two numbers get compared side by
                // side in the funnel diagnostic.
                row('at', { relevance: RENDER_GATE }),
                row('below', { relevance: RENDER_GATE - 0.01 }),
            ],
            { nowMs: NOW },
        );
        expect(counts.analysedCount).toBe(3);
        expect(counts.relevantCount).toBe(2);
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

// The importance dial is gone, so `relevant` is the render gate alone. These
// pin the two properties that used to be confounded with it: a LOW-band row
// counts, and a row below the gate never does even when it is breaking.
describe('computeFeedCounts — every scored band counts', () => {
    const rows = [
        row('low', { relevance: 0.4 }),
        row('med', { relevance: 0.6 }),
        row('high', { relevance: 0.8 }),
    ];

    it('counts a LOW-band row as relevant', () => {
        const counts = computeFeedCounts(rows, { nowMs: NOW });
        expect(counts.analysedCount).toBe(3);
        expect(counts.relevantCount).toBe(3);
    });

    it('still excludes a row below the render gate, breaking or not', () => {
        const counts = computeFeedCounts(
            [row('brk', { relevance: 0.2, rawScore: 0.85, eventType: 'disaster' })],
            { nowMs: NOW, openedArticleIds: new Set(['brk']) },
        );
        expect(counts).toEqual({ analysedCount: 1, relevantCount: 0, readCount: 0 });
    });
});

describe('useFeedCounts — every instance agrees', () => {
    // The header sentence and the status panel are two instances of this hook
    // mounted at different moments. Each used to take its own Date.now() for
    // the 48h edge, so a row crossing that edge between the two mounts was
    // counted by one surface and not the other.
    const { renderHook } = require('@testing-library/react-native');
    const selectors = require('@/lib/stores/selectors');
    const opened = require('@/lib/stores/opened-stories-store');
    const { useFeedCounts, resetFeedCountsMemoForTest } = require('@/lib/hooks/use-feed-counts');

    const T0 = Date.parse('2026-08-03T12:00:10.000Z');
    const WINDOW = 48 * HOUR;
    // Published so that it is inside the window at 12:00:10 and outside it
    // at 12:00:50: its 48h edge falls between the two mounts.
    const edgeRow = row('edge', {
        firstPubDate: new Date(T0 + 30_000 - WINDOW).toISOString(),
    });
    const suggestions = [row('a', { firstPubDate: new Date(T0 - HOUR).toISOString() }), edgeRow];
    const openedIds = new Set<string>();

    beforeEach(() => {
        jest.useFakeTimers();
        resetFeedCountsMemoForTest?.();
        selectors.useForYouSuggestions.mockReturnValue(suggestions);
        selectors.useForYouCounts.mockReturnValue({ articleCount: 900 });
        opened.useOpenedStoriesStore.mockImplementation((sel: any) => sel({ articleIds: openedIds }));
    });
    afterEach(() => jest.useRealTimers());

    it('returns the same counts to two instances mounted 40 seconds apart in one minute', () => {
        jest.setSystemTime(T0);
        const header = renderHook(() => useFeedCounts());
        jest.setSystemTime(T0 + 40_000);
        const panel = renderHook(() => useFeedCounts());
        expect(panel.result.current.analysedCount).toBe(header.result.current.analysedCount);
        expect(panel.result.current.relevantCount).toBe(header.result.current.relevantCount);
    });
});
