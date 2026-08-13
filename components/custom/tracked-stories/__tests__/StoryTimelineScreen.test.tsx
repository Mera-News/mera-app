/* eslint-disable @typescript-eslint/no-require-imports */
// StoryTimelineScreen — the "not part of this story" per-card removal.
//
// The load path (hydrateSource, title backfill, watermark) is covered by
// merge-timeline.test.ts and the service suite; what is pinned HERE is the
// removal wiring, and above all WHICH of the two member collections it touches.
// Getting that backwards is invisible in the UI and only shows up one feed sync
// later, when the card the user removed reappears.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));
jest.mock('@/components/custom/AiDisclosureCaption', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
}));

// jest-expo mis-transforms RN's ScrollView; FlatList's VirtualizedList tree is
// brittle under the test renderer. Same proxy the sibling suite uses.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return ({ children, ...rest }: any) =>
                    ReactLib.createElement(actual.View, rest, children);
            }
            if (prop === 'FlatList') {
                return ({ data, renderItem, keyExtractor, ListEmptyComponent }: any) => {
                    const resolve = (C: any) =>
                        ReactLib.isValidElement(C)
                            ? C
                            : typeof C === 'function'
                              ? ReactLib.createElement(C)
                              : null;
                    if (!data || data.length === 0) {
                        return ReactLib.createElement(
                            actual.View,
                            null,
                            resolve(ListEmptyComponent),
                        );
                    }
                    return ReactLib.createElement(
                        actual.View,
                        null,
                        data.map((item: any, index: number) =>
                            ReactLib.createElement(
                                actual.View,
                                { key: keyExtractor ? keyExtractor(item, index) : index },
                                renderItem({ item, index }),
                            ),
                        ),
                    );
                };
            }
            return (target as any)[prop];
        },
    });
});

// useFocusEffect fires once on mount here — the screen loads and marks seen from
// it, so without this the list never populates.
jest.mock('expo-router', () => {
    const ReactLib = require('react');
    return {
        useFocusEffect: (cb: () => void | (() => void)) => ReactLib.useEffect(cb, [cb]),
    };
});

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), captureException: jest.fn() },
}));

// lib/database/index.ts builds a real native SQLiteAdapter at import time.
jest.mock('@/lib/database', () => ({
    __esModule: true,
    default: { write: jest.fn((fn: () => Promise<void>) => fn()) },
}));

let mockStory: any = null;
const mockRemoveMemberSnapshot = jest.fn(async () => {});
const mockAdvanceSeenWatermark = jest.fn(async () => {});
const mockMarkSeen = jest.fn(async () => {});
jest.mock('@/lib/database/services/tracked-story-service', () => ({
    getTrackedStoryById: jest.fn(async () => mockStory),
    markSeen: (...a: any[]) => mockMarkSeen(...(a as [])),
    advanceSeenWatermark: (...a: any[]) => mockAdvanceSeenWatermark(...(a as [])),
    backfillSnapshotSource: jest.fn(async () => {}),
    removeMemberSnapshot: (...a: any[]) => mockRemoveMemberSnapshot(...(a as [])),
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    getGroupingRowsByIds: jest.fn(async () => []),
}));
jest.mock('@/lib/article-service', () => ({
    ArticleService: { getArticleById: jest.fn(async () => null) },
}));
jest.mock('@/lib/tracking/track-actions', () => ({
    deleteTrackedStoryById: jest.fn(async () => {}),
}));
jest.mock('@/lib/hooks/use-open-article', () => ({ useOpenArticle: () => jest.fn() }));

// The real row pulls the whole compact-card tree (images, blur store, adaptive
// clamp). The seam under test is the screen's wiring, so the row is reduced to
// the three props it forwards.
jest.mock('@/components/custom/cards/ArticleStandaloneCompactCard', () => {
    const { Pressable, Text } = require('react-native');
    return {
        ArticleStandaloneCompactCard: ({ article, onPress, onLongPress, testID }: any) => (
            <Pressable testID={testID} onPress={onPress} onLongPress={onLongPress}>
                <Text>{article.title}</Text>
            </Pressable>
        ),
    };
});

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/heading', () => { const { Text } = require('react-native'); return { Heading: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    return {
        Modal: ({ isOpen, children }: any) => (isOpen ? <View>{children}</View> : null),
        ModalBackdrop: (p: any) => <View {...p} />,
        ModalBody: (p: any) => <View {...p} />,
        ModalContent: (p: any) => <View {...p} />,
        ModalFooter: (p: any) => <View {...p} />,
        ModalHeader: (p: any) => <View {...p} />,
    };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> };
});

import StoryTimelineScreen from '../StoryTimelineScreen';

const snapshot = (articleId: string, title: string, pubDateMs: number) => ({
    articleId,
    title,
    pubDateMs,
    languageCode: 'en',
    countryCode: 'IND',
});

beforeEach(() => {
    jest.clearAllMocks();
    mockStory = {
        id: 's1',
        llmHeadline: 'Bhopal flooding',
        fallbackTitle: 'Bhopal flooding',
        stableClusterId: null,
        memberArticleIds: ['a1', 'a2', 'a3'],
        memberSnapshots: [
            snapshot('a1', 'Water enters low-lying colonies', 3),
            snapshot('a2', 'Unrelated Meghalaya landslide', 2),
            snapshot('a3', 'Rescue teams deployed', 1),
        ],
    };
});

const renderScreen = async () => {
    const utils = render(<StoryTimelineScreen trackedStoryId="s1" onBack={jest.fn()} />);
    await waitFor(() => utils.getByText('Water enters low-lying colonies'));
    return utils;
};

describe('StoryTimelineScreen — removing one member', () => {
    it('long-pressing a card asks before removing anything', async () => {
        const { getByTestId, queryByText } = await renderScreen();

        expect(queryByText('trackedStories.removeMemberConfirmTitle')).toBeNull();

        await act(async () => {
            fireEvent(getByTestId('story-timeline-card-a2'), 'longPress');
        });

        expect(getByTestId('story-timeline-card-remove')).toBeTruthy();
        expect(queryByText('trackedStories.removeMemberConfirmTitle')).toBeTruthy();
        // Asking is not doing.
        expect(mockRemoveMemberSnapshot).not.toHaveBeenCalled();
    });

    it('confirming drops the SNAPSHOT for that one article and nothing else', async () => {
        const { getByTestId, queryByText } = await renderScreen();

        await act(async () => {
            fireEvent(getByTestId('story-timeline-card-a2'), 'longPress');
        });
        await act(async () => {
            fireEvent.press(getByTestId('story-timeline-card-remove'));
        });

        // The service seam takes (storyId, articleId) and is snapshot-scoped by
        // NAME. If this ever becomes a "removeMember" that also drops the id,
        // the next reconcile re-adds the article — see the handler's comment.
        expect(mockRemoveMemberSnapshot).toHaveBeenCalledTimes(1);
        expect(mockRemoveMemberSnapshot).toHaveBeenCalledWith('s1', 'a2');

        // The card leaves immediately; its siblings stay.
        await waitFor(() => expect(queryByText('Unrelated Meghalaya landslide')).toBeNull());
        expect(queryByText('Water enters low-lying colonies')).toBeTruthy();
        expect(queryByText('Rescue teams deployed')).toBeTruthy();
    });

    it('cancelling writes nothing and keeps the card', async () => {
        const { getByTestId, getByText, queryByText } = await renderScreen();

        await act(async () => {
            fireEvent(getByTestId('story-timeline-card-a2'), 'longPress');
        });
        await act(async () => {
            fireEvent.press(getByText('common.cancel'));
        });

        expect(mockRemoveMemberSnapshot).not.toHaveBeenCalled();
        expect(queryByText('Unrelated Meghalaya landslide')).toBeTruthy();
        expect(queryByText('trackedStories.removeMemberConfirmTitle')).toBeNull();
    });

    it('does not walk the seen watermark back when the newest card is removed', async () => {
        // The watermark is monotonic in the service, and the screen must not try
        // to compensate for a removal by re-stamping a lower max pubDate: that
        // would re-inflate the "N new" badge for coverage already read.
        const { getByTestId } = await renderScreen();
        const stampsAfterLoad = mockAdvanceSeenWatermark.mock.calls.length;

        await act(async () => {
            fireEvent(getByTestId('story-timeline-card-a1'), 'longPress'); // newest
        });
        await act(async () => {
            fireEvent.press(getByTestId('story-timeline-card-remove'));
        });

        expect(mockAdvanceSeenWatermark.mock.calls.length).toBe(stampsAfterLoad);
    });
});
