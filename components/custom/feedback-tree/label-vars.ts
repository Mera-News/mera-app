// feedbackLabelVars — THE interpolation set for every feedback-tree label and
// message, on every surface.
//
// The friction it removes is concrete and already measured in this codebase:
// the tree's labels are rendered in more than one place (the sheet's rows in
// `FeedbackTreeLevel`, the Undo toast's summary in useArticleMenu) and each
// once built its own `t()` variable bag inline. The tree is SERVER-OWNED content, so a node authored with a
// placeholder only one bag supplies renders its braces verbatim — "Show less of
// {{entity}}" — and only on the surface that was missed, which is invisible to
// whoever tested the other one. ("Block {{publication}} instead" is on record as
// nearly shipping exactly that way.)
//
// So there is one bag, it is a superset, and a label that uses none of it simply
// ignores it. Anything added to a tree label must be added HERE, and the tree's
// own tests assert every `{{var}}` in the shipped tree is a key of this object.
//
// `place` is deliberately `geoText` — DISPLAY prose, with a supranational code
// resolved to "Middle East". The `place` FILTER that the same leaf mints reads
// `placeValue` (the tag's verbatim field) instead; see resolve-leaf-actions.

import type { TFunction } from 'i18next';
import {
  resolveTopicLabel,
  type FeedbackTreeNode,
  type LocalFeedbackContext,
} from '@/lib/news-harness/feedback-tree';

/** The one node whose label names the article's matched topic ("More about:
 *  Formula 1") instead of the unnamed "More about this topic": its "A lot
 *  more" / "A bit more" leaves really move that topic's weight (D16). */
const TOPIC_NAMED_NODE_ID = 'more_about_topic';

export interface FeedbackLabelVars {
  publication: string;
  /** Deliberately NOT `count` — i18next reserves that name to select
   *  `_one`/`_other` plural suffixes on the key itself, which are looked up
   *  BEFORE the base key and would 404 to `defaultValue` on every locale that
   *  ships only the base key. */
  visits: number;
  eventType: string;
  entity: string;
  place: string;
}

/** The tree context as LABELS read it: plus the publication's display name
 *  in the app language (lib/stores/publication-display-store). Labels only:
 *  resolve-leaf-actions reads `publicationName`, the raw key a publication
 *  filter matches on, and never sees this field. */
export type FeedbackLabelContext = LocalFeedbackContext & {
  publicationDisplayName?: string | null;
};

export function feedbackLabelVars(context: FeedbackLabelContext): FeedbackLabelVars {
  return {
    publication: context.publicationDisplayName || context.publicationName || '',
    visits: context.publicationVisits ?? 0,
    eventType: context.eventType ?? '',
    entity: context.entity ?? '',
    place: context.geoText ?? '',
  };
}

/**
 * A tree node's display label, the SAME string wherever it is shown (the
 * sheet's row, the Undo toast's summary): the full variable bag, plus the
 * matched-topic naming for `more_about_topic`. Falls back to the generic label
 * when there is no real topic to name, never an empty "More about: ".
 */
export function feedbackNodeLabel(t: TFunction, node: FeedbackTreeNode, context: FeedbackLabelContext): string {
  if (node.id === TOPIC_NAMED_NODE_ID) {
    const choice = resolveTopicLabel(context);
    if (choice) {
      return (
        choice.extraCount > 0
          ? t('feedbackTree.moreAboutTopicNamedWithCount', {
              defaultValue: 'More about: {{topic}} and {{extra}} more',
              topic: choice.text,
              // NOT `count`: see FeedbackLabelVars.visits.
              extra: choice.extraCount,
            })
          : t('feedbackTree.moreAboutTopicNamed', {
              defaultValue: 'More about: {{topic}}',
              topic: choice.text,
            })
      ) as string;
    }
  }
  return t(node.labelKey, { defaultValue: node.labelDefault, ...feedbackLabelVars(context) }) as string;
}

