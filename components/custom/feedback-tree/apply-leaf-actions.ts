// applyLeafActions: the ONE path from a feedback-tree leaf's resolved actions
// to applied persona mutations. The feedback sheet (useFeedbackHub) records the
// answer, keeps the change-log ids and shows one toast with Undo for every
// answer when it closes, so this applies and reports, nothing else.
//
// A plain async function whose only runtime import is the logger: the persona
// executor is REQUIRED AT CALL TIME (not `await import()`, which jest cannot
// run), so a surface that merely renders the tree never pulls the database
// into its import graph.

import logger from '@/lib/logger';
import type { ResolvedPersonaAction } from '@/lib/news-harness/feedback-tree/types';

/** How many actions landed (0: nothing changed, so a caller must not claim
 *  otherwise) and the change-log ids an Undo reverts. */
export async function applyLeafActions(
  actions: ResolvedPersonaAction[],
): Promise<{ applied: number; changeLogIds: string[] }> {
  if (actions.length === 0) return { applied: 0, changeLogIds: [] };
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { hapticSuccess } = require('@/lib/haptics') as typeof import('@/lib/haptics');
    const { applyPersonaActions } = require('@/lib/database/services/persona-action-executor') as typeof import('@/lib/database/services/persona-action-executor');
    /* eslint-enable @typescript-eslint/no-require-imports */
    hapticSuccess();
    // ResolvedPersonaAction is structurally a PersonaAction subset.
    const applied = (await applyPersonaActions(actions, 'feedback')).filter((r) => r.applied);
    return {
      applied: applied.length,
      changeLogIds: applied.map((r) => r.changeLogId).filter((id): id is string => !!id),
    };
  } catch (err) {
    logger.captureException(err, { tags: { component: 'applyLeafActions', method: 'apply' } });
    return { applied: 0, changeLogIds: [] };
  }
}
