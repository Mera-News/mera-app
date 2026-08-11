// Bundled feedback-tree snapshot — the OFFLINE / first-run / unseeded fallback.
// Seeded from the server's `feedback_tree_v1` (apps/mera-scripts .../feedback-
// tree-v1.ts). Keep this in sync when the server bumps the tree's STRUCTURE; the
// live tree is fetched + cached at runtime (feedback-tree-service), so a small
// content drift here is harmless — this only shows when the network/cache can't
// supply the current version.
//
// "Small content drift is harmless" turned out to be doing a lot of work. When
// v5 was written, this file carried `kind: 'category'` on `this_category` and
// `visibleIf: { has_event_type }` on `this_kind_of_event` and the SERVER tree
// carried neither — so every device that had ever been online (i.e. all of
// them) ran a category filter degraded to a keyword substring scan. Both files
// now assert the same structural LITERAL in their own repo's tests
// (`__tests__/feedback-tree-snapshot.test.ts` here,
// `seed-feedback-tree.service.spec.ts` there); they cannot import each other,
// because this is not a monorepo and only one repo is ever checked out in CI.
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
//
// v4: rewires + relabels `too_many`. It asked a FREQUENCY question ("Too many
// like this") and answered it with an `add_suppression` — the wrong action
// family (a filter eliminates the subject; the user said they want less of it,
// not none) and, as shipped, an inert one: `from_context_title` mints a row with
// `pattern` = the article's whole headline and NO keywords, and the empty-keyword
// fallback in stage-scoring is HARD-only, so a soft (0.5) row matches nothing,
// ever (scoring-engine/suppression.ts::matchesKeywords returns false on an empty
// keyword list). It now nudges the MATCHED TOPICS' weight instead, which is the
// one lever in the persona model that genuinely means "less often, not never":
// weight drives both the score and the per-topic retrieval limit
// (scoring-engine/retrieval-profile.ts), so a lower weight literally asks the
// server for fewer articles on that topic. -0.3 mirrors the magnitude pair the
// like tree already establishes (`a_lot_more` 0.3 / `a_bit_more` 0.15): an
// explicit volume complaint is the strong step, `not_important` (-0.15) the mild
// one. Its labelKey also moves into the `feedbackTree.*` namespace.
//
// v5: TWO top-level dislike options instead of four, plus leaves that NAME the
// article's own tags. See the server file's header for the full rationale; the
// three things worth repeating here are:
//
//  1. Every LEAF id survived the move unchanged. `persona-management/feedback-
//     digest::pathCandidates` switches on the LAST id of a stored path, and the
//     modal overlay resolves `findNode('not_important')` for its one-tap fast
//     path — a renamed leaf would break both silently. Only BRANCH ids changed
//     (`publication_website` → `publication_issue`; `publication_content` and
//     `not_important_to_me` absorbed and gone).
//  2. Every dislike label moved to the `feedbackTree.*` namespace. `feedback.*`
//     is the BUG-REPORT form's namespace — no locale file has ever shipped a
//     `feedback.<nodeId>` key, so every node keyed there rendered its English
//     `labelDefault` in all 20 languages. (The likeRoot is still on `feedback.*`
//     and still English-only; migrating it is a separate wave.)
//  3. `less_place` reads `from_context_place` (the geo tag's own field,
//     verbatim), NOT `from_context_geo` (display prose). See resolve-leaf-
//     actions' SUPPRESSION_SOURCES comment.

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
 *  which is why the server publishes v3 with `minAppSchema: 4`.
 *
 *  v5 adds the `from_context_entity` / `from_context_place` suppression
 *  placeholders, the `has_entity` gate and `nudge: 'manage_publication'`. Every
 *  one of them fails SILENTLY on a v4 app: an unknown gate key is IGNORED (the
 *  entity leaf would show on entity-less articles), an unknown suppression
 *  placeholder is treated as a LITERAL pattern (minting a keyword filter on the
 *  string "from_context_entity"), and an unknown nudge merely closes the panel.
 *  A silent wrong answer is worse than no answer, so the server publishes the
 *  v5 tree at `minAppSchema: 5` and a v4 app keeps its cached v4 one. */
export const APP_FEEDBACK_SCHEMA = 5;

export const BUNDLED_FEEDBACK_TREE: FeedbackTree = {
  version: 5,
  root: [
    {
      id: 'publication_issue',
      labelKey: 'feedbackTree.publicationIssue',
      labelDefault: 'Issue with this publication',
      icon: 'newspaper',
      children: [
        {
          id: 'paywall',
          labelKey: 'feedbackTree.paywall',
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
          // v5 — was the whole `publication_content` top-level branch, whose
          // only child this was. A one-child branch under a root option that
          // already said "publication" was two taps of pure ceremony.
          id: 'not_factual',
          labelKey: 'feedbackTree.notFactual',
          labelDefault: 'Not factual / too biased',
          icon: 'fact-check',
          children: [
            {
              id: 'show_less',
              labelKey: 'feedbackTree.showLessPublication',
              labelDefault: 'Show me less of this',
              leaf: { actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] },
            },
            {
              id: 'never_show',
              labelKey: 'feedbackTree.neverShowPublication',
              labelDefault: 'Never show this publication',
              leaf: { actions: [{ type: 'set_publication_pref', value: 'mute' }], confirm: true },
            },
          ],
        },
        {
          id: 'too_slow',
          labelKey: 'feedbackTree.tooSlow',
          labelDefault: 'Too slow to load',
          icon: 'speed',
          leaf: { actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] },
        },
        {
          id: 'too_cluttered',
          labelKey: 'feedbackTree.tooCluttered',
          labelDefault: 'Cluttered / too many ads',
          icon: 'view-agenda',
          leaf: { actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] },
        },
        {
          // v5 — a NUDGE (host intent), not a persona mutation: it opens the
          // publication-preferences screen, the only place the three-way
          // boost / downrank / mute control exists. Every other option here
          // decides ONE publication in ONE direction; a user who wants the
          // other direction, or a different publication, otherwise has to know
          // that screen exists. Needs no action plumbing on any surface — see
          // `browse_related`.
          id: 'manage_publication',
          labelKey: 'feedbackTree.managePublicationsOption',
          labelDefault: 'Manage publications',
          descKey: 'feedbackTree.managePublicationsDesc',
          descDefault: 'Boost, downrank or mute any publication — including this one.',
          icon: 'tune',
          leaf: { nudge: 'manage_publication' },
        },
      ],
    },
    {
      id: 'suggestion',
      labelKey: 'feedbackTree.notAGoodSuggestion',
      labelDefault: 'Not a good suggestion',
      icon: 'thumb-down',
      children: [
        {
          id: 'not_related',
          labelKey: 'feedbackTree.notRelated',
          labelDefault: 'Not related to me',
          children: [
            {
              id: 'wrong_place',
              labelKey: 'feedbackTree.wrongPlace',
              labelDefault: 'Wrong place',
              icon: 'wrong-location',
              visibleIf: { has_geo_mismatch: true },
              leaf: { actions: [{ type: 'add_negative_topic', text: 'from_context_geo', weight: -0.6 }] },
            },
            {
              id: 'wrong_topic',
              labelKey: 'feedbackTree.wrongTopic',
              labelDefault: 'Wrong topic',
              icon: 'label-off',
              visibleIf: { has_matched_topics: true },
              leaf: { actions: [{ type: 'set_topic_weight', topics: 'from_selection', delta: -0.2 }] },
            },
            {
              id: 'something_else',
              labelKey: 'feedbackTree.somethingElse',
              labelDefault: 'Something else',
              leaf: { openChat: true },
            },
          ],
        },
        {
          id: 'not_important',
          labelKey: 'feedbackTree.notThatImportant',
          labelDefault: 'Not that important',
          icon: 'low-priority',
          leaf: { actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.15 }] },
        },
        {
          // v4 — a FREQUENCY complaint, so it downweights rather than filters.
          // Scoped to `matched` (not `from_selection`) to match its sibling
          // `not_important`, and left UNGATED for the same reason: an
          // action-declaring leaf whose actions resolve to nothing is already
          // hidden by `isInertActionLeaf` (useFeedbackTreeEngine), so a
          // `has_matched_topics` gate would be a second moving part for the
          // identical effect. Deliberately NOT named after the topic: doing that
          // means extending the `TOPIC_NAMED_NODE_ID` special-case, which lives
          // in InlineFeedbackTree only — the modal overlay would show a
          // different label for the same node (D17: presentations may differ,
          // semantics must not).
          id: 'too_many',
          labelKey: 'feedbackTree.tooMuchOfThis',
          labelDefault: "I'm seeing too much of this",
          icon: 'trending-down',
          leaf: { actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.3 }] },
        },
        {
          id: 'seen_already',
          labelKey: 'feedbackTree.seenAlready',
          labelDefault: "I've seen this already",
          icon: 'done-all',
          leaf: { seenOnly: true },
        },
        {
          // v5 — NAMES the event type instead of gesturing at it ("This kind of
          // event"). Same id, same action, byte-identical suppression row: the
          // id is what the feedback digest switches on; the label was the only
          // thing wrong with it.
          //
          // The gate stays. Its old justification here — "the server populates
          // `event_type` on none of ~303k rows" — is STALE: it measured the RAW
          // corpus and predates the 2026-07-30 / 2026-08-09 enrichment
          // backfills. Measured 2026-08-10 over 300 topic-linked prod articles,
          // coverage on SERVED articles is event_type 97%, geo_tags 85%,
          // entities 70%. 3% is not 0%, and on those the leaf resolves to no
          // actions and would apply nothing and show no toast.
          id: 'this_kind_of_event',
          labelKey: 'feedbackTree.showLessEventType',
          labelDefault: 'Show less of {{eventType}}',
          icon: 'event-busy',
          visibleIf: { has_event_type: true },
          leaf: {
            actions: [
              { type: 'add_suppression', pattern: 'from_context_eventType', kind: 'event_type', strength: 0.5 },
            ],
          },
        },
        {
          // v5 — the article's PRIMARY entity (the server emits entities
          // most-central-first). SOFT by construction and by three independent
          // rules: 0.5 is below HARD_SUPPRESSION_STRENGTH (0.8),
          // `mera-protocol/stage-scoring::loadPersonaScoringContext` files every
          // entity row soft regardless of strength, and
          // `scoring-engine/suppression::canHardExclude` refuses entity
          // outright. That is deliberate — entity extraction measured 68.8%
          // correct, so a wrong entity may cost a story rank, never its
          // existence. Do not "fix" any of the three.
          id: 'less_entity',
          labelKey: 'feedbackTree.showLessEntity',
          labelDefault: 'Show less of {{entity}}',
          icon: 'person-off',
          visibleIf: { has_entity: true },
          leaf: {
            actions: [
              { type: 'add_suppression', pattern: 'from_context_entity', kind: 'entity', strength: 0.5 },
            ],
          },
        },
        {
          // v5 — the article's most specific place. Reads `from_context_place`
          // (the geo tag's own city/region/countryCode, verbatim) and NOT
          // `from_context_geo`, which is display prose. Ungated on purpose:
          // there is no `has_place` key and none is needed — `isInertActionLeaf`
          // drops the row on a place-less article. One moving part, not two.
          id: 'less_place',
          labelKey: 'feedbackTree.showLessPlace',
          labelDefault: 'Show less of {{place}}',
          icon: 'location-off',
          leaf: {
            actions: [
              { type: 'add_suppression', pattern: 'from_context_place', kind: 'place', strength: 0.5 },
            ],
          },
        },
        {
          // v5 — moved here from `not_important_to_me`, otherwise untouched.
          // D10: "this category" means the category, not any story that happens
          // to mention its name — so it mints a STRUCTURED filter (exact match
          // on the article's category field) rather than a substring scan.
          id: 'this_category',
          labelKey: 'feedbackTree.thisCategory',
          labelDefault: 'This category',
          icon: 'category',
          leaf: {
            actions: [
              { type: 'add_suppression', pattern: 'from_context_category', kind: 'category', strength: 0.5 },
            ],
          },
        },
        {
          id: 'tell_mera_why',
          labelKey: 'feedbackTree.tellMeraWhy',
          labelDefault: 'Tell Mera why',
          icon: 'chat',
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
      // resolves off geoText, so this row disappears whenever geoText is
      // absent — measured 2026-08-10 at ~15% of served articles, not "every
      // article" as this comment used to claim. Intended behaviour, but it is
      // a hide, not a no-op: the row is simply not there rather than
      // present-and-inert.
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
