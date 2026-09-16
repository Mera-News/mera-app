// fact-choice-actions — the SIDE-EFFECT half of per-group fact-choice state.
//
// Sibling of topic-plan-actions.ts, and the same contract: the card requests, a
// single tested module decides and writes. Every write to a fact-choice tool
// result goes through `resolveGroup` below, so the in-memory and durable halves
// can never disagree and no card owns its own merge logic.
//
// THE MERGE MUST READ THE STORE, NEVER A RENDER-TIME CLOSURE. Two fast taps on
// two different cards both resolve into the SAME blob, and a card that merged
// into the `toolCallResults` value it captured at render would write back a blob
// missing whatever the other tap had just committed — silently losing a saved
// fact. The snapshot below is taken with `getState()` immediately before the
// `set`, with no `await` between them, so nothing can interleave: JS is single
// threaded and zustand's `set` is synchronous. Anything async (the actual fact
// commit) happens BEFORE this function is called, never inside the window.

import { patchMessageToolCallResult } from '@/lib/database/services/conversation-service';
import {
  mergeGroupResolution,
  type FactChoiceResolution,
} from '@/lib/chat-tools/fact-choice-resolution';
import logger from '@/lib/logger';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';

/**
 * Apply one group's outcome to the tool result at `resultKey`.
 *
 * `resolution === undefined` removes the entry, which is how Undo returns a
 * dismissed group to pending.
 *
 * The durable half is fire-and-forget on purpose: a missing message row is NOT
 * an error (an assistant message persists only once the turn finalises, so a
 * fast tap can land first) and `useChatPersistence` merges the store override in
 * at write time to close that race. Failing the tap because the row is not there
 * yet would be a regression against a race the persistence layer already
 * handles.
 */
export function resolveGroup(
  resultKey: string,
  groupId: string,
  resolution: FactChoiceResolution | undefined,
  baseResult: Record<string, unknown>,
): Record<string, unknown> {
  const store = useFloatingChatStore.getState();
  // READ -> MERGE -> WRITE, synchronously. See the module header.
  //
  // `baseResult` is the tool call's OWN staged result, and it is required, not a
  // convenience. The store holds OVERRIDES ONLY: on the first tap of a turn
  // there is no entry at `resultKey` at all, because the staged blob lives on
  // `message.toolCalls[idx].result` and nothing has copied it across. Merging
  // into `undefined` produced a blob whose spine was empty, the deriver applied
  // it as the whole result, found no groups and emitted NO CARDS — every card in
  // the turn vanished on the first tap, with the fact still saved because the
  // commit had already run. Falling back to the staged result is what makes the
  // first merge and every later one identical.
  const current =
    (store.toolCallResults[resultKey] as Record<string, unknown> | undefined) ?? baseResult;
  const next = mergeGroupResolution(current, groupId, resolution);
  store.setToolCallResult(resultKey, next);

  const [messageId, indexRaw] = resultKey.split('::');
  const index = Number(indexRaw);
  if (messageId && Number.isInteger(index)) {
    void patchMessageToolCallResult(messageId, index, next).catch((err: unknown) => {
      logger.warn('[fact-choice] durable patch failed', {
        resultKey,
        groupId,
        error: String(err),
      });
      return false;
    });
  }
  return next;
}

/**
 * Apply SEVERAL groups' outcomes in one pass.
 *
 * "Add all" and "Skip all" resolve N groups at once, and doing that as N calls
 * to `resolveGroup` would be N store writes, N re-renders and N durable patches
 * for one user tap. Folding them through `mergeGroupResolution` in a single
 * read-modify-write also means the fully-resolved rewrite fires exactly once,
 * on the final merge, rather than being evaluated against N-1 partial states.
 */
export function resolveGroups(
  resultKey: string,
  entries: { groupId: string; resolution: FactChoiceResolution | undefined }[],
  baseResult: Record<string, unknown>,
): Record<string, unknown> {
  const store = useFloatingChatStore.getState();
  // Same required fallback as resolveGroup: "Add all" is usually the FIRST
  // resolution of the turn, so the store entry is the one that does not exist.
  let next =
    (store.toolCallResults[resultKey] as Record<string, unknown> | undefined) ?? baseResult;
  for (const entry of entries) {
    next = mergeGroupResolution(next, entry.groupId, entry.resolution);
  }
  const settled = next ?? {};
  store.setToolCallResult(resultKey, settled);

  const [messageId, indexRaw] = resultKey.split('::');
  const index = Number(indexRaw);
  if (messageId && Number.isInteger(index)) {
    void patchMessageToolCallResult(messageId, index, settled).catch((err: unknown) => {
      logger.warn('[fact-choice] durable batch patch failed', {
        resultKey,
        error: String(err),
      });
      return false;
    });
  }
  return settled;
}
