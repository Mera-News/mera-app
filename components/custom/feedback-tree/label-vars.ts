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
//
// `fact` is the matched fact as a row shows it inside quotes: clamped to
// FACT_LABEL_MAX characters with an ellipsis. A row's accessibility label uses
// the full statement (`feedbackLabelVars(ctx, { fullFact: true })`).

import type { TFunction } from 'i18next';
import {
  type FeedbackTreeNode,
  type LocalFeedbackContext,
} from '@/lib/news-harness/feedback-tree/types';

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
  /** The publication as the v6 rows name it ("Problem with {{site}}"). */
  site: string;
  fact: string;
}

/** Owner rule: a quoted fact in a row is clamped to 60 characters. */
export const FACT_LABEL_MAX = 60;

function clampFact(statement: string): string {
  const s = statement.trim();
  return s.length <= FACT_LABEL_MAX ? s : `${s.slice(0, FACT_LABEL_MAX - 1).trimEnd()}…`;
}

/** The tree context as LABELS read it: plus the publication's display name
 *  in the app language (lib/stores/publication-display-store). Labels only:
 *  resolve-leaf-actions reads `publicationName`, the raw key a publication
 *  filter matches on, and never sees this field. */
export type FeedbackLabelContext = LocalFeedbackContext & {
  publicationDisplayName?: string | null;
};

export function feedbackLabelVars(
  context: FeedbackLabelContext,
  opts?: { fullFact?: boolean },
): FeedbackLabelVars {
  const publication = context.publicationDisplayName || context.publicationName || '';
  const statement = context.fact?.statement ?? '';
  return {
    publication,
    visits: context.publicationVisits ?? 0,
    eventType: context.eventType ?? '',
    entity: context.entity ?? '',
    place: context.geoText ?? '',
    site: publication,
    fact: opts?.fullFact ? statement : clampFact(statement),
  };
}

/** A tree node's display label, the SAME string wherever it is shown (the
 *  sheet's row, an answered row, the chat hand-off). `fullFact` is for the
 *  row's accessibility label. */
export function feedbackNodeLabel(
  t: TFunction,
  node: FeedbackTreeNode,
  context: FeedbackLabelContext,
  opts?: { fullFact?: boolean },
): string {
  return t(node.labelKey, { defaultValue: node.labelDefault, ...feedbackLabelVars(context, opts) }) as string;
}

/** The short answer an answered row shows ("Less for this"); the label when
 *  the node has none. */
export function feedbackNodeAnswer(t: TFunction, node: FeedbackTreeNode, context: FeedbackLabelContext): string {
  if (!node.answerKey && !node.answerDefault) return feedbackNodeLabel(t, node, context);
  return t(node.answerKey ?? '', { defaultValue: node.answerDefault ?? '', ...feedbackLabelVars(context) }) as string;
}
