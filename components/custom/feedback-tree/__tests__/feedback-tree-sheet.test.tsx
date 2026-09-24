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
// ArticleOverflowMenu titles the sheet with the card's own title component,
// which reaches the native translator; stubbed like every card suite does.
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: (p: any) => <Text>{p.text}</Text> };
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
import type { FeedbackTree, FeedbackTreeNode, LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import { ActionSheetRow, SHEET_ROW_LABEL_CLASS } from '@/components/custom/cards/ArticleOverflowMenu';
import FeedbackTreeLevel from '../FeedbackTreeLevel';
import { leafNeedsConfirm, performFeedbackLeaf } from '../perform-feedback-leaf';
import { feedbackNodeLabel } from '../label-vars';
import type { TFunction } from 'i18next';

/** The same interpolating `t` the react-i18next mock hands the level. Cast:
 *  i18next's `TFunction` is typed against the app's own key union. */
const tStub = ((key: string, opts?: Record<string, unknown>) => {
    const base = (opts && (opts.defaultValue as string)) || key;
    if (!opts) return base;
    return base.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(opts[name] ?? ''));
}) as unknown as TFunction;

type Level = { pathIds: string[] };

/** The host's stack, reduced to the tree: a push per branch, the leaf run
 *  through performFeedbackLeaf with a synchronous close. */
function Harness(props: {
    context: LocalFeedbackContext;
    onLeafPicked: jest.Mock;
    onClose: jest.Mock;
    root?: 'like' | 'dislike';
    tree?: FeedbackTree;
}) {
    const root = props.root ?? 'dislike';
    const [stack, setStack] = useState<Level[]>([{ pathIds: [] }]);
    const [confirm, setConfirm] = useState<{ node: FeedbackTreeNode; pathIds: string[] } | null>(null);
    const top = stack[stack.length - 1];
    const context = { articleTitle: 'A story', ...props.context };
    const perform = (node: FeedbackTreeNode, pathIds: string[]) =>
        performFeedbackLeaf(node, pathIds, {
            context,
            chatContext: { kind: 'article-suggestion', articleId: 'a1', articleTitle: 'A story' } as any,
            chatMessage: 'hi',
            label: feedbackNodeLabel(tStub, node, context),
            spend: { articleId: 'a1', sentiment: root },
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
            tree={props.tree ?? require('@/lib/services/feedback-tree-snapshot').BUNDLED_FEEDBACK_TREE}
            root={root}
            pathIds={top.pathIds}
            context={context}
            onDescend={(n) => setStack((s) => [...s, { pathIds: [...top.pathIds, n.id] }])}
            onLeaf={(node, pathIds) => (leafNeedsConfirm(node) ? setConfirm({ node, pathIds }) : perform(node, pathIds))}
        />
    );
}

function setup(context: LocalFeedbackContext, root: 'like' | 'dislike' = 'dislike') {
    const onLeafPicked = jest.fn();
    const onClose = jest.fn();
    const utils = render(<Harness context={context} onLeafPicked={onLeafPicked} onClose={onClose} root={root} />);
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
        expect(u.getByText('Not a good suggestion')).toBeTruthy();
        expect(u.getByText('Issue with this publication')).toBeTruthy();
    });

    it('applies that fast path in one tap, and commits', async () => {
        const { getByText, onLeafPicked, onClose } = setup(TAGGED);
        fireEvent.press(await waitFor(() => getByText('Not that important')));
        await waitFor(() => expect(onLeafPicked).toHaveBeenCalledWith(['not_important'], 1, true));
        expect(onClose).toHaveBeenCalled();
    });

    it('names the article`s tags in its labels, no raw placeholders', async () => {
        const u = setup(TAGGED);
        fireEvent.press(await waitFor(() => u.getByText('Not a good suggestion')));
        expect(await waitFor(() => u.getByText('Show less of election'))).toBeTruthy();
        expect(u.getByText('Show less of Reserve Bank of India')).toBeTruthy();
        expect(u.getByText('Show less of Mumbai')).toBeTruthy();
        expect(u.queryByText(/\{\{/)).toBeNull();
    });

    it('opens the publication-preferences screen for the manage_publication nudge', async () => {
        const u = setup(TAGGED);
        fireEvent.press(await waitFor(() => u.getByText('Issue with this publication')));
        fireEvent.press(await waitFor(() => u.getByText('Manage publications')));
        expect(router.push).toHaveBeenCalledWith('/logged-in/publication-preferences');
        expect(mockApplyLeafActions).not.toHaveBeenCalled();
        expect(u.onLeafPicked).toHaveBeenCalledWith(['publication_issue', 'manage_publication'], 0, true);
        expect(u.onClose).toHaveBeenCalled();
    });

    it('hides the tag leaves on an untagged article', async () => {
        const u = setup({ matchedTopics: [{ topicId: 't1', text: 'cricket' }] });
        fireEvent.press(await waitFor(() => u.getByText('Not a good suggestion')));
        await waitFor(() => expect(u.getByText("I'm seeing too much of this")).toBeTruthy());
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
        spend: { articleId: 'a1', sentiment: 'dislike' as const },
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
        // The verdict row is spent: stamped processed and its change-log ids
        // kept, so un-voting or flipping reverts exactly this change.
        expect(mockApplyLeafActions).toHaveBeenCalledWith(expect.any(Array), expect.any(String), {
            articleId: 'a1',
            sentiment: 'dislike',
        });
    });

    // Batch 16: the persona write used to start only after the sheet had
    // fully dismissed, so "Got it" arrived seconds late. It starts at the tap.
    it('starts the persona write at the tap, not after the sheet has gone', () => {
        const picked = jest.fn();
        const pending: Array<() => void> = [];
        performFeedbackLeaf(
            {
                id: 'ni',
                labelKey: 'k',
                leaf: { actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.15 }] },
            } as any,
            ['ni'],
            { ...deps(picked), closeThen: (after?: () => void) => after && pending.push(after) },
        );
        expect(mockApplyLeafActions).toHaveBeenCalledTimes(1);
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

// Ported from the retired inline panel's suites (InlineFeedbackTree.*): the
// same shipped tree, now driven through the sheet's level + leaf path.
describe('the shipped tree through the sheet (ported from the inline panel)', () => {
    const applied = () =>
        mockApplyLeafActions.mock.calls[0] as unknown as [Record<string, unknown>[], string, { articleId: string; sentiment: string }];

    it('runs the LIKE tree: "More from this publication" boosts it and spends the like', async () => {
        const u = setup(TAGGED, 'like');
        fireEvent.press(await waitFor(() => u.getByText('More from this publication')));
        await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
        const [actions, , spend] = applied();
        expect(actions).toEqual([expect.objectContaining({ publicationId: 'The Hindu', publicationPref: 'boost' })]);
        expect(spend).toEqual({ articleId: 'a1', sentiment: 'like' });
    });

    // A complaint about VOLUME, not relevance: lower the topic's weight, never
    // mint a suppression that would filter out a subject the user still wants.
    it('the frequency leaf lowers the matched topic weight, mints no filter, and needs no confirm', async () => {
        const u = setup(TAGGED);
        fireEvent.press(await waitFor(() => u.getByText('Not a good suggestion')));
        fireEvent.press(await waitFor(() => u.getByText("I'm seeing too much of this")));
        await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
        const [actions, summary] = applied();
        expect(actions).toEqual([{ action_type: 'set_topic_weight', topicId: 't1', delta: -0.3 }]);
        expect(actions.some((a) => a.action_type === 'add_suppression')).toBe(false);
        expect(summary).toBe("I'm seeing too much of this");
    });

    it('"I\'ve seen this already" applies nothing and commits nothing', async () => {
        const u = setup(TAGGED);
        fireEvent.press(await waitFor(() => u.getByText('Not a good suggestion')));
        fireEvent.press(await waitFor(() => u.getByText("I've seen this already")));
        await act(async () => {
            await Promise.resolve();
        });
        expect(mockApplyLeafActions).not.toHaveBeenCalled();
        expect(u.onLeafPicked).toHaveBeenCalledWith(expect.any(Array), 0, false);
    });

    it('the entity leaf mints the structured filter its label promised', async () => {
        const u = setup(TAGGED);
        fireEvent.press(await waitFor(() => u.getByText('Not a good suggestion')));
        fireEvent.press(await waitFor(() => u.getByText('Show less of Reserve Bank of India')));
        await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
        const [actions, label] = applied();
        expect(actions).toEqual([
            {
                action_type: 'add_suppression',
                suppressionPattern: 'Reserve Bank of India',
                suppressionStrength: 0.5,
                suppressionKind: 'entity',
                suppressionValue: 'Reserve Bank of India',
            },
        ]);
        expect(label).toBe('Show less of Reserve Bank of India');
    });

    it('the place filter carries the verbatim tag, not the display prose', async () => {
        const u = setup({ ...TAGGED, geoText: 'Middle East', placeValue: 'MIDDLE_EAST' });
        fireEvent.press(await waitFor(() => u.getByText('Not a good suggestion')));
        fireEvent.press(await waitFor(() => u.getByText('Show less of Middle East')));
        await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
        expect(applied()[0][0]).toMatchObject({ suppressionKind: 'place', suppressionValue: 'MIDDLE_EAST' });
    });

    describe('the paywall branch', () => {
        const PAYWALL_CTX: LocalFeedbackContext = { ...TAGGED, publicationVisits: 7 };
        const openPaywall = async (u: ReturnType<typeof setup>) => {
            fireEvent.press(await waitFor(() => u.getByText('Issue with this publication')));
            fireEvent.press(await waitFor(() => u.getByText("It's paywalled")));
        };

        it('is reachable, and each option shows its own message with publication and visits filled in', async () => {
            const u = setup(PAYWALL_CTX);
            await openPaywall(u);
            expect(await waitFor(() => u.getByText('Show related coverage'))).toBeTruthy();
            expect(u.getByText('Block The Hindu instead')).toBeTruthy();
            expect(u.getByText(/visited The Hindu 7 times/)).toBeTruthy();
            expect(u.queryByText(/\{\{/)).toBeNull();
        });

        it('"Show related coverage" commits the path and mutates nothing', async () => {
            const u = setup(PAYWALL_CTX);
            await openPaywall(u);
            fireEvent.press(await waitFor(() => u.getByText('Show related coverage')));
            expect(u.onLeafPicked).toHaveBeenCalledWith(['publication_issue', 'paywall', 'paywall_related'], 0, true);
            expect(mockApplyLeafActions).not.toHaveBeenCalled();
        });

        it('blocking the publication asks first, and mutes only once confirmed', async () => {
            const u = setup(PAYWALL_CTX);
            await openPaywall(u);
            fireEvent.press(await waitFor(() => u.getByText('Block The Hindu instead')));
            expect(mockApplyLeafActions).not.toHaveBeenCalled();
            fireEvent.press(u.getByTestId('confirm-go'));
            await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
            expect(applied()[0]).toEqual([expect.objectContaining({ publicationId: 'The Hindu', publicationPref: 'mute' })]);
        });
    });

    describe('"More about this topic" names the matched topic', () => {
        it('names a single real topic', async () => {
            const u = setup({ matchedTopics: [{ topicId: 't1', text: 'Formula 1' }] }, 'like');
            expect(await waitFor(() => u.getByText('More about: Formula 1'))).toBeTruthy();
            expect(u.queryByText('More about this topic')).toBeNull();
        });

        it('picks the first real topic and counts the rest', async () => {
            const u = setup(
                {
                    matchedTopics: [
                        { topicId: null, text: 'Synthetic headline' },
                        { topicId: 't1', text: 'Formula 1' },
                        { topicId: 't2', text: 'Motorsport' },
                    ],
                },
                'like',
            );
            expect(await waitFor(() => u.getByText('More about: Formula 1 and 1 more'))).toBeTruthy();
        });

        // The shipped node is gated on real matched topics, so this is the
        // defensive path for a server tree without that gate.
        it('falls back to the generic label with no real topic, never an empty "More about: "', () => {
            const node = { id: 'more_about_topic', labelKey: 'k', labelDefault: 'More about this topic' } as FeedbackTreeNode;
            const ctx = { matchedTopics: [{ topicId: null, text: 'Synthetic headline' }] } as LocalFeedbackContext;
            expect(feedbackNodeLabel(tStub, node, ctx)).toBe('More about this topic');
        });
    });
});


// Owner: "move all those options [under Tell me more] to the previous menu".
// The dislike root lists the tree's own options directly, the one-tap "Not
// that important" first, and that row is not repeated inside its branch.
describe('the dislike root is flat (no "Tell me more")', () => {
    it('shows the one-tap row first, then the tree root options, with the caption', () => {
        const u = setup(TAGGED);
        expect(u.queryByTestId('tree-tell-more')).toBeNull();
        expect(u.queryByText('Tell me more')).toBeNull();
        const ids = u.UNSAFE_root
            .findAll((n: any) => typeof n.props?.testID === 'string' && n.props.testID.startsWith('tree-row-') && typeof n.type !== 'string')
            .map((n: any) => n.props.testID)
            .filter((id: string, i: number, all: string[]) => all.indexOf(id) === i);
        expect(ids).toEqual(['tree-row-not_important', 'tree-row-publication_issue', 'tree-row-suggestion']);
        expect(u.getByTestId('feedback-caption')).toBeTruthy();
    });

    it('does not repeat "Not that important" inside "Not a good suggestion"', () => {
        const u = setup(TAGGED);
        fireEvent.press(u.getByText('Not a good suggestion'));
        expect(u.getByText("I'm seeing too much of this")).toBeTruthy();
        expect(u.queryByText('Not that important')).toBeNull();
    });
});

describe('the flat dislike root on prod v4', () => {
    const { FEEDBACK_TREE_V4 } = require('./fixtures/feedback-tree-v4');
    it('shows "Not that important" first, then the four v4 branches, and no "Tell me more"', () => {
        const u = render(
            <Harness context={TAGGED} onLeafPicked={jest.fn()} onClose={jest.fn()} tree={FEEDBACK_TREE_V4} />,
        );
        expect(u.queryByText('Tell me more')).toBeNull();
        for (const label of [
            'Not that important',
            'Problem with the site',
            "Don't like this publication",
            'Not a good suggestion',
            'Not important to me',
        ]) {
            expect(u.getByText(label)).toBeTruthy();
        }
        fireEvent.press(u.getByText('Not a good suggestion'));
        expect(u.queryByText('Not that important')).toBeNull();
    });
});

