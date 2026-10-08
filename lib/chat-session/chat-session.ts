// THE CHAT SESSION: the one live chat engine in this JS process, and the
// whole-turn lifecycle around it. No component owns any of it, so closing the
// chat, switching tabs or remounting the view never ends a turn.
//
// The view (CloudPersonaChat / LocalPersonaChat -> ChatSessionView) only
// attaches, reads the stores and passes input in. The session:
// - keeps the engine for a conversation until a different one attaches;
// - holds `holdRestart('chat-stream')` for exactly as long as a turn is busy,
//   so an OTA restart can never land mid-turn (the ONE acquire and the ONE
//   release are in `sync`);
// - mirrors that busy flag to floating-chat-store (`setGenerating`), which
//   also derives the memory-only unread flag for the Mera button;
// - writes finished messages to the `messages` table (`toPersist`).
//
// BUSY IS THE WHOLE TURN on either engine, never `status`: both engines keep
// doing real work (the cloud forced-extraction pass, on-device tool
// execution) after their text has stopped.

import { holdRestart } from '@/lib/app-restart';
import type { ConversationMessage, IAgent } from '@/lib/llm/types';
import logger from '@/lib/logger';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import type { ChatEngine } from './engine';
import { resetLocalChat, useLocalChatStore } from './local-chat-store';
import { toPersist } from './persist';

export type EngineKind = 'cloud' | 'local';

interface Live {
    readonly conversationId: string;
    readonly kind: EngineKind;
    readonly engine: ChatEngine;
    readonly persisted: Set<string>;
}

let live: Live | null = null;
let release: (() => void) | null = null;
let wired = false;

/** Engine factories, required lazily: they pull in the inference stack. */
function createEngine(kind: EngineKind, agent: IAgent): ChatEngine {
    if (kind === 'cloud') {
        const { createCloudEngine } =
            require('@/lib/hooks/useCloudPersonaChat') as typeof import('@/lib/hooks/useCloudPersonaChat');
        return createCloudEngine(agent);
    }
    const { createLocalEngine } = require('@/lib/llm/useLocalLLM') as typeof import('@/lib/llm/useLocalLLM');
    return createLocalEngine(agent);
}

function busyNow(): boolean {
    const cloud = useCloudChatStore.getState();
    const local = useLocalChatStore.getState();
    return (
        cloud.status === 'streaming' ||
        cloud.agentTurnState?.turnActive === true ||
        local.status === 'streaming' ||
        local.turnBusy
    );
}

function write(conversationId: string, message: ConversationMessage): void {
    const { appendMessage } =
        require('@/lib/database/services/conversation-service') as typeof import('@/lib/database/services/conversation-service');
    const fail = (error: unknown) =>
        logger.error('[ChatSession] failed to persist a message', { role: message.role, error: String(error) });
    if (message.role !== 'assistant') {
        appendMessage(conversationId, { role: 'user', content: message.content }, message.id).catch(fail);
        return;
    }
    // A tool-result override recorded before this row existed (a fast tap on
    // a fact card) is merged in here; `patchMessageToolCallResult` is the
    // other half, for taps after the row exists.
    const overrides = useFloatingChatStore.getState().toolCallResults;
    const toolCalls = (message.toolCalls ?? []).map((tc, idx) => {
        const override = overrides[`${message.id}::${idx}`];
        return override ? { ...tc, result: override, status: 'done' as const } : tc;
    });
    appendMessage(
        conversationId,
        { role: 'assistant', content: message.content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined },
        message.id,
    ).catch(fail);
}

function persist(): void {
    if (!live) return;
    const state = live.kind === 'cloud' ? useCloudChatStore.getState() : useLocalChatStore.getState();
    const plan = toPersist(state.messages, state.status, live.persisted);
    for (const id of plan.claim) live.persisted.add(id);
    for (const message of plan.write) write(live.conversationId, message);
}

function sync(): void {
    const busy = busyNow();
    if (busy && !release) release = holdRestart('chat-stream');
    if (!busy && release) {
        release();
        release = null;
    }
    if (useFloatingChatStore.getState().isGenerating !== busy) {
        useFloatingChatStore.getState().setGenerating(busy);
    }
    persist();
}

function wire(): void {
    if (wired) return;
    wired = true;
    useCloudChatStore.subscribe(sync);
    useLocalChatStore.subscribe(sync);
}

export interface AttachOptions {
    readonly conversationId: string;
    readonly kind: EngineKind;
    readonly agent: IAgent;
    /** Ids already in the `messages` table for this conversation. */
    readonly persistedIds: readonly string[];
}

/**
 * The engine for this conversation: the live one when it matches, else a new
 * one. Never called during render: the view attaches from an effect and from
 * its send. The thread itself is emptied by `resetChatSession` when a
 * conversation is created, not here.
 */
export function attachChatSession(opts: AttachOptions): ChatEngine {
    wire();
    if (live && live.conversationId === opts.conversationId && live.kind === opts.kind) {
        live.engine.setAgent(opts.agent);
        for (const id of opts.persistedIds) live.persisted.add(id);
        return live.engine;
    }
    live?.engine.dispose();
    live = {
        conversationId: opts.conversationId,
        kind: opts.kind,
        engine: createEngine(opts.kind, opts.agent),
        persisted: new Set(opts.persistedIds),
    };
    sync();
    return live.engine;
}

/**
 * THE STOP BUTTON. Aborts whatever the live engine is doing: the stream, the
 * agent loop's next leg, any tool not yet started, the forced pass, a queued
 * hidden turn. A no-op when nothing is busy. The engine settles itself (busy
 * clears through its own store, which `sync` mirrors), so the composer is ready
 * at once and no "answer ready" ring is left behind.
 */
export function stopChatTurn(): void {
    if (!live || !busyNow()) return;
    live.engine.stop();
}

/**
 * A fresh thread: no engine and empty stores. MeraChatSession calls it when it
 * creates a conversation (launch, New chat, a context switch); clearAllStores
 * calls it on an account switch. With the stores idle the hold is released.
 */
export function resetChatSession(): void {
    live?.engine.dispose();
    live = null;
    resetLocalChat();
    useCloudChatStore.getState().reset();
    release?.();
    release = null;
}
