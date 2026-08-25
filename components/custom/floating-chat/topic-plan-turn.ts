// topic-plan-turn — WHEN a discard is allowed to make Mera reply.
//
// Extracted as a pure function for the same reason topic-plan-resolution.ts was:
// the decision is high-risk, there is no ChatSessionView test to exercise the
// effect that consumes it, and every rule below has a failure mode that is
// invisible in the UI.
//
// THE RACE THIS DISSOLVES. `handleSend` returns silently while
// `hasUnresolvedTopicPlans`, and that value is captured in a render closure. A
// turn fired straight from the card's onPress runs before React re-renders, so
// it is dropped with no error. The card therefore only ever REQUESTS (a
// monotonic nonce); the view re-evaluates this function whenever any input
// changes and fires when the gate has actually cleared.
//
// AND IT SEQUENCES "DISCARD ALL" FOR FREE. TopicPlanSaveAllRow loops
// `await discardTopicPlan(id)`; iterations 1..N-1 leave other cards unresolved,
// so they return 'wait' and only the last one fires — exactly one turn carrying
// all N notes. The gate that was the trap is the sequencer.

export type TopicPlanTurnDecision = 'fire' | 'wait' | 'drop';

export interface TopicPlanTurnInput {
  /** The nonce set by requestTopicPlanTurn, or null. */
  request: number | null;
  /** The nonce this view last fired on. */
  lastFired: number | null;
  /** Cards still awaiting an answer, of BOTH kinds. */
  unresolvedCount: number;
  isStreaming: boolean;
  /** `effectiveBlocked` — a server block or a persisted LLM block. */
  blocked: boolean;
  /** AI access is locked (free tier). */
  aiLocked: boolean;
}

export function decideTopicPlanTurn(input: TopicPlanTurnInput): TopicPlanTurnDecision {
  const { request, lastFired, unresolvedCount, isStreaming, blocked, aiLocked } = input;

  // Nothing asked, or this exact request already fired.
  if (request === null || request === lastFired) return 'wait';

  // DROP, not 'wait'. A block is not transient: parking the nonce would fire a
  // "you rejected my topics" reply days later, on unblock, into a thread the
  // user has long forgotten. The blocked banner already explains the silence.
  // The discard itself still happened — only the reply is skipped.
  if (aiLocked || blocked) return 'drop';

  // Wait for the gate to clear and the current turn to finish. Re-evaluated by
  // the consuming effect when either changes.
  if (unresolvedCount > 0 || isStreaming) return 'wait';

  return 'fire';
}
