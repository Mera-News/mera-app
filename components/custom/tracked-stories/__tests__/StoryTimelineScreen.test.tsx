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
let mockTimelineContentStyle: any = null;
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
                return ({ data, renderItem, keyExtractor, ListEmptyComponent, contentContainerStyle }: any) => {
                    mockTimelineContentStyle = contentContainerStyle;
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
const mockRemoveMemberSnapshot = jest.fn(async (): Promise<boolean> => true);
const mockDeleteTracked = jest.fn(async (): Promise<boolean> => true);
const mockGetTracked = jest.fn(async (): Promise<any> => mockStory);
const mockShowError = jest.fn();
jest.mock('@/lib/toast-manager', () => ({
    toastManager: { showError: (...a: any[]) => mockShowError(...a) },
}));
const mockAdvanceSeenWatermark = jest.fn(async () => {});
const mockMarkSeen = jest.fn(async () => {});
jest.mock('@/lib/database/services/tracked-story-service', () => ({
    getTrackedStoryById: (...a: any[]) => mockGetTracked(...(a as [])),
    markSeen: (...a: any[]) => mockMarkSeen(...(a as [])),
    advanceSeenWatermark: (...a: any[]) => mockAdvanceSeenWatermark(...(a as [])),
    backfillSnapshotSource: jest.fn(async () => {}),
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    getGroupingRowsByIds: jest.fn(async () => []),
}));
jest.mock('@/lib/article-service', () => ({
    ArticleService: { getArticleById: jest.fn(async () => null) },
}));
jest.mock('@/lib/tracking/track-actions', () => ({
    // The services report success as a boolean and never throw.
    deleteTrackedStoryById: (...a: any[]) => mockDeleteTracked(...(a as [])),
    // Disowning a member now drops the snapshot AND releases the article's
    // on-device retention, so the screen calls this instead of reaching into
    // tracked-story-service directly.
    disownStoryMember: (...a: any[]) => mockRemoveMemberSnapshot(...(a as [])),
}));
jest.mock('@/lib/hooks/use-open-article', () => ({ useOpenArticle: () => jest.fn() }));

// The export reads each member's retention row for its link and note. Mocked
// for the import-time reason above as much as for the data: the real service
// reaches lib/database at import.
const mockGetSaved = jest.fn(async (_id: string): Promise<any> => null);
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
    getSavedSuggestionByServerId: (id: string) => mockGetSaved(id),
}));
const mockExportAndShare = jest.fn();
jest.mock('@/components/custom/saved-suggestions/export-and-share', () => ({
    exportAndShare: (...a: unknown[]) => mockExportAndShare(...a),
}));

// The real row pulls the whole compact-card tree (images, blur store, adaptive
// clamp). The seam under test is the screen's wiring, so the row is reduced to
// the three props it forwards.
jest.mock('@/components/custom/cards/ArticleStandaloneCompactCard', () => {
    const { Pressable, Text } = require('react-native');
    return {
        ArticleStandaloneCompactCard: ({ article, onPress, onLongPress, menuExtraItems, testID }: any) => (
            <Pressable testID={testID} onPress={onPress} onLongPress={onLongPress}>
                {/* As the real card: English first, then the original. */}
                <Text>{article.title_en_internal_only ?? article.title}</Text>
                {(menuExtraItems ?? []).map((i: any) => (
                    <Pressable key={i.key} testID={`${testID}-${i.testID}`} onPress={i.run}>
                        <Text>{i.label}</Text>
                    </Pressable>
                ))}
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
    mockRemoveMemberSnapshot.mockImplementation(async () => true);
    mockDeleteTracked.mockImplementation(async () => true);
    mockGetTracked.mockImplementation(async () => mockStory);
    mockExportAndShare.mockResolvedValue({ status: 'shared', via: 'file' });
    mockGetSaved.mockImplementation(async (id: string) =>
        id === 'a1'
            ? { article_url: 'https://example.com/a1', reason: 'You follow Bhopal.', title_en: null }
            : null,
    );
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

describe('StoryTimelineScreen layout', () => {
    it('keeps the cards off the screen edges (F35)', async () => {
        await renderScreen();
        expect(mockTimelineContentStyle.paddingHorizontal).toBe(16);
    });
});

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

    it('the ••• menu offers the same removal, through the same confirm', async () => {
        const { getByTestId, queryByText } = await renderScreen();

        await act(async () => {
            fireEvent.press(getByTestId('story-timeline-card-a2-menu-remove-from-story'));
        });

        expect(queryByText('trackedStories.removeMemberConfirmTitle')).toBeTruthy();
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

describe('StoryTimelineScreen: failures say so', () => {
    it('shows a load error, not the quiet note, when loading throws', async () => {
        mockGetTracked.mockImplementation(async () => {
            throw new Error('SQLITE_BUSY');
        });
        const { getByTestId, getByText, queryByText } = render(
            <StoryTimelineScreen trackedStoryId="s1" onBack={jest.fn()} />,
        );
        await waitFor(() => expect(getByTestId('story-timeline-load-failed')).toBeTruthy());
        expect(getByText('trackedStories.timelineLoadFailed')).toBeTruthy();
        expect(queryByText('trackedStories.timelineQuietNote')).toBeNull();
    });

    it('says the story is gone when it was deleted elsewhere', async () => {
        mockStory = null;
        const { getByTestId } = render(<StoryTimelineScreen trackedStoryId="s1" onBack={jest.fn()} />);
        await waitFor(() => expect(getByTestId('story-timeline-gone')).toBeTruthy());
    });

    it('stays and says so when deleting the story fails', async () => {
        mockDeleteTracked.mockImplementation(async () => false);
        const onBack = jest.fn();
        const utils = render(<StoryTimelineScreen trackedStoryId="s1" onBack={onBack} />);
        await waitFor(() => utils.getByText('Water enters low-lying colonies'));

        await act(async () => {
            fireEvent.press(utils.getByTestId('story-timeline-delete'));
        });
        await act(async () => {
            fireEvent.press(utils.getByTestId('story-timeline-delete-confirm'));
        });

        expect(mockDeleteTracked).toHaveBeenCalledWith('s1');
        expect(onBack).not.toHaveBeenCalled();
        expect(mockShowError).toHaveBeenCalledWith('errors.somethingWentWrong', 'trackedStories.deleteFailed');
    });

    it('puts a removed card back and says so when removal fails', async () => {
        mockRemoveMemberSnapshot.mockImplementation(async () => false);
        const { getByTestId, queryByText } = await renderScreen();

        await act(async () => {
            fireEvent(getByTestId('story-timeline-card-a2'), 'longPress');
        });
        await act(async () => {
            fireEvent.press(getByTestId('story-timeline-card-remove'));
        });

        await waitFor(() => expect(queryByText('Unrelated Meghalaya landslide')).toBeTruthy());
        expect(mockShowError).toHaveBeenCalledWith('errors.somethingWentWrong', 'trackedStories.removeFailed');
    });
});

describe('StoryTimelineScreen: exporting the story', () => {
    const checked = (utils: any, id: string) =>
        utils.getByTestId(`story-export-row-${id}`).props.accessibilityState.checked;

    it('opens the export wizard with every article already ticked', async () => {
        const utils = await renderScreen();
        expect(utils.queryByTestId('story-export-modal')).toBeNull();

        await act(async () => {
            fireEvent.press(utils.getByTestId('story-timeline-share'));
        });

        expect(utils.getByTestId('story-export-modal')).toBeTruthy();
        expect(['a1', 'a2', 'a3'].map((id) => checked(utils, id))).toEqual([true, true, true]);
        // Nothing is read or shared until the reader picks a format.
        expect(mockGetSaved).not.toHaveBeenCalled();
        expect(mockExportAndShare).not.toHaveBeenCalled();
    });

    it('exports only what stays ticked, with links and notes from retention', async () => {
        const utils = await renderScreen();
        await act(async () => {
            fireEvent.press(utils.getByTestId('story-timeline-share'));
        });

        // Untick one. If the wizard re-ran its all-ticked reset on a later
        // render, this would silently come back and be exported.
        await act(async () => {
            fireEvent.press(utils.getByTestId('story-export-row-a2'));
        });
        expect(checked(utils, 'a2')).toBe(false);

        await act(async () => {
            fireEvent.press(utils.getByTestId('story-export-next'));
        });
        await act(async () => {
            fireEvent.press(utils.getByTestId('story-export-next'));
        });
        await act(async () => {
            fireEvent.press(utils.getByTestId('story-export-format-markdown'));
        });

        await waitFor(() => expect(mockExportAndShare).toHaveBeenCalledTimes(1));
        const [call] = mockExportAndShare.mock.calls[0] as any[];
        expect(call.format).toBe('markdown');
        expect(call.fileBaseName).toBe('mera-story');
        expect(call.dialogTitle).toBe('storyExport.shareDialogTitle');
        expect(call.content.startsWith('# Bhopal flooding\n\n_aiDisclosure.short_\n')).toBe(true);
        expect(call.content).toContain('## Water enters low-lying colonies');
        expect(call.content).toContain('## Rescue teams deployed');
        expect(call.content).not.toContain('Unrelated Meghalaya landslide');
        expect(call.content).toContain('https://example.com/a1');
        expect(call.content).toContain('> savedExport.docReasonLabel: You follow Bhopal.');
        // Retention is read for the chosen members only.
        expect(mockGetSaved.mock.calls.map((c) => c[0]).sort()).toEqual(['a1', 'a3']);
    });

    it('says so when the export could not be handed off', async () => {
        mockExportAndShare.mockResolvedValue({ status: 'failed', error: new Error('nope') });
        const utils = await renderScreen();
        await act(async () => {
            fireEvent.press(utils.getByTestId('story-timeline-share'));
        });
        await act(async () => {
            fireEvent.press(utils.getByTestId('story-export-next'));
        });
        await act(async () => {
            fireEvent.press(utils.getByTestId('story-export-next'));
        });
        await act(async () => {
            fireEvent.press(utils.getByTestId('story-export-format-json'));
        });

        await waitFor(() =>
            expect(mockShowError).toHaveBeenCalledWith(
                'savedExport.failedTitle',
                'savedExport.failedMessage',
            ),
        );
    });

    it('offers no share button when the story has nothing to export', async () => {
        mockStory = { ...mockStory, memberSnapshots: [] };
        const utils = render(<StoryTimelineScreen trackedStoryId="s1" onBack={jest.fn()} />);
        await waitFor(() => utils.getByText('trackedStories.timelineQuietNote'));
        // The positive case above proves the query can find the button at all.
        expect(utils.queryByTestId('story-timeline-share')).toBeNull();
    });
});
