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
import { markTopicsReviewed } from '@/lib/database/services/fact-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';

export async function saveTopicPlan(factId: string): Promise<void> {
  await markTopicsReviewed(factId);
  const store = useFloatingChatStore.getState();
  store.setTopicPlanSettled(factId);
  // The card reads the fact back through `factMutationVersion`; without this
  // bump it would keep showing the pre-save metadata until some other mutation
  // happened to bump it.
  store.notifyFactMutation();
}

export interface DiscardOutcome {
  applied: boolean;
  changeLogId?: string;
}

export async function discardTopicPlan(factId: string): Promise<DiscardOutcome> {
  const res = await applyPersonaAction({ action_type: 'discard_fact', factId }, 'user');
  const store = useFloatingChatStore.getState();
  // Marked discarded even when the executor reports `applied: false` — the only
  // way that happens is "fact not found", i.e. it is already gone. Leaving the
  // card unresolved in that case would block the chat input on a fact that no
  // longer exists.
  store.setTopicPlanDiscarded(factId);
  store.notifyFactMutation();
  return { applied: res.applied, changeLogId: res.changeLogId };
}
