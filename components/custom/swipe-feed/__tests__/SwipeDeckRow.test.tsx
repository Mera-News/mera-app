// SwipeDeckRow — perf item A9. Verifies the per-item zustand selector reads
// only its own row's suggestion (renders nothing when absent, the card once
// present), that onOpenDetail is invoked with the ROW's id (not a per-item
// inline closure captured at parent-render time), and that a store update to
// a DIFFERENT row's entry does not touch this row's rendered output.
/* eslint-disable @typescript-eslint/no-require-imports */

// ── Mock the DB-service / pipeline seams swipe-feed-store imports, same
//    pattern as lib/stores/__tests__/for-you-store.test.ts — these touch the
//    native WatermelonDB singleton at import time, which jest can't init. ──
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    loadSuggestions: jest.fn(() => Promise.resolve([])),
    getSuggestionByServerId: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('@/lib/database/services/story-impression-service', () => ({
    getOpenedSeenSet: jest.fn(() => Promise.resolve(new Set())),
    recordImpression: jest.fn(() => Promise.resolve()),
    recordOpen: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/services/scoring-pipeline', () => ({
    registerChunkReleaseListener: jest.fn(() => () => {}),
}));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

// Stub SwipeCard itself — this test is about the row's store subscription and
// callback wiring, not SwipeCard's own rendering (covered separately, and
// explicitly out of scope for the A9 touch-ups).
jest.mock('@/components/custom/swipe-feed/SwipeCard', () => {
    const { Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ suggestion, onOpenDetail }: any) => (
            <Pressable onPress={onOpenDetail} testID="swipe-card">
                <Text>{suggestion.title_en}</Text>
            </Pressable>
        ),
    };
});

// eslint-disable-next-line import/first
import { fireEvent, render } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import React from 'react';
// eslint-disable-next-line import/first
import SwipeDeckRow from '../SwipeDeckRow';
// eslint-disable-next-line import/first
import { useSwipeFeedStore } from '@/lib/stores/swipe-feed-store';
// eslint-disable-next-line import/first
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

function makeSuggestion(overrides: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
    return {
        _id: 'row-1',
        articleId: 'art-1',
        clusters: [],
        relevance: 0.8,
        reason: '',
        status: 'COMPLETE' as any,
        country_code: 'US',
        language_code: 'en',
        publication_name: 'Test Pub',
        title_en: 'Row One Title',
        title_original: 'Row One Title',
        description_en: '',
        article_url: 'https://example.com',
        image_url: null,
        userTopicIds: [],
        createdAt: new Date().toISOString(),
        firstPubDate: new Date().toISOString(),
        rawScore: null,
        eventType: null,
        headlineScope: null,
        matchedTopics: [],
        ...overrides,
    };
}

describe('SwipeDeckRow', () => {
    afterEach(() => {
        useSwipeFeedStore.setState({ suggestionsById: new Map() });
    });

    it('renders nothing when its id has no entry in suggestionsById', () => {
        useSwipeFeedStore.setState({ suggestionsById: new Map() });
        const { queryByTestId } = render(
            <SwipeDeckRow id="missing" height={100} onOpenDetail={jest.fn()} />,
        );
        expect(queryByTestId('swipe-card')).toBeNull();
    });

    it('renders the card for its own suggestion, read via a per-item selector', () => {
        useSwipeFeedStore.setState({
            suggestionsById: new Map([['row-1', makeSuggestion()]]),
        });
        const { getByText } = render(
            <SwipeDeckRow id="row-1" height={100} onOpenDetail={jest.fn()} />,
        );
        expect(getByText('Row One Title')).toBeTruthy();
    });

    it('invokes onOpenDetail with its OWN id, not a stale per-render closure', () => {
        useSwipeFeedStore.setState({
            suggestionsById: new Map([['row-1', makeSuggestion()]]),
        });
        const onOpenDetail = jest.fn();
        const { getByTestId } = render(
            <SwipeDeckRow id="row-1" height={100} onOpenDetail={onOpenDetail} />,
        );
        fireEvent.press(getByTestId('swipe-card'));
        expect(onOpenDetail).toHaveBeenCalledTimes(1);
        expect(onOpenDetail).toHaveBeenCalledWith('row-1');
    });

    it('picks up its own suggestion changing in a wholesale Map replacement (release-listener shape)', () => {
        useSwipeFeedStore.setState({
            suggestionsById: new Map([['row-1', makeSuggestion({ title_en: 'Before' })]]),
        });
        const { getByText, rerender } = render(
            <SwipeDeckRow id="row-1" height={100} onOpenDetail={jest.fn()} />,
        );
        expect(getByText('Before')).toBeTruthy();

        // Simulate handleRelease's wholesale Map replacement: a NEW Map, but an
        // UNRELATED row ('row-2') is the one that actually changed — 'row-1's
        // entry is copied over by reference, unchanged.
        const prev = useSwipeFeedStore.getState().suggestionsById;
        const next = new Map(prev);
        next.set('row-2', makeSuggestion({ _id: 'row-2', title_en: 'Other row' }));
        useSwipeFeedStore.setState({ suggestionsById: next });

        rerender(<SwipeDeckRow id="row-1" height={100} onOpenDetail={jest.fn()} />);
        // row-1's own text is unchanged — its selector saw the same object
        // reference (Object.is) even though the Map itself is a new instance.
        expect(getByText('Before')).toBeTruthy();

        // Now change row-1's OWN entry — this row must pick it up.
        const next2 = new Map(useSwipeFeedStore.getState().suggestionsById);
        next2.set('row-1', makeSuggestion({ title_en: 'After' }));
        useSwipeFeedStore.setState({ suggestionsById: next2 });

        rerender(<SwipeDeckRow id="row-1" height={100} onOpenDetail={jest.fn()} />);
        expect(getByText('After')).toBeTruthy();
    });
});
