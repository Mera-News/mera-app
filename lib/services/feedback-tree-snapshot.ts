// Bundled feedback-tree snapshot — the OFFLINE / first-run / unseeded fallback.
// Seeded from the server's `feedback_tree_v1` (apps/mera-scripts .../feedback-
// tree-v1.ts). Keep this in sync when the server bumps the tree's STRUCTURE; the
// live tree is fetched + cached at runtime (feedback-tree-service), so a small
// content drift here is harmless — this only shows when the network/cache can't
// supply the current version.
//
// v2: adds `likeRoot` (the LIKE-side tree for the verdict bar) and the
// dislike-root `not_important_to_me` branch — kept verbatim in sync with the
// server's v2 feedback-tree-v1.ts.
//
// v3: rebuilds the `paywall` branch. Its two old children were both gated
// (`publication_visits_gte` / `cluster_size_gte`) and both informational, so on
// most articles they gated out and `isDeadBranch` hid "It's paywalled" entirely.
// It now leads with an UNGATED `paywall_related` (which un-deadens the branch by
// construction) and offers muting the publication only once the user has
// actually kept hitting it. Both children carry a per-node `descKey`/`descDefault`
// message. Kept verbatim in sync with the server's v3 feedback-tree-v1.ts.

import type { FeedbackTree } from '../news-harness/feedback-tree/types';

/** Structural schema version this app understands (gates minAppSchema).
 *
 *  v3 adds the `has_event_type` visibleIf gate. Bumped so the SERVER can
 *  publish a tree that uses the key with `minAppSchema: 3` and have it dropped
 *  by older apps rather than silently ignored. (Publishing it unguarded is also
 *  safe — `evaluateCondition` ignores gate keys it doesn't know — so the bump
 *  is about intent, not safety.)
 *
 *  v4 adds per-node `descKey`/`descDefault` (the option MESSAGE). Unlike the v3
 *  gate key, this one is NOT safe to publish unguarded: a pre-desc app renders
 *  the node's label and silently drops its message, so the rebuilt `paywall`
 *  branch would arrive there as two bare chips — one of them ("Show related
 *  coverage") ungated and, on that older build, wired to nothing but a nudge
 *  that closes the panel. Better that such an app keeps its cached v2 tree,
 *  which is why the server publishes v3 with `minAppSchema: 4`. */
export const APP_FEEDBACK_SCHEMA = 4;

export const BUNDLED_FEEDBACK_TREE: FeedbackTree = {
  version: 3,
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
              // gated (visit count / cluster size), so `isDeadBranch` hid the
              // branch outright on any article satisfying neither, which was
              // most of them. It is also the only useful answer to a paywall:
              // the same story, elsewhere, readable.
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
              // both surfaces already route that shape through their confirm
              // step, so it inherits tap-to-arm for free.
              id: 'paywall_block_source',
              labelKey: 'feedbackTree.paywallBlockOption',
              labelDefault: 'Block {{publication}} instead',
              descKey: 'feedbackTree.paywallSubscribeDesc',
              descDefault:
                "You've visited {{publication}} {{visits}} times this month — consider subscribing for full access.",
              icon: 'block',
              visibleIf: { publication_visits_gte: 5 },
              leaf: { actions: [{ type: 'set_publication_pref', value: 'mute' }], confirm: true },
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
          // D10: "this category" means the category, not any story that happens
          // to mention its name — so it mints a STRUCTURED filter (exact match
          // on the article's category field) rather than a substring scan.
          leaf: {
            actions: [
              { type: 'add_suppression', pattern: 'from_context_category', kind: 'category', strength: 0.5 },
            ],
          },
        },
        {
          id: 'this_kind_of_event',
          labelKey: 'feedback.this_kind_of_event',
          labelDefault: 'This kind of event',
          // Hidden while the article has no event type — which is currently
          // EVERY article (the server populates `event_type` on none of ~303k
          // rows), so this leaf would otherwise apply nothing and show no
          // toast. Reappears on its own once tagging writes the field.
          visibleIf: { has_event_type: true },
          leaf: {
            actions: [
              { type: 'add_suppression', pattern: 'from_context_eventType', kind: 'event_type', strength: 0.5 },
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
          leaf: { actions: [{ type: 'set_topic_weight', topics: 'from_selection', delta: 0.3 }] },
        },
        {
          id: 'a_bit_more',
          labelKey: 'feedback.a_bit_more',
          labelDefault: 'A bit more',
          leaf: { actions: [{ type: 'set_topic_weight', topics: 'from_selection', delta: 0.15 }] },
        },
      ],
    },
    {
      id: 'more_from_publication',
      labelKey: 'feedback.more_from_publication',
      labelDefault: 'More from this publication',
      icon: 'newspaper',
      leaf: { actions: [{ type: 'set_publication_pref', value: 'boost' }] },
    },
    {
      id: 'more_news_from_place',
      labelKey: 'feedback.more_news_from_place',
      labelDefault: 'More news from this place',
      icon: 'location-on',
      // No visibleIf: has_geo_mismatch is dislike-specific ("wrong place");
      // there's no clean inverse.
      //
      // This used to say the leaf is "shown unconditionally" and "no-ops
      // client-side" — that is no longer true. `isInertActionLeaf` (added in
      // the not-interested wave) HIDES any leaf whose actions all resolve to
      // nothing, precisely so a tap can never do nothing. `from_context_geo`
      // resolves off geoText, so this row now disappears whenever geoText is
      // absent — which, until article enrichment runs, is every article.
      // Intended behaviour, but it is a hide, not a no-op: the row is simply
      // not there rather than present-and-inert.
      leaf: { actions: [{ type: 'add_negative_topic', text: 'from_context_geo', weight: 0.6 }] },
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
