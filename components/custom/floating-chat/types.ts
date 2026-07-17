// Floating-chat presentational contracts.
//
// These types are the shared vocabulary between the pure `deriveThreadItems`
// util, the ChatThread component, and the (parallel) data/store layer that
// feeds it. Everything here is presentational — no data fetching, no stores.

import type { ConversationMessage, StagedProposal } from '@/lib/llm/types';
import type { FactConflict } from '@/lib/news-harness/persona-management/fact-conflict';

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

export type ChatThreadItem =
  | { kind: 'message'; key: string; message: ConversationMessage; pending?: boolean }
  | {
      kind: 'fact-card';
      key: string;
      action: FactCardAction;
      statements: string[];
      factIds: string[];
    }
  | { kind: 'proposal-card'; key: string; proposal: StagedProposal }
  // Wave 11 U-B2 — in-chat topic-planning widget for one saved fact. Subscribes
  // to the fact's live topic rows (observeByFact) inside the component.
  | { kind: 'topic-plan-card'; key: string; factId: string; factStatement: string }
  // Wave 11 U-B1 — save-time fact-conflict resolution card.
  | { kind: 'conflict-card'; key: string; conflict: FactConflict }
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
  /** When set, show a banner and disable input. */
  blockedMessage: string | null;
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
