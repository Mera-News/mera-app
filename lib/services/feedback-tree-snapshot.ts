// Bundled feedback-tree snapshot — the OFFLINE / first-run / unseeded fallback.
// Seeded from the server's `feedback_tree_v1` (apps/mera-scripts .../feedback-
// tree-v1.ts). Keep this in sync when the server bumps the tree's STRUCTURE; the
// live tree is fetched + cached at runtime (feedback-tree-service), so a small
// content drift here is harmless — this only shows when the network/cache can't
// supply the current version.

import type { FeedbackTree } from '../news-harness/feedback-tree/types';

/** Structural schema version this app understands (gates minAppSchema). */
export const APP_FEEDBACK_SCHEMA = 1;

export const BUNDLED_FEEDBACK_TREE: FeedbackTree = {
  version: 1,
  root: [
    {
      id: 'publication_website',
      labelKey: 'feedback.publication_website',
      labelDefault: 'Problem with the site',
      icon: 'language',
      children: [
        {
          id: 'paywall',
          labelKey: 'feedback.paywall',
          labelDefault: "It's paywalled",
          icon: 'lock',
          children: [
            {
              id: 'nudge_subscribe',
              labelKey: 'feedback.nudge_subscribe',
              labelDefault: 'Subscribe to this publication',
              visibleIf: { publication_visits_gte: 5 },
              leaf: { nudge: 'subscribe' },
            },
            {
              id: 'nudge_browse_related',
              labelKey: 'feedback.nudge_browse_related',
              labelDefault: 'Browse related coverage',
              visibleIf: { cluster_size_gte: 2 },
              leaf: { nudge: 'browse_related' },
            },
          ],
        },
        {
          id: 'too_slow',
          labelKey: 'feedback.too_slow',
          labelDefault: 'Too slow to load',
          icon: 'speed',
          leaf: { actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] },
        },
        {
          id: 'too_cluttered',
          labelKey: 'feedback.too_cluttered',
          labelDefault: 'Cluttered / too many ads',
          leaf: { actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] },
        },
      ],
    },
    {
      id: 'publication_content',
      labelKey: 'feedback.publication_content',
      labelDefault: "Don't like this publication",
      icon: 'newspaper',
      children: [
        {
          id: 'not_factual',
          labelKey: 'feedback.not_factual',
          labelDefault: 'Not factual / too biased',
          icon: 'fact-check',
          children: [
            {
              id: 'show_less',
              labelKey: 'feedback.show_less',
              labelDefault: 'Show me less of this',
              leaf: { actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] },
            },
            {
              id: 'never_show',
              labelKey: 'feedback.never_show',
              labelDefault: 'Never show this publication',
              leaf: { actions: [{ type: 'set_publication_pref', value: 'mute' }], confirm: true },
            },
          ],
        },
      ],
    },
    {
      id: 'suggestion',
      labelKey: 'feedback.suggestion',
      labelDefault: 'Not a good suggestion',
      icon: 'thumb-down',
      children: [
        {
          id: 'not_related',
          labelKey: 'feedback.not_related',
          labelDefault: 'Not related to me',
          children: [
            {
              id: 'wrong_place',
              labelKey: 'feedback.wrong_place',
              labelDefault: 'Wrong place',
              icon: 'wrong-location',
              visibleIf: { has_geo_mismatch: true },
              leaf: { actions: [{ type: 'add_negative_topic', text: 'from_context_geo', weight: -0.6 }] },
            },
            {
              id: 'wrong_topic',
              labelKey: 'feedback.wrong_topic',
              labelDefault: 'Wrong topic',
              icon: 'label-off',
              visibleIf: { has_matched_topics: true },
              leaf: { actions: [{ type: 'set_topic_weight', topics: 'from_selection', delta: -0.2 }] },
            },
            {
              id: 'something_else',
              labelKey: 'feedback.something_else',
              labelDefault: 'Something else',
              leaf: { openChat: true },
            },
          ],
        },
        {
          id: 'not_important',
          labelKey: 'feedback.not_important',
          labelDefault: 'Not that important',
          icon: 'low-priority',
          leaf: { actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.15 }] },
        },
        {
          id: 'seen_already',
          labelKey: 'feedback.seen_already',
          labelDefault: "I've seen this already",
          icon: 'done-all',
          leaf: { seenOnly: true },
        },
        {
          id: 'too_many',
          labelKey: 'feedback.too_many',
          labelDefault: 'Too many like this',
          icon: 'filter-list',
          leaf: { actions: [{ type: 'add_suppression', pattern: 'from_context_title', strength: 0.5 }] },
        },
      ],
    },
  ],
};
