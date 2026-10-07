// Which live chat messages are ready to be written to the `messages` table.
// Pure: the chat session claims the returned ids and does the writes.
//
// - A USER message is written once, as soon as it appears. A hidden turn is
//   never written, only claimed.
// - An ASSISTANT message is written only when FINALISED: the turn's text has
//   stopped (`status` idle) or a newer message follows it, AND none of its
//   tool calls is still pending, so the stored calls carry their results.
// - An empty assistant placeholder with no tool calls is claimed, never
//   written.

import type { ConversationMessage } from '@/lib/llm/types';

export interface PersistPlan {
    /** Ids to mark as handled, written or not. */
    readonly claim: string[];
    /** Messages to write, in thread order. */
    readonly write: ConversationMessage[];
}

export function toPersist(
    messages: readonly ConversationMessage[],
    status: 'idle' | 'streaming',
    persisted: ReadonlySet<string>,
): PersistPlan {
    const claim: string[] = [];
    const write: ConversationMessage[] = [];
    messages.forEach((message, index) => {
        if (persisted.has(message.id)) return;
        if (message.role === 'assistant') {
            const superseded = index < messages.length - 1;
            if (status !== 'idle' && !superseded) return;
            if ((message.toolCalls ?? []).some((tc) => tc.status === 'pending')) return;
            claim.push(message.id);
            const empty = message.content.trim().length === 0 && (message.toolCalls ?? []).length === 0;
            if (!empty) write.push(message);
            return;
        }
        claim.push(message.id);
        if (!message.hidden) write.push(message);
    });
    return { claim, write };
}
