// A chat turn in flight, on disk. A kill leaves the row behind, and the next
// process turns it into a Retry. The reply itself is out of reach by then: the
// turn's key is memory-only (e2ee-service), so whatever the gateway stored for
// it can no longer be decrypted, and keys are deliberately not persisted.
//
// The text is what the `messages` table already holds. `settings` rows are
// backed up only from an allowlist, and this key is not on it.

import { deleteMessage } from '@/lib/database/services/conversation-service';
import { deleteSetting, getSetting, setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { useFloatingChatStore, type ChatContext } from '@/lib/stores/floating-chat-store';

const KEY = 'chat_turn_inflight';

/** Tells a dead process's row from this one's, which a recovery run may overlap. */
const newProcessId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let processId = newProcessId();

const warn = (error: unknown) => logger.warn('[ChatSession] turn row write failed', { error: String(error) });

export function markTurnInflight(text: string, contextKind: ChatContext['kind'], messageId: string): void {
    setSetting(KEY, JSON.stringify({ processId, text, contextKind, messageId })).catch(warn);
}

export function clearTurnInflight(): void {
    deleteSetting(KEY).catch(warn);
}

/** `inference-recover`: a row from another process is a turn a kill ended. */
export async function recoverInterruptedTurn(): Promise<boolean> {
    const raw = await getSetting(KEY);
    if (!raw) return false;
    let row: { processId?: string; text?: string; contextKind?: ChatContext['kind']; messageId?: string };
    try {
        row = JSON.parse(raw);
    } catch {
        row = {};
    }
    if (row.processId === processId) return false;
    await deleteSetting(KEY);
    if (!row.text || !row.contextKind) return false;
    useFloatingChatStore.getState().setInterruptedTurn({
        text: row.text,
        contextKind: row.contextKind,
        messageId: row.messageId,
    });
    return true;
}

/** Retry after a kill sent the message in a new conversation, so the old
 *  conversation's copy goes: history then holds it once. */
export function deleteInterruptedMessage(id: string): void {
    deleteMessage(id).catch(warn);
}

/** Test seam: what a kill does to this module. */
export function __startNewProcessForTests(): void {
    processId = newProcessId();
}
