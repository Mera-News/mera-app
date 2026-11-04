// A fact accepted in chat whose topic run completed empty. The removal always
// comes before the model is told: with the chat open it happens at once; with
// the chat closed the fact waits, untouched and with no model call, for the
// reader's tap on "See what to save instead".

import { openMeraChat } from '@/components/custom/mera-button/open-mera-chat';
import { chatMayRemoveFact, patchMetadata, removeFailedChatFact } from '@/lib/database/services/fact-service';
import { TOPICS_ASK_REMOVAL } from '@/lib/database/services/topic-generation-status-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { flushRemovedFacts, noteRemovedFact } from './chat-session';

/** From inside the fact's own topic job, once it settled empty. */
export async function resolveEmptyChatFact(factId: string, statement: string): Promise<void> {
  if (!(await chatMayRemoveFact(factId, statement, { inOwnJob: true }))) return;
  if (!useFloatingChatStore.getState().isExpanded) {
    await patchMetadata(factId, { [TOPICS_ASK_REMOVAL]: true });
    return;
  }
  if (await removeFailedChatFact(factId, statement, { inOwnJob: true })) noteRemovedFact(statement);
}

const tapping = new Set<string>();

/**
 * The button. Removes the fact, then opens the chat so Mera can say so. False
 * means something now holds the fact: it stays and the button goes.
 */
export async function removeFactFromTap(factId: string, statement: string): Promise<boolean> {
  if (tapping.has(factId)) return false;
  tapping.add(factId);
  try {
    if (!(await removeFailedChatFact(factId, statement))) {
      await patchMetadata(factId, { [TOPICS_ASK_REMOVAL]: undefined }).catch(() => {});
      return false;
    }
    noteRemovedFact(statement);
    if (!useFloatingChatStore.getState().isExpanded) openMeraChat({ kind: 'persona' });
    void flushRemovedFacts().catch(() => {});
    return true;
  } finally {
    tapping.delete(factId);
  }
}
