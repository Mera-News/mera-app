// useLocalLLM — on-device chat hook for persona update (local path).
// Direct llama.rn inference via inferStream. No engine abstraction.
// One-shot only: no tool-call loop, no retry, ephemeral conversations.

import { useCallback, useRef, useState } from 'react';
import { getModelState, inferStream, initBaseModel } from '../mera-protocol-toolkit';
import { inferenceQueue } from '../inference/InferenceQueue';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import logger from '../logger';
import type { ConversationMessage, IAgent, ToolCallRecord } from './types';
import { estimateTokens } from './tokens';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Local LLM sends ONLY the current user turn — matches the cloud path. Fresh
// facts are re-loaded from the `facts` table each turn via buildContext() and
// prepended to the user message, so the LLM cannot hallucinate persisted state
// from prior assistant claims like "Got it, saved".
const MAX_HISTORY_MESSAGES = 1;
const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';
const TOTAL_TOKEN_LIMIT = 4096;
const MAX_OUTPUT_TOKENS = 1024;
const INPUT_TOKEN_BUDGET = TOTAL_TOKEN_LIMIT - MAX_OUTPUT_TOKENS; // 3072

const TAG = '[LocalLLM]';

const KNOWN_TOOLS = new Set([
  'saveExtractedFacts',
  'saveExtractedsFacts', // common LLM misspelling
  'updateUserConfig',
  'deleteUserFacts',
  'advanceQuestionnaireLevel',
  'issueWarning',
  'runCalibration',
  // Article-feedback agent — proposal confirm flow.
  'proposeChanges',
  'proposeTrack',
  'applyProposal',
  'cancelProposal',
]);

// Module-level counter ensures unique tool call IDs across all inference runs.
let toolCallCounter = 0;

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type LocalLLMStatus = 'idle' | 'streaming';

type InferenceEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'finish'; reason: 'stop' | 'error' }
  | { type: 'error'; message: string };

export interface UseLocalLLMResult {
  messages: ConversationMessage[];
  status: LocalLLMStatus;
  sendMessage: (text: string) => void;
  latestAssistantContent: string;
  isBlocked: boolean;
  blockedReason: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Helper functions (absorbed from LocalInferenceEngine)
// ---------------------------------------------------------------------------

/**
 * Converts ConversationMessage[] to a formatted prompt string for local LLM.
 * Slices to MAX_HISTORY_MESSAGES (= 1, just the current user turn), guarantees
 * the first message is a user turn, and prepends fresh `context` (from
 * buildContext) onto that last user message.
 */
function buildPromptFromMessages(
  messages: ConversationMessage[],
  context?: string,
): string {
  let limited = messages.slice(-MAX_HISTORY_MESSAGES);
  if (limited[0]?.role !== 'user') {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) limited = [lastUser, ...limited];
  }

  let lastUserIdx = -1;
  for (let i = limited.length - 1; i >= 0; i--) {
    if (limited[i].role === 'user') { lastUserIdx = i; break; }
  }

  const parts: string[] = [];
  for (let i = 0; i < limited.length; i++) {
    const msg = limited[i];
    if (msg.role === 'user') {
      const content = (i === lastUserIdx && context) ? `${context}\n\n${msg.content}` : msg.content;
      parts.push(`User: ${content}`);
    } else {
      let text = `Assistant: ${msg.content}`;
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          text += `\n<tool_call>${JSON.stringify({ name: tc.name, arguments: tc.input ?? {} })}</tool_call>`;
        }
      }
      parts.push(text);
    }
  }

  return parts.join('\n\n');
}

/**
 * Processes a streaming token buffer.
 * Emits text-delta events for visible text and tool-call events for parsed <tool_call> blocks.
 */
function flushBuffer(
  buffer: string,
  insideToolCall: boolean,
  toolCallBuffer: string,
): {
  remaining: string;
  insideToolCall: boolean;
  toolCallBuffer: string;
  events: InferenceEvent[];
} {
  const events: InferenceEvent[] = [];
  let remaining = buffer;

  while (true) {
    if (insideToolCall) {
      const closeIdx = remaining.indexOf(TOOL_CALL_CLOSE);
      // Check if a new <tool_call> appears before the closing tag — LLM sometimes
      // omits </tool_call> between consecutive tool calls.
      const nextOpenIdx = remaining.indexOf(TOOL_CALL_OPEN);
      const implicitClose = nextOpenIdx >= 0 && (closeIdx < 0 || nextOpenIdx < closeIdx);
      const splitIdx = implicitClose ? nextOpenIdx : closeIdx;

      if (splitIdx >= 0) {
        toolCallBuffer += remaining.substring(0, splitIdx);
        remaining = implicitClose
          ? remaining.substring(splitIdx) // keep the <tool_call> opener for next iteration
          : remaining.substring(splitIdx + TOOL_CALL_CLOSE.length);
        insideToolCall = false;
        try {
          const parsed = JSON.parse(toolCallBuffer.trim()) as {
            name: string;
            arguments?: Record<string, unknown>;
          };
          if (parsed.name) {
            events.push({
              type: 'tool-call',
              id: `local-tc-${toolCallCounter++}`,
              name: parsed.name,
              input: parsed.arguments ?? {},
            });
          }
        } catch {
          // Malformed tool call — skip
        }
        toolCallBuffer = '';
      } else {
        toolCallBuffer += remaining;
        return { remaining: '', insideToolCall, toolCallBuffer, events };
      }
    } else {
      const openIdx = remaining.indexOf(TOOL_CALL_OPEN);
      if (openIdx >= 0) {
        if (openIdx > 0) {
          events.push({ type: 'text-delta', delta: remaining.substring(0, openIdx) });
        }
        remaining = remaining.substring(openIdx + TOOL_CALL_OPEN.length);
        insideToolCall = true;
        toolCallBuffer = '';
      } else if (remaining.includes('<')) {
        const lastLt = remaining.lastIndexOf('<');
        if (lastLt > 0) {
          events.push({ type: 'text-delta', delta: remaining.substring(0, lastLt) });
          return { remaining: remaining.substring(lastLt), insideToolCall, toolCallBuffer, events };
        }
        return { remaining, insideToolCall, toolCallBuffer, events };
      } else {
        events.push({ type: 'text-delta', delta: remaining });
        return { remaining: '', insideToolCall, toolCallBuffer, events };
      }
    }
  }
}

/** Detects bare JSON tool calls (without tags) that the LLM sometimes emits. */
function* extractBareJsonToolCalls(text: string): Iterable<InferenceEvent> {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const braceIdx = text.indexOf('{', searchFrom);
    if (braceIdx === -1) break;
    let depth = 0;
    let endIdx = -1;
    for (let i = braceIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx === -1) break;
    const jsonStr = text.substring(braceIdx, endIdx + 1);
    try {
      const parsed = JSON.parse(jsonStr) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed.name && KNOWN_TOOLS.has(parsed.name)) {
        yield {
          type: 'tool-call',
          id: `local-tc-${toolCallCounter++}`,
          name: parsed.name,
          input: parsed.arguments ?? {},
        };
        searchFrom = endIdx + 1;
        continue;
      }
    } catch {
      // Not valid JSON
    }
    searchFrom = braceIdx + 1;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useLocalLLM(agent: IAgent): UseLocalLLMResult {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [status, setStatus] = useState<LocalLLMStatus>('idle');
  const [isBlocked, setIsBlocked] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const messagesRef = useRef<ConversationMessage[]>([]);
  messagesRef.current = messages;

  const isStreamingRef = useRef(false);
  const initializedRef = useRef(false);

  const runInference = useCallback(
    async (conversationMessages: ConversationMessage[]): Promise<void> => {
      await inferenceQueue.pause();
      try {
        // Initialize model on first use (model may already be loaded by useModelLifecycle)
        if (!initializedRef.current) {
          if (getModelState() === null) {
            const { setModelState } = useMeraProtocolStore.getState();
            setModelState('loading');
            await initBaseModel();
            setModelState('ready');
          }
          initializedRef.current = true;
        }

        // Build system prompt (needsToolFormatInPrompt=true for local LLM)
        let systemPrompt: string;
        try {
          systemPrompt = await agent.buildSystemPrompt(true);
          logger.debug(`${TAG} system prompt built`, { length: systemPrompt.length });
          logger.debug(`${TAG} system prompt content`, { content: systemPrompt });
        } catch (err) {
          throw new Error(`Failed to build system prompt: ${String(err)}`);
        }

        // Build context and inject into prompt
        let context: string | undefined;
        if (agent.buildContext) {
          try {
            context = await agent.buildContext();
            logger.debug(`${TAG} context built`, { length: context.length });
            logger.debug(`${TAG} context content`, { content: context });
          } catch (err) {
            logger.warn(`${TAG} buildContext failed, proceeding without context`, {
              error: String(err),
            });
          }
        }

        const prompt = buildPromptFromMessages(conversationMessages, context);

        // Token budget check
        const systemTokens = estimateTokens(systemPrompt);
        const promptTokens = estimateTokens(prompt);
        const totalInputTokens = systemTokens + promptTokens;
        logger.debug('[LocalLLM:chat] Token estimate', { systemTokens, promptTokens, totalInputTokens, budget: INPUT_TOKEN_BUDGET });

        if (totalInputTokens > INPUT_TOKEN_BUDGET) {
          const overflowBy = totalInputTokens - INPUT_TOKEN_BUDGET;
          logger.captureMessage('[LocalLLM:chat] TOKEN BUDGET EXCEEDED', {
            level: 'warning',
            tags: { component: 'useLocalLLM' },
            extra: { totalInputTokens, inputTokenBudget: INPUT_TOKEN_BUDGET, totalTokenLimit: TOTAL_TOKEN_LIMIT, overflowBy },
          });
          setError('Context too long — please reduce facts or shorten the conversation.');
          return;
        }

        // Add placeholder assistant message
        const assistantId = `asst-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let accContent = '';
        const accToolCalls: ToolCallRecord[] = [];
        const placeholder: ConversationMessage = {
          id: assistantId,
          role: 'assistant',
          content: '',
          toolCalls: [],
        };
        setMessages([...conversationMessages, placeholder]);

        // Stream inference
        logger.debug(`${TAG} LLM input — systemPrompt`, { systemPrompt });
        logger.debug(`${TAG} LLM input — prompt`, { prompt });
        logger.debug(`${TAG} starting inference stream`, { messageCount: conversationMessages.length, maxTokens: MAX_OUTPUT_TOKENS });
        let pendingBuffer = '';
        let insideToolCall = false;
        let toolCallBuffer = '';
        let fullResponse = '';

        for await (const token of inferStream({
          systemPrompt,
          prompt,
          maxTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.4,
        })) {
          fullResponse += token;
          pendingBuffer += token;

          const flushed = flushBuffer(pendingBuffer, insideToolCall, toolCallBuffer);
          pendingBuffer = flushed.remaining;
          insideToolCall = flushed.insideToolCall;
          toolCallBuffer = flushed.toolCallBuffer;

          for (const event of flushed.events) {
            if (event.type === 'text-delta') {
              accContent += event.delta;
              setMessages((prev) =>
                prev.map((m) => m.id === assistantId ? { ...m, content: accContent } : m),
              );
            } else if (event.type === 'tool-call') {
              logger.debug(`${TAG} tool call detected (XML)`, { name: event.name, inputKeys: Object.keys(event.input as Record<string, unknown>) });
              const tc: ToolCallRecord = {
                id: event.id,
                name: event.name,
                input: event.input,
                status: 'pending',
              };
              accToolCalls.push(tc);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] }
                    : m,
                ),
              );
            }
          }
        }

        // Flush remaining buffer (discard incomplete <tool_call> openers)
        if (pendingBuffer.length > 0 && !insideToolCall && !pendingBuffer.startsWith('<')) {
          accContent += pendingBuffer;
          setMessages((prev) =>
            prev.map((m) => m.id === assistantId ? { ...m, content: accContent } : m),
          );
        }

        // Pass 2: re-scan fullResponse for tool calls missed during streaming.
        // The streaming parser can miss tool calls when <tool_call> tags arrive
        // split across tokens. Split on the open tag to reliably find all blocks.
        logger.debug(`${TAG} LLM output — fullResponse`, { fullResponse });
        logger.debug(`${TAG} stream complete`, { responseLength: fullResponse.length, toolCallsSoFar: accToolCalls.length });
        const detectedInputs = new Set(accToolCalls.map(tc => JSON.stringify(tc.input)));
        const segments = fullResponse.split(TOOL_CALL_OPEN).slice(1); // each segment starts after a <tool_call>
        for (const segment of segments) {
          // Strip closing tag if present; take only the JSON before any next text
          const jsonStr = segment.split(TOOL_CALL_CLOSE)[0].trim();
          try {
            const parsed = JSON.parse(jsonStr) as { name: string; arguments?: Record<string, unknown> };
            if (parsed.name && KNOWN_TOOLS.has(parsed.name)) {
              const input = parsed.arguments ?? {};
              // Skip if already detected during streaming
              if (detectedInputs.has(JSON.stringify(input))) continue;
              logger.debug(`${TAG} tool call detected (rescan)`, { name: parsed.name, inputKeys: Object.keys(input) });
              const tc: ToolCallRecord = {
                id: `local-tc-${toolCallCounter++}`,
                name: parsed.name,
                input,
                status: 'pending',
              };
              accToolCalls.push(tc);
              detectedInputs.add(JSON.stringify(input));
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] }
                    : m,
                ),
              );
            }
          } catch {
            // JSON in this segment may be truncated — try bare JSON extraction as fallback
            for (const event of extractBareJsonToolCalls(jsonStr)) {
              if (event.type === 'tool-call') {
                const input = event.input as Record<string, unknown>;
                if (detectedInputs.has(JSON.stringify(input))) continue;
                logger.debug(`${TAG} tool call detected (bare JSON)`, { name: event.name, inputKeys: Object.keys(input) });
                const tc: ToolCallRecord = {
                  id: event.id,
                  name: event.name,
                  input,
                  status: 'pending',
                };
                accToolCalls.push(tc);
                detectedInputs.add(JSON.stringify(input));
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] }
                      : m,
                  ),
                );
              }
            }
          }
        }

        // Release input before tool execution — tools are background work,
        // the user can start typing their next message immediately.
        if (accToolCalls.length > 0) {
          setStatus('idle');
          isStreamingRef.current = false;
        }

        // Execute tool calls sequentially
        logger.debug(`${TAG} executing ${accToolCalls.length} tool call(s)`);
        for (const tc of accToolCalls) {
          try {
            logger.debug(`${TAG} executing tool`, { name: tc.name, inputKeys: Object.keys(tc.input as Record<string, unknown>) });
            const { result, sideEffects } = await agent.executeTool(tc.name, tc.input);
            logger.debug(`${TAG} tool result`, { name: tc.name, result: JSON.stringify(result).slice(0, 200), sideEffects });

            if (sideEffects?.blocked) {
              setIsBlocked(true);
              setBlockedReason(sideEffects.blocked.reason);
            }
            if (sideEffects?.proposal) {
              useFloatingChatStore.getState().setProposal(sideEffects.proposal);
            }
            if (sideEffects?.proposalResolved) {
              useFloatingChatStore.getState().resolveProposal(sideEffects.proposalResolved);
            }

            tc.result = result;
            tc.status = 'done';
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      toolCalls: m.toolCalls?.map((t) =>
                        t.id === tc.id ? { ...t, result, status: 'done' as const } : t,
                      ),
                    }
                  : m,
              ),
            );
          } catch (err) {
            tc.status = 'error';
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      toolCalls: m.toolCalls?.map((t) =>
                        t.id === tc.id ? { ...t, status: 'error' as const } : t,
                      ),
                    }
                  : m,
              ),
            );
            logger.error(`${TAG} tool execution failed`, {
              tool: tc.name,
              error: String(err),
              stack: (err as Error)?.stack,
            });
          }
        }
      } catch (err) {
        const msg = `Inference failed: ${(err as Error)?.message ?? String(err)}`;
        logger.error(`${TAG} runInference failed`, {
          error: String(err),
          stack: (err as Error)?.stack,
        });
        setError(msg);
      } finally {
        logger.debug(`${TAG} inference done, setting idle`);
        inferenceQueue.resume();
        setStatus('idle');
        isStreamingRef.current = false;
      }
    },
    [agent],
  );

  const sendMessage = useCallback(
    (text: string) => {
      if (isStreamingRef.current || isBlocked) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      logger.debug(`${TAG} sendMessage`, { text: trimmed });
      setError(null);

      const userMsg: ConversationMessage = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: 'user',
        content: trimmed,
      };
      const newMessages = [...messagesRef.current, userMsg];
      messagesRef.current = newMessages;
      setMessages(newMessages);

      isStreamingRef.current = true;
      setStatus('streaming');

      void runInference(newMessages);
    },
    [isBlocked, runInference],
  );

  const latestAssistantContent = (() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    return lastAssistant?.content ?? '';
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
