// applyLeafActions — the ONE path from a terminal feedback-tree leaf to applied
// persona mutations plus an Undo toast.
//
// Extracted from FeedbackTreeOverlay so the inline Feed surface
// (InlineFeedbackTree) applies leaves through exactly the same machinery: the
// two presentations differ (modal sheet vs inline panel), their SEMANTICS must
// not. Previously only the overlay executed leaf actions, which is why the
// entire like-side tree — authored with real `set_topic_weight` /
// `set_publication_pref` actions — had never once run.
//
// Deliberately a PLAIN async function, not a hook, and with a module graph of
// exactly one runtime import (the logger):
//   • the persona executor / change log / i18n / toast are all imported
//     DYNAMICALLY, behind the `actions.length === 0` guard, so a surface that
//     merely renders the tree never drags the DB, the native translation module
//     or the ESM-only gluestack toast entry into its import graph;
//   • the toast goes through the global `toastManager` (initialized once at the
//     root layout), which lazily `require`s the gluestack toast components —
//     `useToast` would force a static import and make this a hook again.

import logger from '@/lib/logger';
import type { ResolvedPersonaAction } from '@/lib/news-harness/feedback-tree';

/**
 * Apply a leaf's resolved persona actions and offer an Undo.
 *
 * @param actions the concrete mutations from `resolveLeafActions`.
 * @param summary the tapped leaf's label — the toast's body line.
 * @param spend   the verdict row this leaf just consumed. When something is
 *                actually applied the row is stamped processed, so the 3-hourly
 *                digest can never apply a second helping of the same signal
 *                (D16). Owned here rather than by each caller so "applied" and
 *                "spent" can't drift apart.
 * @returns how many actions actually landed (0 = nothing changed, so callers
 *          must not claim otherwise to the user).
 */
export async function applyLeafActions(
  actions: ResolvedPersonaAction[],
  summary: string,
  spend?: { articleId: string; sentiment: 'like' | 'dislike' },
): Promise<number> {
  if (actions.length === 0) return 0;
  try {
    const [{ hapticSuccess }, { default: i18n }, { toastManager }] = await Promise.all([
      import('@/lib/haptics'),
      import('@/lib/i18n'),
      import('@/lib/toast-manager'),
    ]);
    /** i18n chrome helper — always supplies an English default so it renders
     *  pre-merge (mirrors FeedbackTreeOverlay's `useChrome`). */
    const c = (key: string, def: string): string =>
      i18n.t(`feedbackTree.${key}`, { defaultValue: def }) as string;

    hapticSuccess();
    // ResolvedPersonaAction is structurally a PersonaAction subset.
    const { applyPersonaActions } = await import(
      '@/lib/database/services/persona-action-executor'
    );
    const results = await applyPersonaActions(actions, 'feedback');
    const applied = results.filter((r) => r.applied);
    if (applied.length === 0) return 0;

    const changeLogIds = applied
      .filter((r) => r.changeLogId)
      .map((r) => r.changeLogId as string);

    if (spend) {
      const { markFeedbackProcessedFor } = await import(
        '@/lib/database/services/article-feedback-service'
      );
      await markFeedbackProcessedFor(spend.articleId, spend.sentiment);
    }

    toastManager.showUndoToast({
      title: c('appliedTitle', 'Got it — feed updated'),
      body: summary,
      undoLabel: c('undo', 'Undo'),
      undoneTitle: c('undoneTitle', 'Change undone'),
      onUndo: async () => {
        if (changeLogIds.length === 0) return;
        const { revertChange } = await import(
          '@/lib/database/services/persona-change-log-service'
        );
        for (const cid of changeLogIds) {
          try {
            await revertChange(cid);
          } catch (err) {
            logger.captureException(err, {
              tags: { component: 'applyLeafActions', method: 'undo' },
            });
          }
        }
      },
    });
    return applied.length;
  } catch (err) {
    logger.captureException(err, {
      tags: { component: 'applyLeafActions', method: 'apply' },
    });
    return 0;
  }
}

export default applyLeafActions;
