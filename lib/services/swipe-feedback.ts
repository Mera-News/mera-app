// swipe-feedback — the Feed-tab signal-persistence layer (Round-4 P4).
//
// Turns a verdict tap/swipe on the Feed into a persisted `article_feedback`
// row (surface 'swipe'), enriches that row's stored `treePath` as the user taps
// the inline feedback tree, and converts a verdict + tapped path into a Mera
// chat handoff.
//
// No persona mutation happens in THIS module, but a verdict is no longer inert:
//   • a BARE verdict is provisional — written, shown hollow, and reaped at
//     write so it never reaches the digest (D15, see article-feedback-service);
//   • a tapped tree path re-opens the row for the digest, and a terminal leaf
//     applies its persona actions immediately (D16, InlineFeedbackTree);
//   • a chat escalation still applies via the agent's confirmed proposals,
//     which stamps the row processed.
//
// This is the wiring module for `swipe-callbacks.ts` — `wireSwipeCallbacks()`
// (called once by SwipeFeedScreen) replaces the no-op contract members with the
// real implementations below.

import {
  buildContextJson,
  feedbackSubjectFromSuggestion,
} from '@/components/custom/cards/feedback-subject';
import { swipeCallbacks, type Verdict } from '@/components/custom/feed/swipe-callbacks';
import i18n from '@/lib/i18n';
import {
  recordVerdictFeedback,
  removeArticleFeedback,
  updateFeedbackContextPath,
} from '@/lib/database/services/article-feedback-service';
import { getFeedbackTree } from '@/lib/services/feedback-tree-service';
import logger from '@/lib/logger';
import type { FeedbackTreeNode } from '@/lib/news-harness/feedback-tree/types';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';

// Analytics surface tag. Historically the Tinder-style swipe deck; the deck was
// replaced by the vertical Feed, so this now tags the FEED's verdict row. Kept as
// 'swipe' deliberately — renaming it would fragment the live feedback analytics.
const SURFACE = 'swipe';

/** Records a fresh verdict (latest-wins: removes the opposite-sentiment row). */
export async function recordSwipeVerdict(
  suggestion: ForYouSuggestion,
  verdict: Verdict,
): Promise<void> {
  const subject = feedbackSubjectFromSuggestion(suggestion, SURFACE);
  await recordVerdictFeedback({
    articleId: subject.articleId,
    suggestionId: subject.suggestionId,
    sentiment: verdict,
    title: subject.title,
    origin: 'suggestion',
    surface: SURFACE,
    contextJson: buildContextJson(subject),
  });
}

/** Flips a revisited card's verdict: drop the old sentiment, record the new. */
export async function changeSwipeVerdict(
  suggestion: ForYouSuggestion,
  from: Verdict,
  to: Verdict,
): Promise<void> {
  if (from === to) return;
  const subject = feedbackSubjectFromSuggestion(suggestion, SURFACE);
  await removeArticleFeedback(subject.articleId, from);
  await recordVerdictFeedback({
    articleId: subject.articleId,
    suggestionId: subject.suggestionId,
    sentiment: to,
    title: subject.title,
    origin: 'suggestion',
    surface: SURFACE,
    contextJson: buildContextJson(subject),
  });
}

/** Removes a card's verdict entirely (re-tapping the same thumb un-votes it):
 *  destroys the stored `article_feedback` row, dropping the verdict + any tree
 *  path recorded on it. */
export async function removeSwipeVerdict(
  suggestion: ForYouSuggestion,
  verdict: Verdict,
): Promise<void> {
  const subject = feedbackSubjectFromSuggestion(suggestion, SURFACE);
  await removeArticleFeedback(subject.articleId, verdict);
}

/** Merges the inline-tree node-id path into the stored verdict row. Records
 *  NAVIGATION only — a branch descent lands here and commits nothing. */
export async function updateFeedbackTreePath(
  suggestion: ForYouSuggestion,
  verdict: Verdict,
  path: string[],
): Promise<void> {
  await updateFeedbackContextPath(suggestion.articleId, verdict, path);
}

/** Marks the stored verdict row COMMITTED — a terminal leaf settled, or the user
 *  escalated to Mera along this path. This is the write a filled thumb is allowed
 *  to read, and it is what makes the fill survive a process restart. */
export async function commitFeedbackTreePath(
  suggestion: ForYouSuggestion,
  verdict: Verdict,
  path: string[],
): Promise<void> {
  await updateFeedbackContextPath(suggestion.articleId, verdict, path, true);
}

/**
 * Walks the tree along `pathIds`, resolving each tapped node to its localized
 * label. Stops at the first id that doesn't resolve (graceful degradation).
 */
function resolvePathLabels(rootNodes: FeedbackTreeNode[], pathIds: string[]): string[] {
  const labels: string[] = [];
  let level = rootNodes;
  for (const id of pathIds) {
    const node = level.find((n) => n.id === id);
    if (!node) break;
    labels.push(i18n.t(node.labelKey, { defaultValue: node.labelDefault }) as string);
    level = node.children ?? [];
  }
  return labels;
}

/**
 * Opens the Mera chat from a verdict + tapped path: resolves the path ids to
 * label breadcrumb, synthesizes the auto-sent initial message, and hands the
 * store an article-suggestion context carrying the verdict + label breadcrumb.
 * The store stays dumb — it just auto-sends the prebuilt message and threads the
 * context to the agent.
 */
export async function openFeedbackChatWithPath(
  suggestion: ForYouSuggestion,
  verdict: Verdict,
  path: string[],
): Promise<void> {
  let labels: string[] = [];
  try {
    const tree = await getFeedbackTree();
    const rootNodes = verdict === 'like' ? tree.likeRoot ?? [] : tree.root;
    labels = resolvePathLabels(rootNodes, path);
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'swipe-feedback', method: 'openChat.labels' },
    });
  }

  const breadcrumb = labels.join(' → ');
  const hasPath = breadcrumb.length > 0;
  const initialMessage = (
    verdict === 'like'
      ? hasPath
        ? i18n.t('swipeFeed.chatHandoffLike', { path: breadcrumb })
        : i18n.t('swipeFeed.chatHandoffLikeNoPath')
      : hasPath
        ? i18n.t('swipeFeed.chatHandoffDislike', { path: breadcrumb })
        : i18n.t('swipeFeed.chatHandoffDislikeNoPath')
  ) as string;

  useFloatingChatStore.getState().openArticleFeedback(
    {
      kind: 'article-suggestion',
      articleId: suggestion.articleId,
      suggestionId: suggestion._id,
      articleTitle: suggestion.title_en ?? '',
      verdict,
      // treePath carries the human-readable breadcrumb LABELS (not ids) so the
      // agent's <context> and intro can use them directly without re-resolving.
      treePath: labels,
    },
    initialMessage,
  );
}

/**
 * Opens the DEFAULT article chat from the VerdictBar's Mera icon: the article
 * context (pinned card) with the standard starter chips ("Why this?" / "Don't
 * want this") and NO auto-sent message — deliberately WITHOUT the verdict/tapped
 * path, so it is a plain conversation about the article rather than the tree's
 * "convert my taps into a conversation" handoff. `expand` starts a fresh thread
 * (nulling any pending auto-send) whenever the context differs.
 */
export function openArticleChat(suggestion: ForYouSuggestion): void {
  useFloatingChatStore.getState().expand({
    kind: 'article-suggestion',
    articleId: suggestion.articleId,
    suggestionId: suggestion._id,
    articleTitle: suggestion.title_en ?? '',
  });
}

/** Installs the real Feed-signal implementations onto the swipe-callbacks contract. */
export function wireSwipeCallbacks(): void {
  swipeCallbacks.onVerdict = (suggestion, verdict) => {
    void recordSwipeVerdict(suggestion, verdict);
  };
  swipeCallbacks.onVerdictChanged = (suggestion, from, to) => {
    void changeSwipeVerdict(suggestion, from, to);
  };
  swipeCallbacks.onVerdictRemoved = (suggestion, verdict) => {
    void removeSwipeVerdict(suggestion, verdict);
  };
  swipeCallbacks.onTreePathChanged = (suggestion, verdict, path) => {
    void updateFeedbackTreePath(suggestion, verdict, path);
  };
  swipeCallbacks.onLeafCommitted = (suggestion, verdict, path) => {
    void commitFeedbackTreePath(suggestion, verdict, path);
  };
  swipeCallbacks.onInvokeMera = (suggestion, verdict, path) => {
    void openFeedbackChatWithPath(suggestion, verdict, path);
  };
  swipeCallbacks.onOpenArticleChat = (suggestion) => {
    openArticleChat(suggestion);
  };
}
