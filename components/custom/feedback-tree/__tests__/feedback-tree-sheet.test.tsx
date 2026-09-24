// The feedback tree as LEVELS of the shared ••• sheet (FeedbackTreeLevel +
// performFeedbackLeaf), ported from the retired FeedbackTreeOverlay suites:
// the explicit `committed` flag, the shipped v5 tree's fast path, the label
// bag, the manage_publication nudge, the tag leaves; and the row style being
// the ••• menu's own.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, opts?: Record<string, unknown>) => {
            const base = (opts && (opts.defaultValue as string)) || key;
            if (!opts) return base;
            return base.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(opts[name] ?? ''));
        },
    }),
}));
jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@/components/custom/GlassSurface', () => ({ GLASS_OVER_CONTENT_FILL: '#111', TranslucentPlate: () => null }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
const mockOpenArticleFeedback = jest.fn();
jest.mock('@/lib/stores/floating-chat-store', () => ({
    useFloatingChatStore: { getState: () => ({ openArticleFeedback: mockOpenArticleFeedback }) },
}));
jest.mock('@/lib/stores/subscription-store', () => ({ getAiAccess: () => 'unlocked' }));
const mockApplyLeafActions = jest.fn(async (..._a: any[]) => 1);
jest.mock('@/components/custom/feedback-tree/apply-leaf-actions', () => ({
    applyLeafActions: (...a: any[]) => mockApplyLeafActions(...a),
}));
jest.mock('@/lib/services/feedback-tree-service', () => ({
    getFeedbackTree: jest.fn(async () => require('@/lib/services/feedback-tree-snapshot').BUNDLED_FEEDBACK_TREE),
    refreshFeedbackTree: jest.fn(async () => {}),
}));

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import React, { useState } from 'react';
import type { FeedbackTreeNode, LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import { ActionSheetRow, SHEET_ROW_LABEL_CLASS } from '@/components/custom/cards/ArticleOverflowMenu';
import FeedbackTreeLevel from '../FeedbackTreeLevel';
import { leafNeedsConfirm, performFeedbackLeaf } from '../perform-feedback-leaf';

type Level = { pathIds: string[]; browsing: boolean };

/** The host's stack, reduced to the tree: a push per branch, the leaf run
 *  through performFeedbackLeaf with a synchronous close. */
function Harness(props: { context: LocalFeedbackContext; onLeafPicked: jest.Mock; onClose: jest.Mock }) {
    const [stack, setStack] = useState<Level[]>([{ pathIds: [], browsing: false }]);
    const [confirm, setConfirm] = useState<{ node: FeedbackTreeNode; pathIds: string[] } | null>(null);
    const top = stack[stack.length - 1];
    const context = { articleTitle: 'A story', ...props.context };
    const perform = (node: FeedbackTreeNode, pathIds: string[]) =>
        performFeedbackLeaf(node, pathIds, {
            context,
            chatContext: { kind: 'article-suggestion', articleId: 'a1', articleTitle: 'A story' } as any,
            chatMessage: 'hi',
            label: node.labelDefault ?? '',
            closeThen: (after) => {
                props.onClose();
                after?.();
            },
            onLeafPicked: props.onLeafPicked,
            showInfo: jest.fn(),
            chrome: (_k, d) => d,
        });
    if (confirm) {
        const { Pressable } = require('react-native');
        return <Pressable testID="confirm-go" onPress={() => perform(confirm.node, confirm.pathIds)} />;
    }
    return (
        <FeedbackTreeLevel
            tree={require('@/lib/services/feedback-tree-snapshot').BUNDLED_FEEDBACK_TREE}
            root="dislike"
            pathIds={top.pathIds}
            browsing={top.browsing}
            context={context}
            onBrowse={() => setStack((s) => [...s, { ...top, browsing: true }])}
            onDescend={(n) => setStack((s) => [...s, { browsing: true, pathIds: [...top.pathIds, n.id] }])}
            onLeaf={(node, pathIds) => (leafNeedsConfirm(node) ? setConfirm({ node, pathIds }) : perform(node, pathIds))}
        />
    );
}

function setup(context: LocalFeedbackContext) {
    const onLeafPicked = jest.fn();
    const onClose = jest.fn();
    const utils = render(<Harness context={context} onLeafPicked={onLeafPicked} onClose={onClose} />);
    return { ...utils, onLeafPicked, onClose };
}

const TAGGED: LocalFeedbackContext = {
    matchedTopics: [{ topicId: 't1', text: 'cricket' }],
    eventType: 'election',
    entity: 'Reserve Bank of India',
    geoText: 'Mumbai',
    placeValue: 'Mumbai',
    publicationName: 'The Hindu',
};

beforeEach(() => jest.clearAllMocks());

describe('the feedback tree as sheet levels (shipped v5 tree)', () => {
    // Batch 12: a level drew one row, then grew ~1.2s later as more rows
    // arrived. A level's rows are final on its FIRST render: no waiting.
    it('draws a level\'s final rows synchronously, on its first render', () => {
        const u = setup(TAGGED);
        expect(u.getByText('Not that important')).toBeTruthy();
        fireEvent.press(u.getByText('Tell me more'));
        expect(u.getByText('Not a good suggestion')).toBeTruthy();
        expect(u.getByText('Issue with this publication')).toBeTruthy();
    });

    it('opens on the `not_important` fast path and "Tell me more"', async () => {
        const { getByText } = setup(TAGGED);
        expect(await waitFor(() => getByText('Not that important'))).toBeTruthy();
        expect(getByText('Tell me more')).toBeTruthy();
    });

    it('applies that fast path in one tap, and commits', async () => {
        const { getByText, onLeafPicked, onClose } = setup(TAGGED);
        fireEvent.press(await waitFor(() => getByText('Not that important')));
        await waitFor(() => expect(onLeafPicked).toHaveBeenCalledWith(['not_important'], 1, true));
        expect(onClose).toHaveBeenCalled();
    });

    it('names the article`s tags in its labels, no raw placeholders', async () => {
        const u = setup(TAGGED);
        fireEvent.press(await waitFor(() => u.getByText('Tell me more')));
        fireEvent.press(await waitFor(() => u.getByText('Not a good suggestion')));
        expect(await waitFor(() => u.getByText('Show less of election'))).toBeTruthy();
        expect(u.getByText('Show less of Reserve Bank of India')).toBeTruthy();
        expect(u.getByText('Show less of Mumbai')).toBeTruthy();
        expect(u.queryByText(/\{\{/)).toBeNull();
    });

    it('opens the publication-preferences screen for the manage_publication nudge', async () => {
        const u = setup(TAGGED);
        fireEvent.press(await waitFor(() => u.getByText('Tell me more')));
        fireEvent.press(await waitFor(() => u.getByText('Issue with this publication')));
        fireEvent.press(await waitFor(() => u.getByText('Manage publications')));
        expect(router.push).toHaveBeenCalledWith('/logged-in/publication-preferences');
        expect(mockApplyLeafActions).not.toHaveBeenCalled();
        expect(u.onLeafPicked).toHaveBeenCalledWith(['publication_issue', 'manage_publication'], 0, true);
        expect(u.onClose).toHaveBeenCalled();
    });

    it('hides the tag leaves on an untagged article', async () => {
        const u = setup({ matchedTopics: [{ topicId: 't1', text: 'cricket' }] });
        fireEvent.press(await waitFor(() => u.getByText('Tell me more')));
        fireEvent.press(await waitFor(() => u.getByText('Not a good suggestion')));
        await waitFor(() => expect(u.getByText('Not that important')).toBeTruthy());
        expect(u.queryByText(/^Show less of/)).toBeNull();
    });
});

// `committed` is EXPLICIT: a seenOnly leaf changes nothing by design and must
// leave the thumb unfilled; a nudge applies nothing yet is a reason given.
describe('performFeedbackLeaf: the committed flag', () => {
    const deps = (onLeafPicked: jest.Mock) => ({
        context: { articleTitle: 'A story', matchedTopics: [{ topicId: 't1', text: 'cricket' }] } as LocalFeedbackContext,
        chatContext: { kind: 'article-suggestion', articleId: 'a1', articleTitle: 'A story' } as any,
        chatMessage: 'hi',
        label: 'x',
        closeThen: (after?: () => void) => after?.(),
        onLeafPicked,
        showInfo: jest.fn(),
        chrome: (_k: string, d: string) => d,
    });

    it('reports committed=false for a seenOnly leaf', () => {
        const picked = jest.fn();
        performFeedbackLeaf({ id: 'seen', labelKey: 'k', leaf: { seenOnly: true } } as any, ['seen'], deps(picked));
        expect(picked).toHaveBeenCalledWith(['seen'], 0, false);
    });

    it('reports committed=true with the applied count for a leaf that applies', async () => {
        mockApplyLeafActions.mockResolvedValueOnce(2);
        const picked = jest.fn();
        performFeedbackLeaf(
            {
                id: 'ni',
                labelKey: 'k',
                leaf: { actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.15 }] },
            } as any,
            ['ni'],
            deps(picked),
        );
        await act(async () => {
            await Promise.resolve();
        });
        expect(picked).toHaveBeenCalledWith(['ni'], 2, true);
    });

    it('a nudge applies nothing but STILL commits', () => {
        const picked = jest.fn();
        performFeedbackLeaf({ id: 'nb', labelKey: 'k', leaf: { nudge: 'browse_related' } } as any, ['nb'], deps(picked));
        expect(picked).toHaveBeenCalledWith(['nb'], 0, true);
    });
});

// Batch 11: the old tree's labels rendered at about a fifth of normal
// brightness. A tree row IS the ••• menu's row: same label class and style.
describe('tree rows use the ••• menu row style', () => {
    it('renders its rows with the exact label class and style of a main-menu row', async () => {
        const main = render(<ActionSheetRow testID="main" label="Save" icon="bookmark" onPress={jest.fn()} />);
        const mainLabel = main.getByText('Save');
        const u = setup(TAGGED);
        const treeLabel = await waitFor(() => u.getByText('Not that important'));
        expect(treeLabel.props.className).toBe(mainLabel.props.className);
        expect(treeLabel.props.className).toBe(SHEET_ROW_LABEL_CLASS);
        expect(treeLabel.props.style).toEqual(mainLabel.props.style);
        expect(String(treeLabel.props.className)).not.toContain('typography-0');
    });
});
