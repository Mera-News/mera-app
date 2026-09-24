// The feedback tree's ONE visibility rule and its level resolver.
//
// `resolveTreeLevel` resolves one level SYNCHRONOUSLY from a loaded tree, a
// root, a branch path and the context. The ••• sheet's tree levels
// (FeedbackTreeLevel) are its only renderer; the sheet host (useArticleMenu)
// loads the tree and keeps its navigation stack. Leaf handling lives in
// perform-feedback-leaf. The file keeps its old name: the stateful engine hook
// it was named after died with the inline Feed panel, and renaming would touch
// comments in lib/ that point here.

import {
  evaluateCondition,
  resolveLeafActions,
  type FeedbackTree,
  type FeedbackTreeNode,
  type LocalFeedbackContext,
} from '@/lib/news-harness/feedback-tree';

export type FeedbackTreeRoot = 'like' | 'dislike';

/** A leaf that DECLARES persona actions but whose actions all resolve to nothing
 *  under this article's context is inert: tapping it applies nothing and shows
 *  no toast, so the user learns that giving feedback does nothing. Hide it.
 *
 *  This is the tree-source-independent guard. A `visibleIf` gate in the bundled
 *  snapshot only protects devices still on the bundle — anything that has been
 *  online is running the SERVER tree (`app-config.feedback_tree_v1`), where the
 *  gate may not exist yet. Resolving the actions instead asks the only question
 *  that actually matters: would this tap do anything?
 *
 *  Deliberately narrow — it fires ONLY for action-declaring leaves. `openChat`,
 *  `nudge` and `seenOnly` leaves legitimately mutate nothing and must survive.
 *
 *  What it catches today, with MEASURED frequencies (2026-08-10, 300
 *  topic-linked prod articles — SERVED articles, which is the only population a
 *  feedback tree ever sees): `this_kind_of_event` on the 3% with no
 *  `event_type`, `less_entity` on the 30% with no entities, `less_place` on the
 *  15% with no geo tags, and `this_category` on a category-less or
 *  generic-category article. The older claim here — "event_type is null on
 *  every article in prod" — measured the RAW corpus (~8% enriched) and predates
 *  the 2026-07-30 / 2026-08-09 enrichment backfills. */
function isInertActionLeaf(node: FeedbackTreeNode, context: LocalFeedbackContext): boolean {
  const leaf = node.leaf;
  if (!leaf?.actions?.length) return false;
  if (leaf.openChat || leaf.nudge || leaf.seenOnly) return false;
  return resolveLeafActions(leaf, context).length === 0;
}

/** A BRANCH — children, no leaf of its own — whose children all gate out is the
 *  same dead end one level up: it renders with a chevron, and tapping it either
 *  does nothing or descends into an empty level.
 *
 *  Found by QA as `paywall`, whose only children (`nudge_subscribe`,
 *  `nudge_browse_related`) are gated on visit count and cluster size and are
 *  both off for most articles. `isInertActionLeaf` can't catch it — a branch has
 *  no `leaf`, so it returns at the first guard.
 *
 *  Recursive on purpose: a branch whose only child is itself an empty branch is
 *  equally dead, and the tree is authored deep enough for that to happen. */
function isDeadBranch(node: FeedbackTreeNode, context: LocalFeedbackContext): boolean {
  if (node.leaf) return false;
  const children = node.children;
  if (!children?.length) return false;
  return !children.some((c) => isVisibleNode(c, context));
}

/** The single visibility predicate. Every seam MUST use this one — QA found
 *  `paywall` precisely because the children filter and `hasVisibleChildren` had
 *  drifted into asking different questions. */
function isVisibleNode(node: FeedbackTreeNode, context: LocalFeedbackContext): boolean {
  if (!evaluateCondition(node.visibleIf, context)) return false;
  if (isInertActionLeaf(node, context)) return false;
  return !isDeadBranch(node, context);
}

/** The dislike tree's one-tap reason, lifted to the head of the dislike root
 *  (owner: every option on the first level, no "Tell me more") and dropped
 *  from the branch that holds it, so it shows once. Found BY ID, so it holds
 *  on any tree version: prod serves v4 (it sits under `suggestion`), the
 *  bundle is v5 (same). Only a LEAF is lifted: a branch there would open a
 *  level instead of answering in one tap. */
export const DISLIKE_PROMOTED_ID = 'not_important';

/**
 * One level of the tree, resolved SYNCHRONOUSLY from a loaded tree, a root, a
 * branch path and the context: the visible nodes at that depth, plus the two
 * helpers a level renderer needs. Pure, so a sheet level can draw its final
 * rows on its very first render (no async restore, no height change after the
 * level lands). Uses the ONE visibility predicate.
 */
export function resolveTreeLevel(
  tree: FeedbackTree,
  root: FeedbackTreeRoot,
  pathIds: readonly string[],
  context: LocalFeedbackContext,
): {
  nodes: FeedbackTreeNode[];
  findNode: (id: string) => FeedbackTreeNode | null;
  hasVisibleChildren: (node: FeedbackTreeNode) => boolean;
} {
  const rootNodes = root === 'like' ? tree.likeRoot ?? [] : tree.root;
  let level: FeedbackTreeNode[] = rootNodes;
  for (const id of pathIds) {
    const node = level.find((n) => n.id === id);
    if (!node || !node.children || node.children.length === 0) break;
    level = node.children;
  }
  const findNode = (id: string): FeedbackTreeNode | null => {
    const walk = (nodes: FeedbackTreeNode[]): FeedbackTreeNode | null => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const hit = n.children ? walk(n.children) : null;
        if (hit) return hit;
      }
      return null;
    };
    return walk(rootNodes);
  };
  // The lifted leaf, when this tree has one below its root.
  const promoted =
    root === 'dislike' && !rootNodes.some((n) => n.id === DISLIKE_PROMOTED_ID)
      ? findNode(DISLIKE_PROMOTED_ID)
      : null;
  const lifted = promoted && promoted.leaf && isVisibleNode(promoted, context) ? promoted : null;
  const shown = (n: FeedbackTreeNode) => isVisibleNode(n, context) && !(lifted && n.id === lifted.id);
  const visible = level.filter(shown);
  return {
    nodes: lifted && pathIds.length === 0 ? [lifted, ...visible] : visible,
    findNode,
    // Excludes the lifted leaf too: a branch whose only option moved to the
    // root would otherwise open an empty level.
    hasVisibleChildren: (node) => (node.children ?? []).some(shown),
  };
}
