// One level of the feedback tree, rendered INSIDE the shared ••• sheet (it
// replaced FeedbackTreeOverlay, a second Modal with its own look). The host
// (useArticleMenu) owns the navigation stack: each branch the reader opens is a
// pushed sheet level, so "← Back" pops one level and, from the tree's root, returns
// to the ••• main menu. This component only draws a level's rows and reports
// taps; what a leaf DOES is `performFeedbackLeaf`.

import { ActionSheetRow } from '@/components/custom/cards/ArticleOverflowMenu';
import { feedbackLabelVars } from '@/components/custom/feedback-tree/label-vars';
import { resolveTreeLevel, type FeedbackTreeRoot } from '@/components/custom/feedback-tree/useFeedbackTreeEngine';
import { Text } from '@/components/ui/text';
import type { FeedbackTree, FeedbackTreeNode, LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import type { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface FeedbackTreeLevelProps {
    /** The loaded tree. The host resolves it (and the context) BEFORE pushing
     *  a level, so the level draws its final rows on its first render: rows
     *  arriving later made the sheet grow after it landed (batch 12). */
    tree: FeedbackTree;
    root: FeedbackTreeRoot;
    /** The branch ids opened so far (empty = the tree's root level). */
    pathIds: readonly string[];
    /** Dislike only: false = the entry level (the one-tap "Not that
     *  important" plus "Tell me more"); true = the tree itself. The like tree
     *  has no fast path and always browses. */
    browsing: boolean;
    context: LocalFeedbackContext;
    /** "Tell me more" on the dislike entry level. */
    onBrowse: () => void;
    /** A branch with visible children was tapped: push it. */
    onDescend: (node: FeedbackTreeNode) => void;
    /** A leaf was tapped (the host confirms a destructive one first). */
    onLeaf: (node: FeedbackTreeNode, pathIds: string[]) => void;
}

/** i18n chrome helper: always an English default, so it renders pre-merge. */
function useChrome() {
    const { t } = useTranslation();
    return useCallback(
        (key: string, def: string, vars?: Record<string, unknown>) =>
            t(`feedbackTree.${key}`, { defaultValue: def, ...vars }) as string,
        [t],
    );
}

const FeedbackTreeLevel: React.FC<FeedbackTreeLevelProps> = ({
    tree,
    root,
    pathIds,
    browsing,
    context,
    onBrowse,
    onDescend,
    onLeaf,
}) => {
    const { t } = useTranslation();
    const c = useChrome();
    // Synchronous: the level's rows are final on its first render.
    const { nodes: currentChildren, findNode, hasVisibleChildren } = resolveTreeLevel(tree, root, pathIds, context);

    const label = useCallback(
        (node: FeedbackTreeNode) =>
            t(node.labelKey, { defaultValue: node.labelDefault, ...feedbackLabelVars(context) }) as string,
        [t, context],
    );
    const desc = useCallback(
        (node: FeedbackTreeNode) =>
            node.descKey || node.descDefault
                ? (t(node.descKey ?? '', {
                      defaultValue: node.descDefault ?? '',
                      ...feedbackLabelVars(context),
                  }) as string)
                : undefined,
        [t, context],
    );

    const rowFor = (node: FeedbackTreeNode) => {
        const branch = hasVisibleChildren(node);
        return (
            <ActionSheetRow
                key={node.id}
                testID={`tree-row-${node.id}`}
                label={label(node)}
                description={desc(node)}
                icon={(node.icon as keyof typeof MaterialIcons.glyphMap) || 'chevron-right'}
                opensLevel={branch}
                onPress={() => (branch ? onDescend(node) : onLeaf(node, [...pathIds, node.id]))}
            />
        );
    };

    const atRoot = pathIds.length === 0;
    // D15: said at the tree's root only, and gone once the reader goes deeper.
    const caption = atRoot ? (
        <Text testID="feedback-caption" size="2xs" className="px-4 pt-1" style={{ color: 'rgb(163,163,163)' }}>
            {t('swipeFeed.feedbackCaption')}
        </Text>
    ) : null;

    if (root === 'dislike' && !browsing) {
        const fast = findNode('not_important');
        return (
            <>
                {fast ? rowFor(fast) : null}
                <ActionSheetRow
                    testID="tree-tell-more"
                    label={c('tellMore', 'Tell me more')}
                    icon="more-horiz"
                    opensLevel
                    onPress={onBrowse}
                />
                {caption}
            </>
        );
    }

    return (
        <>
            {currentChildren.length > 0 ? (
                currentChildren.map(rowFor)
            ) : (
                <Text className="text-center py-4" style={{ color: 'rgb(163,163,163)' }}>
                    {c('empty', 'No options here')}
                </Text>
            )}
            {caption}
        </>
    );
};

export default FeedbackTreeLevel;
