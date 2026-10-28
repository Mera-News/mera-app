// Bundled feedback tree: the tree every v6 app shows.
//
// The server (`app-config.feedback_tree_v1`, seeded by `mera-scripts
// seed-feedback-tree`) still serves v5 at minAppSchema 5, and
// feedback-tree-service only considers trees built for schema 6 or later, so
// this file IS the live tree until the server publishes a v6+ one. The two
// repos cannot import each other; a server tree that replaces this one must
// carry the same leaf ids.
//
// Leaf ids are the digest's contract (`feedback-digest::pathCandidates`
// switches on the last id of a stored path): `too_many`, `not_important`,
// `show_less`, `never_show` and `too_slow` keep their ids and actions; new
// reasons get new ids. Branch ids may change freely.
//
// v6: the like tree is gone (thumbs up left every surface), the root is a hub
// of four reasons, and every leaf says its `cause`. Rows that name the reader's
// fact are gated on `has_fact`; the source rows on `has_publication`. The
// place picker, stop news and the fact page are host actions (nudges): their
// writes are persona's (`setFactPlaces`, `stopNewsForFact`).

import type { FeedbackTree } from '../news-harness/feedback-tree/types';

/** Structural schema this app understands. A tree whose `minAppSchema` is
 *  above it is never shown, and feedback-tree-service ignores any tree below
 *  6 (v5 and older carry the like tree and the lifted one-tap leaf).
 *
 *  v6 adds leaf `cause`, node `answerKey`/`answerDefault`, the `has_fact` and
 *  `has_publication` gates and the `open_fact`, `place_picker` and
 *  `stop_news` nudges. An older app would ignore the gates and show fact rows
 *  with an empty quote, so a v6 server tree must ship at minAppSchema 6. */
export const APP_FEEDBACK_SCHEMA = 6;

export const BUNDLED_FEEDBACK_TREE: FeedbackTree = {
  version: 6,
  root: [
    {
      id: 'profile_change',
      labelKey: 'feedbackTree.menu.rowProfile',
      labelDefault: 'My profile needs a change',
      icon: 'edit',
      visibleIf: { has_fact: true },
      children: [
        {
          id: 'matters_less',
          labelKey: 'feedbackTree.menu.mattersLess',
          labelDefault: 'This matters less to me now',
          icon: 'heart-broken',
          children: [
            {
              id: 'too_many',
              labelKey: 'feedbackTree.menu.showLess',
              labelDefault: 'Show me less for this',
              answerKey: 'feedbackTree.menu.answerLess',
              answerDefault: 'Less for this',
              icon: 'remove',
              leaf: { cause: 'config', actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.3 }] },
            },
            {
              id: 'not_important',
              labelKey: 'feedbackTree.menu.onlyBig',
              labelDefault: 'Only show big news for this',
              answerKey: 'feedbackTree.menu.answerBigOnly',
              answerDefault: 'Big news only',
              icon: 'priority-high',
              leaf: { cause: 'config', actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.15 }] },
            },
            {
              id: 'stop_news',
              labelKey: 'feedbackTree.menu.stopNews',
              labelDefault: 'Stop news for this',
              answerKey: 'feedbackTree.menu.answerStopped',
              answerDefault: 'No more news for this',
              icon: 'block',
              leaf: { cause: 'config', nudge: 'stop_news' },
            },
          ],
        },
        {
          id: 'details_wrong',
          labelKey: 'feedbackTree.menu.detailsWrong',
          labelDefault: 'My details are wrong or out of date',
          icon: 'edit-note',
          leaf: { cause: 'config', nudge: 'open_fact' },
        },
      ],
    },
    {
      id: 'not_about_fact',
      labelKey: 'feedbackTree.menu.rowNotAbout',
      labelDefault: 'This story isn\'t about "{{fact}}"',
      answerKey: 'feedbackTree.menu.answerMistake',
      answerDefault: "Noted as Mera's mistake",
      icon: 'link-off',
      visibleIf: { has_fact: true },
      leaf: { cause: 'system' },
    },
    {
      id: 'wrong_place',
      labelKey: 'feedbackTree.menu.rowPlace',
      labelDefault: 'Wrong place for me',
      icon: 'location-on',
      visibleIf: { has_fact: true },
      leaf: { cause: 'config', nudge: 'place_picker' },
    },
    {
      id: 'publication_issue',
      labelKey: 'feedbackTree.menu.rowSite',
      labelDefault: 'Problem with {{site}}',
      icon: 'newspaper',
      visibleIf: { has_publication: true },
      children: [
        {
          id: 'paywall',
          labelKey: 'feedbackTree.menu.paywalled',
          labelDefault: "I can't read it, it's paywalled",
          answerKey: 'feedbackTree.menu.answerPaywalled',
          answerDefault: 'Paywalled',
          icon: 'lock',
          leaf: { cause: 'source' },
        },
        {
          id: 'not_factual',
          labelKey: 'feedbackTree.menu.noTrust',
          labelDefault: "I don't trust it",
          icon: 'gpp-maybe',
          children: [
            {
              id: 'show_less',
              labelKey: 'feedbackTree.menu.trustLess',
              labelDefault: 'Show less from {{site}}',
              icon: 'remove',
              leaf: { cause: 'source', actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] },
            },
            {
              id: 'never_show',
              labelKey: 'feedbackTree.menu.trustNever',
              labelDefault: 'Never show {{site}}',
              icon: 'block',
              leaf: { cause: 'source', actions: [{ type: 'set_publication_pref', value: 'mute' }], confirm: true },
            },
          ],
        },
        {
          id: 'too_slow',
          labelKey: 'feedbackTree.menu.hardToUse',
          labelDefault: 'The site is hard to use',
          icon: 'hourglass-empty',
          leaf: { cause: 'source', actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] },
        },
        {
          id: 'fewer_from_site',
          labelKey: 'feedbackTree.menu.fewerSite',
          labelDefault: 'Show fewer from this site',
          icon: 'remove-circle-outline',
          leaf: { cause: 'source', actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] },
        },
      ],
    },
  ],
};
