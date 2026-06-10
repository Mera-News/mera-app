// useCloudPersonaChat — cloud chat hook for persona update.
// Single-shot: streams one SSE response from backend proxy, executes
// tools locally via agent.executeTool(). No re-send loop — mirrors local LLM flow.
// State is stored in Zustand (cloud-chat-store) so it survives component remounts.

import { useCallback, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import logger from '../logger';
import { cloudChatStream, type WireMessage } from '../llm/cloudComplete';
import { BIG_MODEL } from '../llm/constants';
import type { ConversationMessage, IAgent, ToolCallRecord, ToolDefinition } from '../llm/types';
import { useCloudChatStore } from '../stores/cloud-chat-store';

const TAG = '[CloudChat]';

// Cloud chat sends ONLY the current user turn (plus any assistant/tool tail
// from a continuation pass — the expand-backward loop in streamOne keeps that
// pair intact). Fresh facts are re-loaded from the `facts` table each turn via
// buildContext() and prepended to the user message, so the LLM cannot
// hallucinate persisted state from prior assistant claims like "Got it, saved".
const MAX_HISTORY_MESSAGES = 1;

export interface UseCloudPersonaChatResult {
  messages: ConversationMessage[];
  status: 'idle' | 'streaming';
  sendMessage: (text: string) => void;
  latestAssistantContent: string;
  isBlocked: boolean;
  blockedReason: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Accumulate tool-call deltas by index into complete tool calls
// ---------------------------------------------------------------------------

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

function finalizeToolCalls(accumulators: Map<number, ToolCallAccumulator>): Array<{ id: string; name: string; input: unknown }> {
  const results: Array<{ id: string; name: string; input: unknown }> = [];
  for (const [, acc] of accumulators) {
    if (!acc.name) continue;
    try {
      const input = acc.arguments ? JSON.parse(acc.arguments) : {};
      results.push({ id: acc.id, name: acc.name, input });
    } catch {
      logger.warn(`${TAG} Failed to parse tool call arguments`, { name: acc.name, args: acc.arguments });
      results.push({ id: acc.id, name: acc.name, input: {} });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCloudPersonaChat(agent: IAgent): UseCloudPersonaChatResult {
  // Read state from Zustand store (survives remounts)
  const { messages, status, isBlocked, blockedReason, error } = useCloudChatStore(
    useShallow((s) => ({
      messages: s.messages,
      status: s.status,
      isBlocked: s.isBlocked,
      blockedReason: s.blockedReason,
      error: s.error,
    })),
  );

  const isStreamingRef = useRef(false);
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const runSingleShot = useCallback(
    async (
      systemPrompt: string,
      tools: ToolDefinition[],
      assistantId: string,
      context: string,
    ): Promise<void> => {
      const store = useCloudChatStore.getState();
      logger.debug(`${TAG} runSingleShot ENTER`, { tools: tools.length, wireMessages: store.wireMessages.length });

      // Stream one assistant turn into the bubble identified by `targetId`.
      // `includeContext` re-injects fresh context onto the last user message
      // for the first turn only — on a continuation turn the wire already ends
      // with tool results and context was already injected on the prior call.
      const streamOne = async (
        targetId: string,
        includeContext: boolean,
        toolChoice: 'required' | 'auto' = 'required',
      ): Promise<{ accContent: string; toolCalls: ReturnType<typeof finalizeToolCalls> }> => {
        let accContent = '';
        const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

        // Window wireMessages to just the current user turn (MAX_HISTORY_MESSAGES = 1),
        // then expand backward so the window (a) starts with a user turn (LLM APIs
        // require it) and (b) never splits an assistant tool_calls / tool result pair.
        // The continuation pass (after a tool call) lands here with the tail
        // [user, assistant(tool_calls), tool] — the expand loop preserves it intact.
        const allWire = useCloudChatStore.getState().wireMessages;
        let startIdx = Math.max(0, allWire.length - MAX_HISTORY_MESSAGES);
        while (startIdx > 0) {
          const head = allWire[startIdx];
          const prev = allWire[startIdx - 1];
          if (head.role === 'user') break;
          if (head.role === 'tool' && prev.role === 'assistant') {
            startIdx -= 1;
            continue;
          }
          startIdx -= 1;
        }
        let windowed: WireMessage[] = allWire.slice(startIdx);
        if (includeContext && context) {
          const lastUserIdx = windowed.map((m) => m.role).lastIndexOf('user');
          if (lastUserIdx >= 0) {
            const last = windowed[lastUserIdx] as Extract<WireMessage, { role: 'user' }>;
            windowed = [
              ...windowed.slice(0, lastUserIdx),
              { role: 'user', content: `${context}\n\n${last.content}` },
              ...windowed.slice(lastUserIdx + 1),
            ];
          }
        }
        logger.debug(`${TAG} wire window`, { total: allWire.length, sent: windowed.length });

        const stream = cloudChatStream({
          messages: [{ role: 'system', content: systemPrompt }, ...windowed],
          tools,
          toolChoice,
          model: BIG_MODEL,
          maxTokens: 300,
        });

        let eventCount = 0;
        for await (const event of stream) {
          eventCount++;
          if (eventCount <= 5 || event.type === 'finish' || event.type === 'error') {
            logger.debug(`${TAG} SSE event #${eventCount}`, {
              type: event.type,
              ...(event.type === 'text-delta' ? { delta: event.delta.slice(0, 50) } : {}),
              ...(event.type === 'tool-call-delta' ? { name: event.name } : {}),
            });
          }
          if (event.type === 'text-delta') {
            accContent += event.delta;
            useCloudChatStore.getState().setMessages((prev) =>
              prev.map((m) => m.id === targetId ? { ...m, content: accContent } : m),
            );
          } else if (event.type === 'tool-call-delta') {
            // The model may send multiple tool calls with the same index (or all index 0).
            // Detect collision: if a NEW name arrives at an existing index, assign a new key.
            const existingAcc = toolCallAccumulators.get(event.index);
            const key =
              existingAcc && event.name && existingAcc.name && event.name !== existingAcc.name
                ? Math.max(...toolCallAccumulators.keys()) + 1
                : event.index;

            let acc = toolCallAccumulators.get(key);
            if (!acc) {
              acc = { id: event.id ?? `tc-${key}`, name: event.name ?? '', arguments: '' };
              toolCallAccumulators.set(key, acc);
            }
            if (event.id) acc.id = event.id;
            if (event.name) acc.name = event.name;
            acc.arguments += event.argumentsDelta;
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
        }
        logger.debug(`${TAG} stream ended`, { totalEvents: eventCount, contentLength: accContent.length, toolCalls: toolCallAccumulators.size });

        const toolCalls = finalizeToolCalls(toolCallAccumulators);
        logger.debug(`${TAG} finalized tool calls`, {
          calls: toolCalls.map(tc => ({ name: tc.name, input: tc.input })),
        });
        return { accContent, toolCalls };
      };

      // Push the assistant turn into wire history with tool_calls preserved.
      const pushAssistantToWire = (
        accContent: string,
        toolCalls: ReturnType<typeof finalizeToolCalls>,
      ) => {
        const wireToolCalls = toolCalls.length > 0
          ? toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
            }))
          : undefined;
        useCloudChatStore.getState().pushWireMessage(
          wireToolCalls
            ? { role: 'assistant', content: accContent, tool_calls: wireToolCalls }
            : { role: 'assistant', content: accContent },
        );
      };

      // Execute tool calls in parallel, render results into the bubble, and
      // push tool result messages onto wire (preserving order).
      const executeToolsAndPushResults = async (
        targetId: string,
        toolCalls: ReturnType<typeof finalizeToolCalls>,
      ) => {
        const toolCallRecords: ToolCallRecord[] = toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
          status: 'pending' as const,
        }));
        useCloudChatStore.getState().setMessages((prev) =>
          prev.map((m) => m.id === targetId ? { ...m, toolCalls: toolCallRecords } : m),
        );

        const results = await Promise.all(
          toolCalls.map(async (tc, i) => {
            try {
              logger.debug(`${TAG} executing tool`, { name: tc.name, inputKeys: Object.keys(tc.input as Record<string, unknown>) });
              const { result, sideEffects } = await agentRef.current.executeTool(tc.name, tc.input);
              logger.debug(`${TAG} tool result`, { name: tc.name, result: JSON.stringify(result).slice(0, 200), sideEffects });

              if (sideEffects?.blocked) {
                useCloudChatStore.getState().setIsBlocked(true);
                useCloudChatStore.getState().setBlockedReason(sideEffects.blocked.reason);
              }

              return { index: i, result, status: 'done' as const };
            } catch (err) {
              logger.error(`${TAG} Tool execution failed`, undefined, { tool: tc.name, error: String(err) });
              return { index: i, result: { error: String(err) }, status: 'error' as const };
            }
          }),
        );

        for (const r of results) {
          toolCallRecords[r.index].result = r.result;
          toolCallRecords[r.index].status = r.status;
        }
        useCloudChatStore.getState().setMessages((prev) =>
          prev.map((m) => m.id === targetId ? { ...m, toolCalls: [...toolCallRecords] } : m),
        );

        for (const tc of toolCalls) {
          const matched = toolCallRecords.find((r) => r.id === tc.id);
          const resultPayload = matched?.result ?? { error: 'no result' };
          useCloudChatStore.getState().pushWireMessage({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(resultPayload),
          });
        }
      };

      // ---------- First pass ----------
      const placeholder: ConversationMessage = { id: assistantId, role: 'assistant', content: '' };
      useCloudChatStore.getState().setMessages((prev) => [...prev, placeholder]);

      const first = await streamOne(assistantId, true);
      pushAssistantToWire(first.accContent, first.toolCalls);

      if (first.toolCalls.length === 0) return;

      await executeToolsAndPushResults(assistantId, first.toolCalls);

      // ---------- Continuation pass ----------
      // When the model returns tool calls but no conversational text, post the
      // tool results back and let it produce a real reply in a fresh bubble.
      // Capped at one continuation — if the second turn also drops text, leave
      // the bubble blank rather than looping.
      if (first.accContent.trim() !== '') return;

      const followUpId = `asst-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      logger.debug(`${TAG} no text from LLM, sending follow-up turn`, {
        wireMessages: useCloudChatStore.getState().wireMessages.length,
      });
      const followUpPlaceholder: ConversationMessage = { id: followUpId, role: 'assistant', content: '' };
      useCloudChatStore.getState().setMessages((prev) => [...prev, followUpPlaceholder]);

      const second = await streamOne(followUpId, true, 'auto');
      pushAssistantToWire(second.accContent, second.toolCalls);
      if (second.toolCalls.length > 0) {
        await executeToolsAndPushResults(followUpId, second.toolCalls);
      }
    },
    [],
  );

  const sendMessage = useCallback(
    (text: string) => {
      const store = useCloudChatStore.getState();
      logger.debug(`${TAG} sendMessage`, { text, isStreaming: isStreamingRef.current, isBlocked: store.isBlocked });
      if (isStreamingRef.current || store.isBlocked) {
        logger.debug(`${TAG} sendMessage BLOCKED`, { isStreaming: isStreamingRef.current, isBlocked: store.isBlocked });
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) return;

      logger.debug(`${TAG} sendMessage proceeding`, { text: trimmed });
      store.setError(null);

      const userMsg: ConversationMessage = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: 'user',
        content: trimmed,
      };
      store.setMessages((prev) => [...prev, userMsg]);

      isStreamingRef.current = true;
      store.setStatus('streaming');

      const assistantId = `asst-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      void (async () => {
        try {
          const systemPrompt = await agentRef.current.buildSystemPrompt(false);
          logger.debug(`${TAG} system prompt built`, { length: systemPrompt.length });
          logger.debug(`${TAG} system prompt content`, { content: systemPrompt });

          const tools = agentRef.current.getToolDefinitions?.() ?? [];
          logger.debug(`${TAG} tool definitions`, { count: tools.length, names: tools.map(t => t.function.name) });

          let context = '';
          if (agentRef.current.buildContext) {
            try {
              context = await agentRef.current.buildContext();
              logger.debug(`${TAG} context built`, { length: context.length });
              logger.debug(`${TAG} context content`, { content: context });
            } catch (err) {
              logger.warn(`${TAG} buildContext failed, proceeding without context`, { error: String(err) });
            }
          }

          // Push only the RAW user text into wireMessages. Context is re-injected
          // fresh onto the last user message in runSingleShot — never persisted,
          // so multi-turn chats don't accumulate N copies of the facts/guide block.
          useCloudChatStore.getState().pushWireMessage({ role: 'user', content: trimmed });
          logger.debug(`${TAG} starting runSingleShot`, { wireMessages: useCloudChatStore.getState().wireMessages.length });

          await runSingleShot(systemPrompt, tools, assistantId, context);
          logger.debug(`${TAG} runSingleShot completed`);
        } catch (err) {
          const msg = `Cloud chat failed: ${(err as Error)?.message ?? String(err)}`;
          logger.error(`${TAG} sendMessage failed`, err, { stack: (err as Error)?.stack });
          useCloudChatStore.getState().setError(msg);
        } finally {
          logger.debug(`${TAG} sendMessage done, setting idle`);
          useCloudChatStore.getState().setStatus('idle');
          isStreamingRef.current = false;
        }
      })();
    },
    [runSingleShot],
  );

  const latestAssistantContent = (() => {
    // Skip empty assistant placeholders (e.g. from tool-call rounds that returned no text)
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.length > 0);
    if (!lastAssistant) return '';
    // Strip "Options: [...]" that the model sometimes echoes in text despite prompt instructions
    return lastAssistant.content.replace(/\n?\s*Options:\s*\[.*?\]\s*/gs, '').trim();
  })();

  return {
    messages,
    status,
    sendMessage,
    latestAssistantContent,
    isBlocked,
    blockedReason,
    error,
  };
}
