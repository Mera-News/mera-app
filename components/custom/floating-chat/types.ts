// Floating-chat presentational contracts.
//
// These types are the shared vocabulary between the pure `deriveThreadItems`
// util, the ChatThread component, and the (parallel) data/store layer that
// feeds it. Everything here is presentational — no data fetching, no stores.

import type { ConversationMessage, StagedProposal } from '@/lib/llm/types';
import type { FactConflict } from '@/lib/news-harness/persona-management/fact-conflict';
import type { QuickFactCheckEntry } from '@/lib/stores/floating-chat-store';

// ---------------------------------------------------------------------------
// PersistedMessage
// ---------------------------------------------------------------------------
// Re-exported from the conversation service (the single source of truth) so
// existing `./types` importers keep working.
export type { PersistedMessage } from '@/lib/database/services/conversation-service';

// ---------------------------------------------------------------------------
// Thread items
// ---------------------------------------------------------------------------

export type FactCardAction = 'saved' | 'deleted' | 'updated';

// ---------------------------------------------------------------------------
// Agent steps (pagent P2)
// ---------------------------------------------------------------------------

export type AgentStepStatus = 'pending' | 'done' | 'error';

/**
 * The loop terminals that are worth a sentence on screen.
 *
 * A subset of the loop's own `terminalReason`: `settled` and `awaiting-user`
 * are ordinary, and `transport-error` already has the error banner. These four
 * are the ones where the user is otherwise left looking at a turn that appears
 * to have finished and did not.
 */
export type AgentTerminal = 'leg-cap' | 'no-route' | 'no-proposal' | 'unknown-tool';

const RENDERABLE_TERMINALS: readonly string[] = [
  'leg-cap',
  'no-route',
  'no-proposal',
  'unknown-tool',
];

/**
 * The loop's `terminalReason` narrowed to what the thread renders.
 *
 * ONE place, so a terminal added to the loop is either rendered deliberately or
 * visibly absent here, rather than silently widening a UI union. `settled` and
 * `awaiting-user` are ordinary endings, `transport-error` has the error banner,
 * and `malformed-choice` is a model fault the user cannot act on.
 */
export function renderableTerminal(reason: string | null | undefined): AgentTerminal | null {
  return reason && RENDERABLE_TERMINALS.includes(reason) ? (reason as AgentTerminal) : null;
}

/**
 * One row in the agent-steps box: a leg beginning, or one tool call.
 *
 * Derived from `ToolCallRecord.status`, which is the ONLY item kind here that
 * reads a tool call's status rather than its result. That is why it can render
 * while work is still in flight, and why `deriveThreadItems` has to push it
 * before the "empty assistant message with no cards" guard.
 *
 * `labelKey` and `consequenceKey` are plain strings, not literal unions. The
 * literals live at the ONE place they are resolved — AgentStepsBox's key
 * tables — because `t()`'s generated overloads pin the option shape per key,
 * so a union of keys cannot be passed to it. Putting the literals in the
 * `t()` calls is what makes tsc prove every key reached the dictionaries.
 */
export interface AgentStep {
  /** `${messageId}::${toolCallIndex}` for a tool, `${messageId}::leg` for a leg
   *  start. Same keying rule as `toolCallResults` — never `tc.id`, which is
   *  `local-tc-${n}` on the local engine and collides across messages. */
  id: string;
  kind: 'leg-start' | 'tool';
  toolName?: string;
  /** Resolved to text by AgentStepsBox's key table, never rendered raw. */
  labelKey: string;
  labelValues?: Record<string, string>;
  status: AgentStepStatus;
  /** On an errored step: what the failure COST the user, never the raw error. */
  consequenceKey?: string;
}

export type ChatThreadItem =
  // Pinned article card at the TOP of an article-suggestion chat thread — the
  // subject of the conversation, always the first item (Round-4 P4 handoff).
  | {
      kind: 'article-context-card';
      key: string;
      articleId?: string;
      suggestionId?: string;
      title: string;
    }
  | {
      kind: 'message';
      key: string;
      message: ConversationMessage;
      pending?: boolean;
      /** The live assistant message currently streaming: keeps the Mera mark
       *  in the left gutter until the turn settles. */
      streaming?: boolean;
    }
  | {
      kind: 'fact-card';
      key: string;
      action: FactCardAction;
      statements: string[];
      factIds: string[];
    }
  | { kind: 'proposal-card'; key: string; proposal: StagedProposal }
  // Round-4 C5 — pinned interactive daily-optimisation-plan card at the top of an
  // `optimisation-plan` chat thread. Loads the pending plan from the service.
  | { kind: 'optimisation-plan-card'; key: string }
  // Wave 11 U-B2 — in-chat topic-planning widget for one saved fact. Subscribes
  // to the fact's live topic rows (observeByFact) inside the component.
  | { kind: 'topic-plan-card'; key: string; factId: string; factStatement: string }
  /**
   * Readings Mera is OFFERING for one extracted fact, awaiting a tap. Nothing
   * has been written when this renders — that is the whole point of it.
   * `resultKey` is `${messageId}::${toolCallIndex}`, the key the commit writes
   * its resolution under.
   *
   * ONE CARD PER EXTRACTED FACT, and resolving one never touches a sibling:
   * `groupId` addresses this group's own slot inside the shared tool result. Do
   * NOT reintroduce a card that keys off the result as a whole — that is the
   * exact shape that used to delete every sibling group on the first tap.
   */
  | {
      kind: 'fact-choice-card';
      key: string;
      resultKey: string;
      /**
       * The tool call's own staged result.
       *
       * Required by the commit: the store holds OVERRIDES ONLY, so on the first
       * tap of a turn there is nothing at `resultKey` and the merge has no spine
       * to preserve. Threading the staged blob down is what keeps the first
       * resolution identical to every later one.
       */
      baseResult: Record<string, unknown>;
      groupIndex: number;
      /** Stable per-group identity — never the rendered array position. */
      groupId: string;
      options: string[];
      questionnaireAttribute: string | null;
      /**
       * The existing fact this reading would REPLACE, or null to add.
       *
       * A replacement destroys the old fact and every topic it owns, in one
       * transaction, with no inverse. The card must therefore name what would
       * go BEFORE the tap, and its accept stays disabled until it can.
       */
      replacesFactId: string | null;
      /** Set once the user skipped this group: renders the "Not saved" line
       *  with Undo, in place, instead of the readings. */
      dismissed: boolean;
      /** Derived from an earlier conversation: inert, and not counted by the gate. */
      stale: boolean;
    }
  /**
   * "Add all (N)" / "Skip all" for one message's pending fact-choice group.
   *
   * Emitted INLINE, directly after the last pending card of its group, because
   * the group belongs to one message — unlike TopicPlanSaveAllRow, which is
   * thread-wide and therefore lives as fixed chrome above the composer.
   * Rendered only while 2+ groups are pending; at 1 the card's own buttons are
   * the sole affordance.
   */
  | {
      kind: 'fact-choice-bulk-row';
      key: string;
      resultKey: string;
      /** The tool call's own staged result — see `fact-choice-card`. */
      baseResult: Record<string, unknown>;
      groups: {
        groupId: string;
        groupIndex: number;
        options: string[];
        questionnaireAttribute: string | null;
      }[];
    }
  /**
   * Topics minted for facts accepted IN CHAT, shown as removable chips.
   *
   * Distinct from `topic-plan-card` on purpose: these topics are already SAVED
   * when the card appears (topic generation mints the rows), so the card
   * confirms rather than asks. It carries no Save/Discard pair and — critically
   * — it is NOT counted by the topic-plan composer gate. The composer is
   * blocked only while a FACT card is pending.
   *
   * ONE CARD PER FACT, including under "Add all". Collapsed, each is a single
   * line, so four accepted facts are four lines rather than the chip wall the
   * old merged card existed to prevent — and a per-fact status cannot be shown
   * in a header covering four facts with four different statuses.
   */
  | {
      kind: 'chat-topics-card';
      key: string;
      factId: string;
      factStatement: string;
    }
  // Wave 11 U-B1 — save-time fact-conflict resolution card.
  | { kind: 'conflict-card'; key: string; conflict: FactConflict }
  // pivot P8c — the QUICK fact check the user started by tapping a claim pill,
  // answered in the thread. Injected from the floating-chat store (like the
  // optimisation plan) rather than derived from a tool call: no model turn
  // produces it, and it is deliberately never persisted.
  | { kind: 'quick-fact-check-card'; key: string; entry: QuickFactCheckEntry }
  /**
   * What the agent is doing, for ONE TURN — not one message.
   *
   * A turn is several legs (several assistant messages), and a box per leg
   * would flicker in and out as each one settles. Keyed to the turn, the box is
   * emitted once, accumulates every leg's rows, and collapses once at the end.
   *
   * `collapsed` derives from STATUS (every step settled), never from whether
   * the assistant has started writing: the cloud loop streams a leg's text
   * BEFORE its tools run, so a content-based rule would collapse the box
   * before any row had been seen.
   */
  | {
      kind: 'agent-steps';
      key: string;
      steps: AgentStep[];
      collapsed: boolean;
      doneCount: number;
      failedCount: number;
      /**
       * WHY the loop stopped, when that is something the user must be told.
       *
       * Replaces a `legCapped` boolean that was hardcoded false at the one place
       * that built this item, so the cap sentence was dead code and `no-route`,
       * `no-proposal` and `unknown-tool` had no rendering at all. Null for a
       * turn that settled normally, and for every turn but the latest: the
       * store holds one terminal.
       */
      terminal: AgentTerminal | null;
      /** The turn ended without settling (backgrounded, transport failure). */
      interrupted: boolean;
      /** Turn touched persona data, so its settled line is kept in scroll-back. */
      changedData: boolean;
    }
  /**
   * 2 or 3 tap chips from an `ask_choice` call.
   *
   * An OFFER, never a modal gate: the composer stays live, so typing past it
   * is always possible. A tap sends the option text VERBATIM as the user's
   * next message, and P1's loop reads the structured payload off the turn
   * state — which is why this card must never write or clear that state.
   */
  | {
      kind: 'ask-choice-card';
      key: string;
      /** Rendered only when the parent bubble has no text of its own: the
       *  model often writes the question as prose AND calls the tool. */
      question: string | null;
      options: string[];
      /** A later user message exists, so the offer is spent. Rendered inert
       *  rather than removed, so the thread keeps what was offered. */
      answered: boolean;
    }
  | { kind: 'divider'; key: string; label: string }
  | { kind: 'typing'; key: string };

// ---------------------------------------------------------------------------
// Starter chips
// ---------------------------------------------------------------------------

export interface StarterChip {
  key: string;
  label: string;
  message: string;
}

// ---------------------------------------------------------------------------
// ChatThread props
// ---------------------------------------------------------------------------

export interface ChatThreadProps {
  /** Thread items, newest LAST. ChatThread inverts internally for rendering. */
  items: ChatThreadItem[];
  isStreaming: boolean;
  onLoadOlder: () => void;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  /**
   * When true, show a "View previous messages" pill that reveals older history
   * on tap. Gated so a fresh conversation starts visually clean; once revealed,
   * the normal scroll-up paging (onLoadOlder/hasOlder) takes over.
   */
  showHistoryButton: boolean;
  onRevealHistory: () => void;
  /** Shown only when items contain no user/assistant messages. */
  starterChips: StarterChip[];
  onChipPress: (message: string) => void;
  /** When set, show a banner. Does NOT by itself disable the input — see
   *  `bannerBlocksInput`. */
  blockedMessage: string | null;
  /**
   * Whether the banner's cause also blocks sending.
   *
   * These are three different situations wearing one banner, and only two of
   * them may gate the composer:
   *   - a server block, and the topic-plan gate: yes, blocking is the point;
   *   - a TRANSPORT ERROR: no. Its own copy says "try again in a moment",
   *     and the error is cleared by starting a turn — so disabling the input
   *     removed the only way out of the state and left the composer dead for
   *     the rest of the session.
   */
  bannerBlocksInput: boolean;
  /**
   * True when the block is a server-authoritative LLM block (not a transient
   * inference error) — gates the unblock-request controls beside the banner.
   */
  showUnblockControls: boolean;
  /** True once an unblock request is PENDING review — swaps the CTA for a
   * disabled "pending" label plus a refresh button. */
  unblockPending: boolean;
  /** Opens the RequestUnblockModal. */
  onRequestUnblock: () => void;
  /** Re-fetches persona to learn whether staff have lifted the block. */
  onRefreshBlockStatus: () => void;
  isRefreshingBlockStatus: boolean;
  onSend: (text: string) => void;
  isInputDisabled: boolean;
}
