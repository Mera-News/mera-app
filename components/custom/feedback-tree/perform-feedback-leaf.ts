// What a feedback-tree LEAF does, in one place for every sheet level that
// shows the tree (ported from the retired FeedbackTreeOverlay, behaviour
// unchanged). The host passes `closeThen`: close the sheet, then run the
// follow-up once it has gone (a chat, a screen push, a toast).

import { applyLeafActions } from '@/components/custom/feedback-tree/apply-leaf-actions';
import { openPublicationPreferences } from '@/components/custom/feedback-tree/open-publication-preferences';
import {
    resolveLeafActions,
    type FeedbackTreeNode,
    type LocalFeedbackContext,
} from '@/lib/news-harness/feedback-tree';
import type { ChatContext } from '@/lib/stores/floating-chat-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { getAiAccess } from '@/lib/stores/subscription-store';

export interface FeedbackLeafDeps {
    context: LocalFeedbackContext;
    /** Chat handoff target for `openChat` leaves. */
    chatContext: ChatContext;
    /** Message auto-sent when a leaf escalates INTO chat. */
    chatMessage: string;
    /** The node's display label (the undo toast names it). */
    label: string;
    /** The verdict row this leaf spends. applyLeafActions stamps it processed
     *  and records the change-log ids, so removing or flipping the verdict
     *  reverts exactly what the leaf applied. */
    spend: { articleId: string; sentiment: 'like' | 'dislike' };
    /** Close the sheet, then run `after` once it has gone. */
    closeThen: (after?: () => void) => void;
    /** A terminal leaf settled: persist the path. `committed` is explicit:
     *  a seenOnly leaf changes nothing BY DESIGN and must leave the thumb
     *  unfilled, while a leaf whose placeholders couldn't be resolved still
     *  counts as a reason the user gave. */
    onLeafPicked: (pathIds: string[], appliedCount: number, committed: boolean) => void;
    /** Short confirmation toast (title, optional body). */
    showInfo: (title: string, body?: string) => void;
    /** i18n chrome with an English default. */
    chrome: (key: string, def: string, vars?: Record<string, unknown>) => string;
}

export function performFeedbackLeaf(node: FeedbackTreeNode, pathIds: string[], d: FeedbackLeafDeps): void {
    const leaf = node.leaf;
    if (!leaf) return;

    // Escalate into the Mera chat.
    if (leaf.openChat) {
        // Mera News Free: `openArticleFeedback` is a no-op, so this leaf has
        // nowhere to escalate TO; persist the tapped path as a reason given.
        if (getAiAccess() === 'locked') {
            d.onLeafPicked(pathIds, 0, true);
            d.closeThen();
            return;
        }
        d.closeThen(() => useFloatingChatStore.getState().openArticleFeedback(d.chatContext, d.chatMessage));
        return;
    }

    // Nudge: a SUGGESTION, not a persona mutation.
    if (leaf.nudge) {
        d.onLeafPicked(pathIds, 0, true);
        if (leaf.nudge === 'manage_publication') {
            d.closeThen(() => openPublicationPreferences());
        } else if (leaf.nudge === 'subscribe') {
            d.closeThen(() =>
                d.showInfo(
                    d.chrome('nudgeSubscribe', 'Subscribing unlocks full articles', {
                        publication: d.context.publicationName ?? '',
                    }),
                ),
            );
        } else {
            d.closeThen(() => d.showInfo(d.chrome('nudgeBrowse', 'Look for related coverage from other sources')));
        }
        return;
    }

    // "I've seen this": acknowledge only, and DO NOT commit.
    if (leaf.seenOnly) {
        d.onLeafPicked(pathIds, 0, false);
        d.closeThen(() => d.showInfo(d.chrome('seenAck', "Got it: we'll show fewer you've seen")));
        return;
    }

    // Concrete persona mutations.
    const actions = resolveLeafActions(leaf, d.context);
    if (actions.length === 0) {
        d.onLeafPicked(pathIds, 0, true);
        d.closeThen(() => d.showInfo(d.chrome('thanks', 'Thanks for the feedback')));
        return;
    }
    d.closeThen(() => {
        void applyLeafActions(actions, d.label, d.spend).then((applied) => d.onLeafPicked(pathIds, applied, true));
    });
}

/** A destructive leaf asks first (a pushed confirm level). */
export function leafNeedsConfirm(node: FeedbackTreeNode): boolean {
    return !!node.leaf?.confirm && (node.leaf.actions?.length ?? 0) > 0;
}
