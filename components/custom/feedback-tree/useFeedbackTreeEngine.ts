// useFeedbackTreeEngine — the shared navigation brain for the feedback tree,
// extracted from FeedbackTreeOverlay so both the overlay (dislike, immediate
// persona-apply) and the Feed tab's InlineFeedbackTree (like OR dislike, no
// persona mutation) drive the SAME tree with the SAME gating + descent logic.
//
// It owns ONLY: tree fetch (+ throttled refresh), root selection (dislike →
// tree.root, like → tree.likeRoot ?? []), the descended-node path, and the
// gated children at the current level. Leaf handling is INTENTIONALLY left to
// the consumer — the overlay applies persona mutations immediately; the inline
// tree just records the path / escalates to chat. Neither behavior lives here.

import logger from '@/lib/logger';
import {
  evaluateCondition,
  type FeedbackTree,
  type FeedbackTreeNode,
  type LocalFeedbackContext,
} from '@/lib/news-harness/feedback-tree';
import { getFeedbackTree, refreshFeedbackTree } from '@/lib/services/feedback-tree-service';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type FeedbackTreeRoot = 'like' | 'dislike';

export interface FeedbackTreeEngine {
  /** The loaded tree (null until the first load resolves). */
  tree: FeedbackTree | null;
  /** The selected root's top-level nodes (tree.root or tree.likeRoot ?? []). */
  rootNodes: FeedbackTreeNode[];
  /** The descended branch nodes (empty = at the root level). */
  path: FeedbackTreeNode[];
  /** Children visible at the current level, gated by `evaluateCondition`. */
  currentChildren: FeedbackTreeNode[];
  /** Node ids of the current path, root→leaf (for persistence / breadcrumbs). */
  pathIds: string[];
  /** Find a node by id anywhere under the selected root. */
  findNode: (id: string) => FeedbackTreeNode | null;
  /** Push a branch node (no-op for a childless node). */
  descend: (node: FeedbackTreeNode) => void;
  /** Pop the last branch node. */
  backtrack: () => void;
  /** Jump back to a specific depth (0 = root level). */
  goToDepth: (depth: number) => void;
  /** Restore the BRANCH descent from a stored id sequence (a trailing leaf id is
   *  ignored — leaves aren't descended into). Used to resume a revisited card. */
  restorePath: (ids: string[]) => void;
  /** Reset to the root level. */
  reset: () => void;
}

export function useFeedbackTreeEngine(params: {
  /** Load + reset when this flips true (overlay: `visible`; inline: `true`). */
  active: boolean;
  /** Which side of the verdict bar this tree serves. Defaults to 'dislike'. */
  root?: FeedbackTreeRoot;
  /** On-device context for node gating (evaluateCondition). */
  context: LocalFeedbackContext;
}): FeedbackTreeEngine {
  const { active, root = 'dislike', context } = params;

  const [tree, setTree] = useState<FeedbackTree | null>(null);
  const [path, setPath] = useState<FeedbackTreeNode[]>([]);

  // Load the tree + kick a throttled refresh whenever the engine (re)activates.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setPath([]);
    getFeedbackTree()
      .then((tr) => {
        if (!cancelled) setTree(tr);
      })
      .catch((err) =>
        logger.captureException(err, {
          tags: { component: 'useFeedbackTreeEngine', method: 'load' },
        }),
      );
    void refreshFeedbackTree();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const rootNodes = useMemo(() => {
    if (!tree) return [];
    return root === 'like' ? tree.likeRoot ?? [] : tree.root;
  }, [tree, root]);

  const currentChildren = useMemo(() => {
    const level = path.length > 0 ? (path[path.length - 1].children ?? []) : rootNodes;
    return level.filter((n) => evaluateCondition(n.visibleIf, context));
  }, [path, rootNodes, context]);

  const findNode = useCallback(
    (id: string): FeedbackTreeNode | null => {
      const walk = (nodes: FeedbackTreeNode[]): FeedbackTreeNode | null => {
        for (const n of nodes) {
          if (n.id === id) return n;
          if (n.children) {
            const hit = walk(n.children);
            if (hit) return hit;
          }
        }
        return null;
      };
      return walk(rootNodes);
    },
    [rootNodes],
  );

  const descend = useCallback((node: FeedbackTreeNode) => {
    if (node.children && node.children.length > 0) {
      setPath((p) => [...p, node]);
    }
  }, []);

  const backtrack = useCallback(() => setPath((p) => p.slice(0, -1)), []);
  const goToDepth = useCallback((depth: number) => setPath((p) => p.slice(0, Math.max(0, depth))), []);
  const reset = useCallback(() => setPath([]), []);

  const restorePath = useCallback(
    (ids: string[]) => {
      const nodes: FeedbackTreeNode[] = [];
      let level = rootNodes;
      for (const id of ids) {
        const node = level.find((n) => n.id === id);
        if (!node || !node.children || node.children.length === 0) break; // leaf/unknown — stop
        nodes.push(node);
        level = node.children;
      }
      setPath(nodes);
    },
    [rootNodes],
  );

  const pathIds = useMemo(() => path.map((n) => n.id), [path]);

  return {
    tree,
    rootNodes,
    path,
    currentChildren,
    pathIds,
    findNode,
    descend,
    backtrack,
    goToDepth,
    restorePath,
    reset,
  };
}
