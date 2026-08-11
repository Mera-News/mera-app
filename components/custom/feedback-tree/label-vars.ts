// feedbackLabelVars — THE interpolation set for every feedback-tree label and
// message, on every surface.
//
// The friction it removes is concrete and already measured in this codebase:
// two components render this tree (the Feed's `InlineFeedbackTree` and the
// modal `FeedbackTreeOverlay`) and each built its own `t()` variable bag
// inline. The tree is SERVER-OWNED content, so a node authored with a
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

import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';

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

export function feedbackLabelVars(context: LocalFeedbackContext): FeedbackLabelVars {
  return {
    publication: context.publicationName ?? '',
    visits: context.publicationVisits ?? 0,
    eventType: context.eventType ?? '',
    entity: context.entity ?? '',
    place: context.geoText ?? '',
  };
}
