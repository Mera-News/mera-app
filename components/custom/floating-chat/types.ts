// Floating-chat presentational contracts.
//
// These types are the shared vocabulary between the pure `deriveThreadItems`
// util, the ChatThread component, and the (parallel) data/store layer that
// feeds it. Everything here is presentational — no data fetching, no stores.

import type { ConversationMessage } from '@/lib/llm/types';

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
  /** Shown only when items contain no user/assistant messages. */
  starterChips: StarterChip[];
  onChipPress: (message: string) => void;
  /** When set, show a banner and disable input. */
  blockedMessage: string | null;
  onSend: (text: string) => void;
  isInputDisabled: boolean;
}
