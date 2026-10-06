// openMeraChat: open the Mera chat on a context, optionally with text waiting
// in the composer. A draft is never sent: the reader edits it and taps Send,
// so a starter costs no model call (owner ruling, navx). Use
// `openArticleFeedback` only where a turn really must be auto-sent.

import { useFloatingChatStore, type ChatContext } from '@/lib/stores/floating-chat-store';

export function openMeraChat(context: ChatContext, opts: { draft?: string } = {}): void {
  useFloatingChatStore.getState().expand(context, opts);
}
