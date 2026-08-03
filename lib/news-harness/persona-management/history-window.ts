// news-harness — history-window: the ONE rule for how much prior conversation
// a chat turn carries.
//
// RN-free (no lib/database, lib/stores, expo, react-native, lib/logger), same
// contract as its siblings in this directory. Both chat paths call it:
// lib/hooks/useCloudPersonaChat.ts (wire messages) and lib/llm/useLocalLLM.ts
// (ConversationMessage[]), so the two engines cannot cut a conversation at two
// different lengths.
//
// WHY THIS EXISTS. Both paths used to send exactly ONE message — the current
// user turn. When the tail was [..., user("Yes")] the model received the system
// prompt, <context>, and the single word "Yes", with no trace of what it was
// agreeing to. The user-visible symptom was Mera answering a confirmation with
// "Great, good to see you again! How can I help?" — it had genuinely never seen
// the question it had just asked.
//
// WHY A TOKEN BUDGET AND NOT A MESSAGE COUNT. A turn carrying a large
// saveExtractedFacts tool result costs many times what a conversational turn
// costs, so a fixed message count bounds the wrong quantity. The caller passes
// a budget and a turn cap; this module spends the budget newest-first.
//
// WHERE THE BUDGET COMES FROM (the two paths differ, deliberately):
//   - CLOUD enforces no input budget at all, so its budget is a self-imposed
//     latency/cost cap.
//   - LOCAL hard-errors the turn ("Context too long") above a 3072-token input
//     budget, so its budget is whatever is left after the system prompt and
//     <context> — history shrinks to fit instead of failing the turn.
//
// RELATIONSHIP TO THE FILTERS LADDER (persona-agent-core.planPersonaPrompt):
// history is a rung ABOVE that ladder and yields FIRST. planPersonaPrompt does
// not measure history and must not start doing so — see the note at
// PersonaUpdateAgent.planTurn.

/** Roles this module understands. `tool` is a tool RESULT message. */
export type HistoryRole = 'user' | 'assistant' | 'tool' | 'system';

export interface HistoryWindowInput<M> {
  /** Full history, oldest first. */
  entries: readonly M[];
  /** Token budget for the window. <= 0 keeps only the current user turn. */
  budgetTokens: number;
  /** Hard cap on user turns in the window (bounds latency, and bounds how far
   *  back a stale confirmation can reach). */
  maxUserTurns: number;
  roleOf: (entry: M) => HistoryRole;
  tokensOf: (entry: M) => number;
}

/**
 * Returns the START INDEX of the largest suffix of `entries` that satisfies all
 * four invariants:
 *
 *   1. It begins on a `user` turn. Chat APIs require the first non-system
 *      message to be a user message.
 *   2. It never splits an `assistant(tool_calls)` / `tool` pair. Guaranteed by
 *      (1): a tool result always follows its assistant message, so a window
 *      that starts on a user turn can never begin partway through a pair.
 *   3. It contains at most `maxUserTurns` user turns.
 *   4. Its total token cost is within `budgetTokens`.
 *
 * The LAST user turn is always included, even when it alone exceeds the budget —
 * dropping it would send an empty turn. Returns 0 when there is no user message
 * at all (nothing to anchor on; the caller sends what it has).
 */
export function selectHistoryWindow<M>(input: HistoryWindowInput<M>): number {
  const { entries, budgetTokens, maxUserTurns, roleOf, tokensOf } = input;
  const n = entries.length;
  if (n === 0) return 0;

  // Suffix token sums: suffix[i] = cost of entries[i..n-1].
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    suffix[i] = suffix[i + 1] + Math.max(0, tokensOf(entries[i]));
  }

  // Candidate starts are exactly the `user` indices (invariant 1).
  const userIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (roleOf(entries[i]) === 'user') userIdx.push(i);
  }
  if (userIdx.length === 0) return 0;

  const lastUserIdx = userIdx[userIdx.length - 1];

  // Walk candidates newest-first and keep the EARLIEST that still fits. The
  // last user turn is the floor, so an over-budget final turn still goes out.
  let chosen = lastUserIdx;
  const maxTurns = Math.max(1, maxUserTurns);
  for (let k = userIdx.length - 1; k >= 0; k--) {
    const start = userIdx[k];
    const turns = userIdx.length - k;
    if (turns > maxTurns) break;
    if (suffix[start] > budgetTokens && start !== lastUserIdx) break;
    chosen = start;
  }
  return chosen;
}
