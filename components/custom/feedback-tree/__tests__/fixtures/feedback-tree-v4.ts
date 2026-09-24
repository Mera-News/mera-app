// The feedback tree PROD serves today (app-config `feedback_tree_v1`, version 4),
// verbatim from mera-server's seed at the v4 commit (46f34e6, before the v5
// seed 207b2a0, which has never run in prod). Tree-dependent client logic (the
// flat dislike root) must hold on this AND on the bundled v5.
/* eslint-disable */
import type { FeedbackTree } from '@/lib/news-harness/feedback-tree';

export const FEEDBACK_TREE_V4: FeedbackTree = {
  version: 4,
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
              // UNGATED on purpose — this is the option that keeps the whole
              // "It's paywalled" branch alive. Both of the old children were
              // gated (visit count / cluster size), so the app's dead-branch
              // rule hid the branch outright on any article satisfying neither,
              // which was most of them. It is also the only useful answer to a
              // paywall: the same story, elsewhere, readable.
              id: 'paywall_related',
              labelKey: 'feedbackTree.paywallRelatedOption',
              labelDefault: 'Show related coverage',
              descKey: 'feedbackTree.paywallRelatedDesc',
              descDefault:
                'A similar story from another publication may not be paywalled — check the related articles.',
              icon: 'library-books',
              leaf: { nudge: 'browse_related' },
            },
            {
              // Muting is destructive, so it stays behind the visit gate and
              // carries the exact `never_show` leaf shape (mute + confirm) —
              // both app surfaces already route that shape through their
              // confirm step, so it inherits tap-to-arm for free.
              id: 'paywall_block_source',
              labelKey: 'feedbackTree.paywallBlockOption',
              labelDefault: 'Block {{publication}} instead',
              descKey: 'feedbackTree.paywallSubscribeDesc',
              descDefault:
                "You've visited {{publication}} {{visits}} times this month — consider subscribing for full access.",
              icon: 'block',
              visibleIf: { publication_visits_gte: 5 },
              leaf: {
                actions: [{ type: 'set_publication_pref', value: 'mute' }],
                confirm: true,
              },
            },
          ],
        },
        {
          id: 'too_slow',
          labelKey: 'feedback.too_slow',
          labelDefault: 'Too slow to load',
          icon: 'speed',
          leaf: {
            actions: [{ type: 'set_publication_pref', value: 'deprioritize' }],
          },
        },
        {
          id: 'too_cluttered',
          labelKey: 'feedback.too_cluttered',
          labelDefault: 'Cluttered / too many ads',
          leaf: {
            actions: [{ type: 'set_publication_pref', value: 'deprioritize' }],
          },
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
              leaf: {
                actions: [
                  { type: 'set_publication_pref', value: 'deprioritize' },
                ],
              },
            },
            {
              id: 'never_show',
              labelKey: 'feedback.never_show',
              labelDefault: 'Never show this publication',
              leaf: {
                actions: [{ type: 'set_publication_pref', value: 'mute' }],
                confirm: true,
              },
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
              leaf: {
                actions: [
                  {
                    type: 'add_negative_topic',
                    text: 'from_context_geo',
                    weight: -0.6,
                  },
                ],
              },
            },
            {
              id: 'wrong_topic',
              labelKey: 'feedback.wrong_topic',
              labelDefault: 'Wrong topic',
              icon: 'label-off',
              visibleIf: { has_matched_topics: true },
              leaf: {
                actions: [
                  {
                    type: 'set_topic_weight',
                    topics: 'from_selection',
                    delta: -0.2,
                  },
                ],
              },
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
          leaf: {
            actions: [
              { type: 'set_topic_weight', topics: 'matched', delta: -0.15 },
            ],
          },
        },
        {
          id: 'seen_already',
          labelKey: 'feedback.seen_already',
          labelDefault: "I've seen this already",
          icon: 'done-all',
          leaf: { seenOnly: true },
        },
        {
          // v4 — a FREQUENCY complaint, so it downweights rather than filters.
          // It used to mint `add_suppression` from `from_context_title`, which
          // was the wrong action family (a filter eliminates the subject; the
          // user asked for less of it, not none) and inert on top: that
          // placeholder produces a row whose `pattern` is the whole headline and
          // whose keyword list is EMPTY, and the app's empty-keyword fallback is
          // hard-filter-only, so a soft (0.5) row matched nothing, ever.
          // Nudging the matched topics' weight is the one lever that really
          // means "less often": on the app it drives both the relevance score
          // and the per-topic retrieval limit, so fewer articles are requested.
          // Scoped to `matched` and left ungated to match its sibling
          // `not_important`; the app already hides a leaf whose actions resolve
          // to nothing.
          id: 'too_many',
          labelKey: 'feedbackTree.tooMuchOfThis',
          labelDefault: "I'm seeing too much of this",
          icon: 'trending-down',
          leaf: {
            actions: [
              { type: 'set_topic_weight', topics: 'matched', delta: -0.3 },
            ],
          },
        },
      ],
    },
    {
      id: 'not_important_to_me',
      labelKey: 'feedback.not_important_to_me',
      labelDefault: 'Not important to me',
      icon: 'not-interested',
      children: [
        {
          id: 'this_category',
          labelKey: 'feedback.this_category',
          labelDefault: 'This category',
          leaf: {
            actions: [
              {
                type: 'add_suppression',
                pattern: 'from_context_category',
                strength: 0.5,
              },
            ],
          },
        },
        {
          id: 'this_kind_of_event',
          labelKey: 'feedback.this_kind_of_event',
          labelDefault: 'This kind of event',
          leaf: {
            actions: [
              {
                type: 'add_suppression',
                pattern: 'from_context_eventType',
                strength: 0.5,
              },
            ],
          },
        },
        {
          id: 'tell_mera_why',
          labelKey: 'feedback.tell_mera_why',
          labelDefault: 'Tell Mera why',
          leaf: { openChat: true },
        },
      ],
    },
  ],
  likeRoot: [
    {
      id: 'more_about_topic',
      labelKey: 'feedback.more_about_topic',
      labelDefault: 'More about this topic',
      icon: 'label',
      visibleIf: { has_matched_topics: true },
      children: [
        {
          id: 'a_lot_more',
          labelKey: 'feedback.a_lot_more',
          labelDefault: 'A lot more',
          leaf: {
            actions: [
              {
                type: 'set_topic_weight',
                topics: 'from_selection',
                delta: 0.3,
              },
            ],
          },
        },
        {
          id: 'a_bit_more',
          labelKey: 'feedback.a_bit_more',
          labelDefault: 'A bit more',
          leaf: {
            actions: [
              {
                type: 'set_topic_weight',
                topics: 'from_selection',
                delta: 0.15,
              },
            ],
          },
        },
      ],
    },
    {
      id: 'more_from_publication',
      labelKey: 'feedback.more_from_publication',
      labelDefault: 'More from this publication',
      icon: 'newspaper',
      leaf: {
        actions: [{ type: 'set_publication_pref', value: 'boost' }],
      },
    },
    {
      id: 'more_news_from_place',
      labelKey: 'feedback.more_news_from_place',
      labelDefault: 'More news from this place',
      icon: 'location-on',
      // No visibleIf: the only geo condition today is `has_geo_mismatch`
      // (dislike-specific — "wrong place"), which doesn't cleanly express
      // "this article HAS a place worth following". Shown unconditionally;
      // the leaf itself no-ops client-side when there's no geoText.
      leaf: {
        actions: [
          { type: 'add_negative_topic', text: 'from_context_geo', weight: 0.6 },
        ],
      },
    },
    {
      id: 'follow_story',
      labelKey: 'feedback.follow_story',
      labelDefault: 'Follow this story',
      icon: 'forum',
      leaf: { openChat: true },
    },
  ],
};
