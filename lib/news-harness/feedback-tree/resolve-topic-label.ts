// resolveTopicLabel — PURE, RN-FREE. Picks the topic to NAME a topic-scoped
// node's label with (e.g. the like-tree's "More about this topic" branch,
// whose "A lot more" / "A bit more" leaves otherwise ask the user to weight an
// unnamed thing). Only "real" matched topics count — those with a non-null
// topicId and non-empty text — mirroring the exact filter `resolveLeafActions`
// / `pickTopicIds` use to pick which topics a `set_topic_weight` action
// targets, and the `has_matched_topics` gate in `evaluateCondition` (which is
// why callers rarely see the `null` case: the branch this feeds is gated out
// whenever there's nothing real to name).
//
// This is presentation-only — it does not resolve or apply any persona
// mutation. The caller decides WHICH node ids get this treatment (see
// InlineFeedbackTree's `label()`), since that's UI chrome policy, not tree
// content.

import type { LocalFeedbackContext } from './types';

export interface TopicLabelChoice {
  /** The topic text to display (first real matched topic). */
  text: string;
  /** Count of ADDITIONAL real matched topics beyond `text` (0 when there's
   *  exactly one) — lets the caller say "and N more" instead of silently
   *  naming only one of several. */
  extraCount: number;
}

/** Returns the topic to name a topic-scoped node's label with, or `null` when
 *  there is nothing real to name (defensive — the node this feeds is normally
 *  gated out via `has_matched_topics` in that case). */
export function resolveTopicLabel(context: LocalFeedbackContext): TopicLabelChoice | null {
  const real = (context.matchedTopics ?? []).filter(
    (t): t is { topicId: string; text: string } => !!t.topicId && !!t.text?.trim(),
  );
  if (real.length === 0) return null;
  return { text: real[0].text.trim(), extraCount: real.length - 1 };
}
