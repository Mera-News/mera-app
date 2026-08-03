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
import { BUNDLED_FEEDBACK_TREE } from '../feedback-tree-snapshot';

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

describe('bundled tree — too_many is unaffected by the category gate', () => {
  const node = findNode(BUNDLED_FEEDBACK_TREE.root, 'too_many');

  it('still mints a keyword filter from the title', () => {
    expect(resolveLeafActions(node!.leaf, { articleTitle: 'Crypto crashes again' })).toEqual([
      {
        action_type: 'add_suppression',
        suppressionPattern: 'Crypto crashes again',
        suppressionStrength: 0.5,
      },
    ]);
  });
});
