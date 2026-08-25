// Topic-plan Save / Discard (r14) — shared by TopicPlanCard (one card) and
// TopicPlanSaveAllRow ("Save all" / "Discard all"), so the two surfaces can
// never drift on what an action actually does.
//
// SAVE keeps every generated topic active (they were written as active rows the
// moment they were generated) and records the review: the in-memory store map
// for an instant card update, plus `metadata.topicsReviewedAt` on the fact so
// the resolution survives a relaunch. Order matters — persist FIRST, then flip
// the store, so a failed write can never leave the card looking resolved while
// the durable marker is missing.
//
// DISCARD routes through `applyPersonaAction` like every other deterministic
// persona mutation, so it lands one `persona_change_log` row (source 'user')
// and shows up on the Activity screen. It deletes the fact, which cascades to
// the fact's topics — so there is NO separate per-topic `retire_topic` pass:
// those rows would point at records `destroyCascade` had already destroyed.
// The trade-off is that a discard is audited but NOT undoable (see
// action-names.DISCARD_FACT and action-display.isRevertible).

import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import { getFacts, markTopicsReviewed } from '@/lib/database/services/fact-service';
import { getByFact } from '@/lib/database/services/topic-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';

/** The fact statement, for the note. Resolved from the caller's prop where it
 *  has one (the card), else looked up — and for a DISCARD it must be read
 *  BEFORE the delete, because `discard_fact` destroys the row. */
async function resolveStatement(factId: string, statement?: string): Promise<string> {
  if (statement && statement.trim()) return statement.trim();
  try {
    const facts = await getFacts();
    return facts.find((f) => f.id === factId)?.statement ?? '';
  } catch {
    return '';
  }
}

export async function saveTopicPlan(factId: string, statement?: string): Promise<void> {
  // Snapshot BEFORE the review marker so the note records what the user
  // actually kept, including whatever they trimmed with the per-row X.
  const resolved = await resolveStatement(factId, statement);
  let kept: string[] = [];
  let removed: string[] = [];
  try {
    const rows = await getByFact(factId);
    kept = rows.filter((r) => r.status === 'active').map((r) => r.text);
    removed = rows.filter((r) => r.status === 'retired').map((r) => r.text);
  } catch {
    // A failed snapshot costs the note its detail, never the save.
  }

  await markTopicsReviewed(factId);
  const store = useFloatingChatStore.getState();
  store.setTopicPlanSettled(factId);
  // AFTER the durable write: a note for a save that did not happen would tell
  // the model something untrue. No turn is requested — the user asked for
  // silence on this path.
  store.addTopicPlanNote({ kind: 'saved', statement: resolved, kept, removed, at: Date.now() });
  // The card reads the fact back through `factMutationVersion`; without this
  // bump it would keep showing the pre-save metadata until some other mutation
  // happened to bump it.
  store.notifyFactMutation();
}

export interface DiscardOutcome {
  applied: boolean;
  changeLogId?: string;
}

export async function discardTopicPlan(
  factId: string,
  statement?: string,
): Promise<DiscardOutcome> {
  // BEFORE the delete — `discard_fact` destroys the row, so reading it
  // afterwards returns nothing and the note would name no fact at all.
  const resolved = await resolveStatement(factId, statement);

  const res = await applyPersonaAction({ action_type: 'discard_fact', factId }, 'user');
  const store = useFloatingChatStore.getState();
  // Marked discarded even when the executor reports `applied: false` — the only
  // way that happens is "fact not found", i.e. it is already gone. Leaving the
  // card unresolved in that case would block the chat input on a fact that no
  // longer exists.
  store.setTopicPlanDiscarded(factId);
  store.notifyFactMutation();
  store.addTopicPlanNote({ kind: 'discarded', statement: resolved, at: Date.now() });
  // LAST, and only on this path: the user rejected a suggestion and is owed a
  // reply. The nonce is a request, not a dispatch — ChatSessionView decides
  // when it may fire, which is what makes "Discard all" produce ONE turn
  // instead of N (each loop iteration leaves the gate non-zero until the last).
  store.requestTopicPlanTurn();
  return { applied: res.applied, changeLogId: res.changeLogId };
}
