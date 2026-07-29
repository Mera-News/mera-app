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
