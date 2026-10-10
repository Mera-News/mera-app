// The SHIPPED tree, resolved for real — the linkage test.
//
// The pure resolver has its own unit tests, but the F4 defect lived in the
// join: the leaf the user actually taps, filled from a real article's context,
// producing a filter nobody asked for. These assertions walk the bundled tree
// to the real node and resolve it, so a future edit to either the leaf or the
// resolver that re-opens that gap fails here.
//
// It also reproduces `isInertActionLeaf` from
// components/custom/feedback-tree/useFeedbackTreeEngine.ts (that file is
// another agent's; the predicate is copied, not imported, so this test asserts
// the CONTRACT between the two rather than re-testing their implementation).

import { evaluateCondition } from '../../news-harness/feedback-tree/evaluate-condition';
import { resolveLeafActions } from '../../news-harness/feedback-tree/resolve-leaf-actions';
import type {
  FeedbackTreeNode,
  LocalFeedbackContext,
} from '../../news-harness/feedback-tree/types';
import { feedbackLabelVars } from '@/components/custom/feedback-tree/label-vars';
import en from '../../locales/en.json';
import { APP_FEEDBACK_SCHEMA, BUNDLED_FEEDBACK_TREE } from '../feedback-tree-snapshot';

function findNode(nodes: FeedbackTreeNode[], id: string): FeedbackTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = n.children ? findNode(n.children, id) : null;
    if (hit) return hit;
  }
  return null;
}

/** Verbatim copy of useFeedbackTreeEngine's predicate (see file header). */
function isInertActionLeaf(node: FeedbackTreeNode, context: LocalFeedbackContext): boolean {
  const leaf = node.leaf;
  if (!leaf?.actions?.length) return false;
  if (leaf.openChat || leaf.nudge || leaf.seenOnly) return false;
  return resolveLeafActions(leaf, context).length === 0;
}

/** Verbatim copies of the engine's other two visibility predicates — same
 *  contract-not-implementation rationale as `isInertActionLeaf` above. */
function isDeadBranch(node: FeedbackTreeNode, context: LocalFeedbackContext): boolean {
  if (node.leaf) return false;
  const children = node.children;
  if (!children?.length) return false;
  return !children.some((c) => isVisibleNode(c, context));
}
function isVisibleNode(node: FeedbackTreeNode, context: LocalFeedbackContext): boolean {
  if (!evaluateCondition(node.visibleIf, context)) return false;
  if (isInertActionLeaf(node, context)) return false;
  return !isDeadBranch(node, context);
}

const thisCategory = findNode(BUNDLED_FEEDBACK_TREE.root, 'this_category');

describe('bundled tree — this_category', () => {
  it('exists and declares an add_suppression action', () => {
    expect(thisCategory).not.toBeNull();
    expect(thisCategory!.leaf?.actions?.[0]).toMatchObject({
      type: 'add_suppression',
      pattern: 'from_context_category',
    });
  });

  // F4: "What tech city Amsterdam can learn from Eindhoven" (Het Parool) has
  // category "News", and this minted a keyword filter literally labelled "News".
  it.each(['News', 'general_news', 'News (French)'])(
    'resolves to NOTHING on a generic-category article (%p) — the F4 repro',
    (category) => {
      expect(resolveLeafActions(thisCategory!.leaf, { category })).toEqual([]);
    },
  );

  it('is therefore HIDDEN by the engine on those articles, not shown-and-dead', () => {
    expect(isInertActionLeaf(thisCategory!, { category: 'News' })).toBe(true);
    // …and absent context behaves the same way it always did.
    expect(isInertActionLeaf(thisCategory!, {})).toBe(true);
  });

  it('stays VISIBLE and mints an exact category filter on a specific category', () => {
    expect(isInertActionLeaf(thisCategory!, { category: 'Sports' })).toBe(false);
    expect(resolveLeafActions(thisCategory!.leaf, { category: 'Sports' })).toEqual([
      {
        action_type: 'add_suppression',
        suppressionPattern: 'Sports',
        suppressionStrength: 0.5,
        suppressionKind: 'category',
        suppressionValue: 'Sports',
      },
    ]);
  });
});

describe('bundled tree — this_kind_of_event', () => {
  const node = findNode(BUNDLED_FEEDBACK_TREE.root, 'this_kind_of_event');

  it('is gated on has_event_type AND resolves to nothing without one', () => {
    expect(node!.visibleIf).toEqual({ has_event_type: true });
    // Belt and braces: even if a server tree drops the gate, the leaf is inert
    // (and therefore hidden) while no article carries an event type.
    expect(isInertActionLeaf(node!, {})).toBe(true);
    expect(isInertActionLeaf(node!, { eventType: 'Earnings call' })).toBe(false);
  });
});

// v3 — the paywall branch. It was DEAD: both of its children were gated
// (publication_visits_gte / cluster_size_gte) and the local context satisfies
// neither on a typical article, so `isDeadBranch` hid "It's paywalled"
// altogether. The whole point of `paywall_related` is that it carries no
// `visibleIf`, which makes the branch reachable by construction.
describe('bundled tree — the paywall branch is alive again', () => {
  const paywall = findNode(BUNDLED_FEEDBACK_TREE.root, 'paywall');
  const related = findNode(BUNDLED_FEEDBACK_TREE.root, 'paywall_related');
  const block = findNode(BUNDLED_FEEDBACK_TREE.root, 'paywall_block_source');

  it('is NOT a dead branch under an empty context — the regression this replaced', () => {
    expect(paywall).not.toBeNull();
    expect(isDeadBranch(paywall!, {})).toBe(false);
    expect(isVisibleNode(paywall!, {})).toBe(true);
  });

  it('shows related coverage unconditionally, and the block option only after 5 visits', () => {
    expect(related!.visibleIf).toBeUndefined();
    expect(related!.leaf).toEqual({ nudge: 'browse_related' });
    expect(isVisibleNode(related!, {})).toBe(true);

    // `publicationName` matters as much as the gate: the mute action resolves
    // off it, so without one the leaf is INERT and hidden regardless of visits
    // (same as `never_show`). Not a hole — the visit count is itself keyed by
    // publication name, so a context with 5 visits always has one.
    expect(block!.visibleIf).toEqual({ publication_visits_gte: 5 });
    expect(isVisibleNode(block!, { publicationName: 'The Hindu', publicationVisits: 4 })).toBe(
      false,
    );
    expect(isVisibleNode(block!, { publicationName: 'The Hindu', publicationVisits: 5 })).toBe(
      true,
    );
    expect(isVisibleNode(block!, { publicationVisits: 5 })).toBe(false);
  });

  it('keys its copy off `feedbackTree.*` (the namespace those four strings ship in)', () => {
    expect(related!.labelKey).toBe('feedbackTree.paywallRelatedOption');
    expect(related!.descKey).toBe('feedbackTree.paywallRelatedDesc');
    expect(block!.labelKey).toBe('feedbackTree.paywallBlockOption');
    expect(block!.descKey).toBe('feedbackTree.paywallSubscribeDesc');
  });

  it('reuses the exact never_show leaf shape for the block option (mute + confirm)', () => {
    const neverShow = findNode(BUNDLED_FEEDBACK_TREE.root, 'never_show');
    expect(block!.leaf).toEqual(neverShow!.leaf);
    // A `confirm` leaf must actually declare actions — the confirm branch in
    // both surfaces is gated on `actions.length > 0`, so a confirm-only leaf
    // would silently skip the arming step.
    expect(block!.leaf?.actions?.length).toBeGreaterThan(0);
  });

  it('interpolates {{visits}}, never {{count}} (i18next reserves count for plurals)', () => {
    const json = JSON.stringify(BUNDLED_FEEDBACK_TREE);
    expect(json).toContain('{{visits}}');
    expect(json).not.toContain('{{count}}');
  });
});

// v4 — "I'm seeing too much of this". A FREQUENCY complaint: the user still
// wants the subject, just less of it, so the leaf downweights the matched topics
// instead of minting a filter. The old `add_suppression`/`from_context_title`
// shape was doubly wrong — the wrong action family, AND inert: it produced a
// keyword row with an EMPTY keyword list, and the empty-keyword fallback in
// stage-scoring is hard-filter-only, so a soft (0.5) row never matched anything
// (see scoring-engine/__tests__/suppression.test.ts, "never matches on a blank
// keyword"). These assertions pin BOTH halves of the fix.
describe('bundled tree — too_many downweights, it does not filter', () => {
  const node = findNode(BUNDLED_FEEDBACK_TREE.root, 'too_many');
  const context: LocalFeedbackContext = {
    articleTitle: 'Crypto crashes again',
    matchedTopics: [
      { topicId: 't1', text: 'crypto markets' },
      { topicId: 't2', text: 'fintech' },
    ],
  };

  it('nudges every matched topic down, and mints no suppression', () => {
    expect(resolveLeafActions(node!.leaf, context)).toEqual([
      { action_type: 'set_topic_weight', topicId: 't1', delta: -0.3 },
      { action_type: 'set_topic_weight', topicId: 't2', delta: -0.3 },
    ]);
  });

  it('is a STRONGER nudge than "not that important", and both are reversible nudges', () => {
    const notImportant = findNode(BUNDLED_FEEDBACK_TREE.root, 'not_important');
    // Same action + scope, different magnitude — a volume complaint is the
    // strong step, a one-story importance judgement the mild one. Both go
    // through mutationRailsService.nudgeTopic, which threads a changeLogId back
    // so the Undo toast and un-voting revert them.
    expect(notImportant!.leaf?.actions?.[0]).toMatchObject({
      type: 'set_topic_weight',
      topics: 'matched',
      delta: -0.15,
    });
    expect(node!.leaf?.actions?.[0]).toMatchObject({ topics: 'matched', delta: -0.3 });
  });

  it('needs no visibleIf — isInertActionLeaf hides it when no topic can be nudged', () => {
    expect(node!.visibleIf).toBeUndefined();
    // No matched topic with a real id ⇒ nothing to nudge ⇒ the row is absent
    // rather than present-and-inert (which is exactly what it used to be).
    expect(isInertActionLeaf(node!, { articleTitle: 'Crypto crashes again' })).toBe(true);
    expect(isInertActionLeaf(node!, context)).toBe(false);
  });

  it('keys its label in the ONLY tree namespace the locale files ship', () => {
    // No locale file contains any `feedback.*` node key, so those labels render
    // from labelDefault (English) everywhere; `feedbackTree.*` is translated.
    expect(node!.labelKey).toBe('feedbackTree.tooMuchOfThis');
  });
});

// =========================================================================
// v5 — the restructured tree, and the PARITY contract with the server.
// =========================================================================
//
// This literal is the mirror image of `FEEDBACK_TREE_SHAPE` in the server's
// `apps/mera-scripts/.../seed-feedback-tree.service.spec.ts`. The two files
// cannot import each other — this is not a monorepo, the repos have separate
// CI, and only one is ever checked out — so each repo asserts the same shape
// against its own copy of the tree. A drift on either side fails in that side's
// pipeline, which is the only place it could ever be caught.
//
// Divergence this closed when it was written (2026-08-11): the SERVER tree
// lacked `kind: 'category'` on `this_category` and `visibleIf: has_event_type`
// on `this_kind_of_event`, both of which this file has carried for months. Since
// every device that has ever been online runs the SERVER tree, the live category
// filter was silently degraded to a keyword substring scan.
const FEEDBACK_TREE_SHAPE = [
  {
    id: 'publication_issue',
    labelKey: 'feedbackTree.publicationIssue',
    children: [
      {
        id: 'paywall',
        labelKey: 'feedbackTree.paywall',
        children: [
          { id: 'paywall_related', labelKey: 'feedbackTree.paywallRelatedOption' },
          { id: 'paywall_block_source', labelKey: 'feedbackTree.paywallBlockOption' },
        ],
      },
      {
        id: 'not_factual',
        labelKey: 'feedbackTree.notFactual',
        children: [
          { id: 'show_less', labelKey: 'feedbackTree.showLessPublication' },
          { id: 'never_show', labelKey: 'feedbackTree.neverShowPublication' },
        ],
      },
      { id: 'too_slow', labelKey: 'feedbackTree.tooSlow' },
      { id: 'too_cluttered', labelKey: 'feedbackTree.tooCluttered' },
      { id: 'manage_publication', labelKey: 'feedbackTree.managePublicationsOption' },
    ],
  },
  {
    id: 'suggestion',
    labelKey: 'feedbackTree.notAGoodSuggestion',
    children: [
      {
        id: 'not_related',
        labelKey: 'feedbackTree.notRelated',
        children: [
          { id: 'wrong_place', labelKey: 'feedbackTree.wrongPlace' },
          { id: 'wrong_topic', labelKey: 'feedbackTree.wrongTopic' },
          { id: 'something_else', labelKey: 'feedbackTree.somethingElse' },
        ],
      },
      { id: 'not_important', labelKey: 'feedbackTree.notThatImportant' },
      { id: 'too_many', labelKey: 'feedbackTree.tooMuchOfThis' },
      { id: 'seen_already', labelKey: 'feedbackTree.seenAlready' },
      { id: 'this_kind_of_event', labelKey: 'feedbackTree.showLessEventType' },
      { id: 'less_entity', labelKey: 'feedbackTree.showLessEntity' },
      { id: 'less_place', labelKey: 'feedbackTree.showLessPlace' },
      { id: 'this_category', labelKey: 'feedbackTree.thisCategory' },
      { id: 'tell_mera_why', labelKey: 'feedbackTree.tellMeraWhy' },
    ],
  },
];

function shapeOf(nodes: FeedbackTreeNode[]): unknown[] {
  return nodes.map((n) => ({
    id: n.id,
    labelKey: n.labelKey,
    ...(n.children ? { children: shapeOf(n.children) } : {}),
  }));
}

describe('bundled tree — v5 structure (server parity)', () => {
  it('offers exactly TWO dislike options: the publication, or the suggestion', () => {
    expect(BUNDLED_FEEDBACK_TREE.version).toBe(5);
    expect(BUNDLED_FEEDBACK_TREE.root).toHaveLength(2);
    expect(BUNDLED_FEEDBACK_TREE.root.map((n) => n.id)).toEqual([
      'publication_issue',
      'suggestion',
    ]);
  });

  it('matches the shape the SERVER spec pins (id + labelKey, root→leaf)', () => {
    expect(shapeOf(BUNDLED_FEEDBACK_TREE.root)).toEqual(FEEDBACK_TREE_SHAPE);
  });

  it('bumps APP_FEEDBACK_SCHEMA in lockstep — the tree uses v5-only vocabulary', () => {
    // `from_context_entity` / `from_context_place` / `has_entity` /
    // `manage_publication` all fail SILENTLY on a v4 app (literal keyword
    // filter, ignored gate, dropped nudge), so the schema MUST rise with them
    // or the server publishes a tree older apps mis-apply instead of dropping.
    expect(APP_FEEDBACK_SCHEMA).toBe(5);
    const json = JSON.stringify(BUNDLED_FEEDBACK_TREE);
    for (const token of [
      'from_context_entity',
      'from_context_place',
      'has_entity',
      'manage_publication',
    ]) {
      expect(json).toContain(token);
    }
  });

  it('keeps every LEAF id the feedback digest and the overlay resolve by name', () => {
    // `persona-management/feedback-digest::pathCandidates` switches on the LAST
    // id of a stored path, and FeedbackTreeOverlay's one-tap fast path is
    // literally `findNode('not_important')`. Renaming a leaf breaks both in
    // silence, so the restructure moved leaves and renamed none.
    for (const id of [
      'not_important',
      'too_many',
      'wrong_topic',
      'wrong_place',
      'this_kind_of_event',
      'this_category',
      'show_less',
      'too_slow',
      'too_cluttered',
      'never_show',
      'seen_already',
      'tell_mera_why',
      'something_else',
    ]) {
      expect(findNode(BUNDLED_FEEDBACK_TREE.root, id)).not.toBeNull();
    }
  });

  it('drops the branch ids the restructure absorbed', () => {
    for (const id of ['publication_website', 'publication_content', 'not_important_to_me']) {
      expect(findNode(BUNDLED_FEEDBACK_TREE.root, id)).toBeNull();
    }
  });

  it('routes every dislike label + message through feedbackTree.*', () => {
    // `feedback.*` is the BUG-REPORT form's namespace; no locale file ships a
    // `feedback.<nodeId>` key, so a label keyed there renders its English
    // labelDefault in all 20 languages.
    const walk = (nodes: FeedbackTreeNode[]): string[] =>
      nodes.flatMap((n) => [
        n.labelKey,
        ...(n.descKey ? [n.descKey] : []),
        ...(n.children ? walk(n.children) : []),
      ]);
    for (const key of walk(BUNDLED_FEEDBACK_TREE.root)) {
      expect(key.startsWith('feedbackTree.')).toBe(true);
    }
  });

  it('ships an English string for every dislike key it uses', () => {
    // The point of the namespace move is that these keys RESOLVE. A key absent
    // from en.json falls through to labelDefault, which looks identical in
    // English and is therefore invisible until a translator opens the file.
    const walk = (nodes: FeedbackTreeNode[]): string[] =>
      nodes.flatMap((n) => [
        n.labelKey,
        ...(n.descKey ? [n.descKey] : []),
        ...(n.children ? walk(n.children) : []),
      ]);
    for (const key of walk(BUNDLED_FEEDBACK_TREE.root)) {
      expect(en.feedbackTree).toHaveProperty(key.slice('feedbackTree.'.length));
    }
  });

  it('only interpolates variables BOTH surfaces supply', () => {
    // The highest-probability silent bug in a server-owned tree: a node uses a
    // placeholder one renderer's bag doesn't have, and the braces ship verbatim
    // on that surface only. `feedbackLabelVars` is the single shared bag; this
    // asserts the tree never outruns it.
    const supplied = new Set(Object.keys(feedbackLabelVars({})));
    const used = new Set(
      [...JSON.stringify(BUNDLED_FEEDBACK_TREE).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]),
    );
    for (const v of used) expect([...supplied]).toContain(v);
    // Not vacuous: the three tag vars are genuinely in the shipped tree.
    for (const v of ['eventType', 'entity', 'place']) expect(used.has(v)).toBe(true);
  });
});

describe('bundled tree — v5 tag leaves', () => {
  const entity = findNode(BUNDLED_FEEDBACK_TREE.root, 'less_entity')!;
  const place = findNode(BUNDLED_FEEDBACK_TREE.root, 'less_place')!;
  const event = findNode(BUNDLED_FEEDBACK_TREE.root, 'this_kind_of_event')!;

  it('names the tag in the label and mints a filter on the SAME field', () => {
    expect(event.labelDefault).toBe('Show less of {{eventType}}');
    expect(entity.labelDefault).toBe('Show less of {{entity}}');
    expect(place.labelDefault).toBe('Show less of {{place}}');
    expect(entity.leaf?.actions?.[0]).toMatchObject({
      pattern: 'from_context_entity',
      kind: 'entity',
      strength: 0.5,
    });
    expect(place.leaf?.actions?.[0]).toMatchObject({
      pattern: 'from_context_place',
      kind: 'place',
      strength: 0.5,
    });
  });

  it('hides each one on an article that lacks the tag, rather than showing a dead chip', () => {
    expect(isVisibleNode(entity, {})).toBe(false);
    expect(isVisibleNode(place, {})).toBe(false);
    expect(isVisibleNode(event, {})).toBe(false);
    expect(isVisibleNode(entity, { entity: 'Tesla' })).toBe(true);
    expect(isVisibleNode(place, { placeValue: 'Amsterdam' })).toBe(true);
    expect(isVisibleNode(event, { eventType: 'election' })).toBe(true);
  });

  it('gates the entity leaf twice over — the gate AND the inert-leaf rule', () => {
    // `has_entity` protects devices on the bundled snapshot; `isInertActionLeaf`
    // protects every device running a SERVER tree whose gate may not exist yet.
    // An unknown gate key is IGNORED, so the second belt is the real one.
    expect(entity.visibleIf).toEqual({ has_entity: true });
    expect(isInertActionLeaf(entity, {})).toBe(true);
    // The place leaf deliberately carries NO gate and relies on the belt alone.
    expect(place.visibleIf).toBeUndefined();
    expect(isInertActionLeaf(place, {})).toBe(true);
    expect(isInertActionLeaf(place, { geoText: 'Middle East' })).toBe(true); // prose ≠ value
    expect(isInertActionLeaf(place, { placeValue: 'MIDDLE_EAST' })).toBe(false);
  });

  it('keeps the entity filter SOFT — it may demote a story, never delete it', () => {
    expect(entity.leaf!.actions![0].strength).toBeLessThan(0.8);
  });
});

describe('bundled tree — manage_publication nudge', () => {
  const node = findNode(BUNDLED_FEEDBACK_TREE.root, 'manage_publication')!;

  it('is a host INTENT with no persona actions and no gate', () => {
    expect(node.leaf).toEqual({ nudge: 'manage_publication' });
    expect(node.visibleIf).toBeUndefined();
    // A nudge leaf declares no actions, so `isInertActionLeaf` must leave it
    // alone — it is the one flavour that legitimately mutates nothing.
    expect(isInertActionLeaf(node, {})).toBe(false);
    expect(isVisibleNode(node, {})).toBe(true);
  });

  it('carries a message explaining what the screen offers', () => {
    expect(node.descKey).toBe('feedbackTree.managePublicationsDesc');
    expect(node.descDefault).toContain('mute');
  });
});
