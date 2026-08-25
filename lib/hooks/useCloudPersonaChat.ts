// useCloudPersonaChat — cloud chat hook for persona update.
// Single-shot: streams one SSE response from backend proxy, executes
// tools locally via agent.executeTool(). No re-send loop — mirrors local LLM flow.
// State is stored in Zustand (cloud-chat-store) so it survives component remounts.

import { useCallback, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import logger from '../logger';
import { cloudChatStream, type WireMessage } from '../llm/cloudComplete';
import { BIG_MODEL, CHAT_MAX_OUTPUT_TOKENS } from '../llm/constants';
import type { ConversationMessage, IAgent, ToolCallRecord, ToolDefinition } from '../llm/types';
import { useCloudChatStore } from '../stores/cloud-chat-store';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import { estimateTokens } from '../llm/tokens';
import { selectHistoryWindow } from '../news-harness/persona-management/history-window';
import { normalizeToolName } from '../news-harness/persona-management/tool-names';
import {
  CLOUD_HISTORY_BUDGET_TOKENS,
  KNOWLEDGE_TOOL_NAMES,
  MAX_HISTORY_USER_TURNS,
} from '../news-harness/persona-management/persona-agent-core';

const TAG = '[CloudChat]';

// Cloud chat carries a TOKEN-BUDGETED window of recent turns (see
// lib/news-harness/persona-management/history-window.ts). It used to send only
// the current user turn, which meant a tail of [..., user("Yes")] reached the
// model as the bare word "Yes" with no trace of the question it answered — the
// reported bug where Mera responded to a confirmation with "Great, good to see
// you again!".
//
// Fresh facts are still re-loaded from the `facts` table every turn via
// buildContext() and injected onto the LAST user message only, so a wider
// window never lets the LLM hallucinate persisted state from a stale assistant
// claim like "Got it, saved" — the facts block always reflects the database,
// not the conversation.
function wireMessageTokens(m: WireMessage): number {
  const content = typeof m.content === 'string' ? m.content : '';
  const calls =
    'tool_calls' in m && m.tool_calls ? JSON.stringify(m.tool_calls) : '';
  return estimateTokens(content) + estimateTokens(calls);
}

export interface UseCloudPersonaChatResult {
  messages: ConversationMessage[];
  status: 'idle' | 'streaming';
  sendMessage: (text: string) => void;
  /** Runs a turn the user never sees. See startTurn's `visible` argument. */
  sendHiddenTurn: (text: string) => void;
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

interface FinalizedToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Set when the model's argument JSON could not be parsed. Such a call is
   *  NEVER executed and never reaches the wire — see the note below. */
  malformed?: true;
}

function finalizeToolCalls(
  accumulators: Map<number, ToolCallAccumulator>,
): FinalizedToolCall[] {
  const results: FinalizedToolCall[] = [];
  for (const [, acc] of accumulators) {
    if (!acc.name) continue;
    try {
      const input = acc.arguments ? JSON.parse(acc.arguments) : {};
      results.push({ id: acc.id, name: acc.name, input });
    } catch {
      // Do NOT substitute `{}`. That turned a truncated or corrupt call into a
      // well-formed one with no arguments, which the handlers then answered as
      // an ordinary validation failure ("fact_ids must be a non-empty array") —
      // telling the model its ARGUMENTS were wrong when in fact its
      // SERIALIZATION was, and making a dropped call look like a successful
      // no-op in the logs.
      logger.warn(`${TAG} Failed to parse tool call arguments`, {
        name: acc.name,
        args: acc.arguments,
      });
      logger.captureMessage(`${TAG} malformed tool arguments`, {
        level: 'warning',
        tags: { component: 'useCloudPersonaChat' },
        extra: { tool: acc.name, argsLength: acc.arguments.length },
      });
      results.push({ id: acc.id, name: acc.name, input: null, malformed: true });
    }
  }
  return results;
}

/**
 * True when a tool call "used up" the model's mandatory call without extracting
 * anything — `saveExtractedFacts` with an empty (or malformed) list.
 *
 * Observed in production 2026-08-03: the user states a fact, the model replies
 * conversationally AND calls saveExtractedFacts with
 * `{extracted_user_information: []}`. The call is well-formed, so the
 * zero-tool-call safety net below never fires, executeTool saves nothing, and
 * the fact is silently lost — the failure the user reports as "it just replied
 * to me". Treating this as no call at all routes it back through the same
 * forced-extraction pass that already covers a model skipping the tool.
 */
function isEmptyExtractionCall(tc: { name: string; input: unknown }): boolean {
  if (tc.name !== 'saveExtractedFacts') return false;
  const list = (tc.input as { extracted_user_information?: unknown } | null)
    ?.extracted_user_information;
  return !Array.isArray(list) || list.length === 0;
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
  /** Covers the WHOLE turn including the fire-and-forget forced-extraction tail,
   *  which outlives isStreamingRef. See startTurn. */
  const turnBusyRef = useRef(false);
  /** True while the forced pass owns the busy release. */
  const forcedPassRef = useRef(false);
  /** A hidden turn that arrived mid-turn, waiting for the current one to settle. */
  const pendingHiddenTurnRef = useRef<string | null>(null);

  /** Held in a ref so `flushPendingHiddenTurn` can re-enter `startTurn` without
   *  the two useCallbacks depending on each other. */
  const startTurnRef = useRef<((text: string, visible: boolean) => void) | null>(null);

  const flushPendingHiddenTurn = useCallback(() => {
    const pending = pendingHiddenTurnRef.current;
    if (!pending) return;
    pendingHiddenTurnRef.current = null;
    startTurnRef.current?.(pending, false);
  }, []);

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
      // First-pass tool choice is 'auto' (was 'required'): forcing a tool call
      // on the opening turn meant even a purely conversational reply ("hi",
      // "thanks") emitted a spurious tool call, then required a SECOND full
      // inference to produce the text (see the continuation pass below) —
      // doubling first-turn latency. Both agents that drive this hook
      // (PersonaUpdateAgent, ArticleFeedbackAgent) are conversational: the
      // system prompt tells the model WHEN to call its record/update tools, so
      // 'auto' still fires the tool whenever the user actually supplies
      // fact-worthy input, and a text-only turn now completes in one round trip.
      // The continuation pass keeps its own 'auto' (unchanged) for when the
      // model does return tool calls but no text.
      const streamOne = async (
        targetId: string,
        includeContext: boolean,
        toolChoice: 'required' | 'auto' = 'auto',
        // Overrides the turn's tool payload (forced-extraction pass only).
        toolsOverride?: ToolDefinition[],
        // When true, text deltas are accumulated but NEVER written into
        // `targetId`. The forced pass needs this: it targets the VISIBLE
        // assistant bubble so its tool calls render and persist, and without
        // this flag its own prose would overwrite — mid-turn — the reply the
        // user is already reading (accContent restarts at '' on every call).
        suppressText = false,
      ): Promise<{ accContent: string; toolCalls: ReturnType<typeof finalizeToolCalls> }> => {
        let accContent = '';
        const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

        // Window wireMessages to a TOKEN BUDGET (not a message count), newest
        // first. selectHistoryWindow owns the two structural invariants — the
        // window starts on a user turn, and never splits an
        // assistant(tool_calls) / tool result pair — so the continuation pass,
        // which lands here with the tail [user, assistant(tool_calls), tool],
        // keeps that tail intact.
        const allWire = useCloudChatStore.getState().wireMessages;
        const startIdx = selectHistoryWindow<WireMessage>({
          entries: allWire,
          budgetTokens: CLOUD_HISTORY_BUDGET_TOKENS,
          maxUserTurns: MAX_HISTORY_USER_TURNS,
          roleOf: (m) => m.role,
          tokensOf: wireMessageTokens,
        });
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
          tools: toolsOverride ?? tools,
          toolChoice,
          model: BIG_MODEL,
          maxTokens: CHAT_MAX_OUTPUT_TOKENS,
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
            if (!suppressText) {
              useCloudChatStore.getState().setMessages((prev) =>
                prev.map((m) => m.id === targetId ? { ...m, content: accContent } : m),
              );
            }
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
        // Malformed calls are EXCLUDED from the wire. Serialising them would
        // record the assistant as having emitted `{}` — reintroducing on the
        // wire exactly the fiction we removed from execution. Excluding them
        // also means no paired `tool` result message is owed for them, so the
        // "every tool_call must be answered" rule stays satisfied.
        const usable = toolCalls.filter((tc) => !tc.malformed);
        const wireToolCalls = usable.length > 0
          ? usable.map((tc) => ({
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

        const knownNames = (agentRef.current.getToolDefinitions?.() ?? []).map(
          (d) => d.function.name,
        );

        const results = await Promise.all(
          toolCalls.map(async (tc, i) => {
            // Never execute a call whose arguments did not parse — surface it
            // as an error the user can see instead of running it with {}.
            if (tc.malformed) {
              return {
                index: i,
                result: { error: 'malformed tool arguments — call was not executed' },
                status: 'error' as const,
              };
            }
            try {
              const resolved = normalizeToolName(tc.name, knownNames);
              if (resolved && resolved !== tc.name) {
                logger.warn(`${TAG} repaired tool name`, { from: tc.name, to: resolved });
              } else if (!resolved) {
                logger.warn(`${TAG} unresolvable tool name`, {
                  name: tc.name,
                  candidates: knownNames,
                });
              }
              const callName = resolved ?? tc.name;
              logger.debug(`${TAG} executing tool`, { name: callName, inputKeys: Object.keys(tc.input as Record<string, unknown>) });
              const { result, sideEffects } = await agentRef.current.executeTool(callName, tc.input);
              logger.debug(`${TAG} tool result`, { name: tc.name, result: JSON.stringify(result).slice(0, 200), sideEffects });

              if (sideEffects?.blocked) {
                useCloudChatStore.getState().setIsBlocked(true);
                useCloudChatStore.getState().setBlockedReason(sideEffects.blocked.reason);
              }
              if (sideEffects?.proposal) {
                useFloatingChatStore.getState().setProposal(sideEffects.proposal);
              }
              if (sideEffects?.proposalResolved) {
                useFloatingChatStore.getState().resolveProposal(sideEffects.proposalResolved);
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

        // Only calls that made it onto the wire are owed a `tool` reply.
        for (const tc of toolCalls) {
          if (tc.malformed) continue;
          const matched = toolCallRecords.find((r) => r.id === tc.id);
          const resultPayload = matched?.result ?? { error: 'no result' };
          useCloudChatStore.getState().pushWireMessage({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(resultPayload),
          });
        }
      };

      // ---------- Forced extraction safety-net (GATED) ----------
      //
      // GATE (P0). This pass runs with tool_choice:'required', which obliges the
      // model to emit >=1 tool call from whatever payload we hand it — and
      // executeToolsAndPushResults then really RUNS it. On a purely
      // conversational turn ("hi", "thanks") that means a tool call the user
      // never asked for. Three conditions must therefore hold before it fires:
      //
      //  1. The agent opts in via getForcedExtractionTools() with a NON-EMPTY
      //     payload of tools whose empty-argument call is a harmless no-op.
      //     ArticleFeedbackAgent returns [] — every tool it has stages or
      //     applies a change, so a forced call there fabricates consent.
      //  2. No proposal is pending — otherwise 'required' can pick
      //     applyProposal and apply it without the user confirming.
      //  3. (LANDS WITH P2) No invocation intent is pending — a
      //     notification-initiated action such as runCalibration takes NO
      //     arguments, which makes it the cheapest possible way for a model to
      //     satisfy 'required'. When the pendingIntent channel is added, add
      //     `if (store.pendingIntent) return [];` below. P2 MUST NOT ship
      //     without that line.
      const forcedExtractionTools = (): ToolDefinition[] => {
        const store = useFloatingChatStore.getState();
        if (store.proposal) return [];
        //  4. No topic-plan reply turn is in flight. That turn's note tells the
        //     model to save NOTHING, and 'required' would oblige
        //     saveExtractedFacts — forcing the one action the note forbids.
        if (store.topicPlanTurnInFlight) return [];
        return agentRef.current.getForcedExtractionTools?.() ?? [];
      };

      // ---------- Forced extraction safety-net ----------
      // The first pass runs with tool_choice:'auto' for a fast, single-round-trip
      // reply — but 'auto' lets the model answer conversationally and skip the
      // mandatory saveExtractedFacts call (DeepSeek-V4-Flash does exactly this on
      // fact-worthy messages). When the first pass returns text but ZERO tool
      // calls, run a background pass with tool_choice:'required' so extraction
      // always happens, WITHOUT blocking the reply the user already sees. It
      // streams into a hidden id that is never inserted via setMessages, so no
      // second bubble renders; the side effects that matter (fact save →
      // topic-gen, conflict/proposal cards) still fire from executeTool. Runs at
      // most once — 'required' obliges ≥1 tool call, so there is no recursion.
      // Targets the VISIBLE assistant bubble (not a throwaway hidden id) with
      // text suppressed, so the tool calls it produces actually render as fact /
      // conflict cards and get captured by useChatPersistence. The previous
      // hidden id was never inserted into `messages`, so every setMessages
      // against it was a silent no-op: the user saw nothing and nothing
      // persisted.
      //
      // Pushes NOTHING to wireMessages. This pass is a side effect, not a
      // conversational turn — its text was never shown to the user, so putting
      // it on the wire would make history diverge from what the user actually
      // read (harmless while the window was 1 message, actively misleading once
      // it widens). The facts it saves reach the next turn anyway: buildContext()
      // re-reads them from the `facts` table every turn.
      const runForcedExtraction = async (visibleId: string, tools: ToolDefinition[]) => {
        try {
          logger.debug(`${TAG} forced extraction pass (required)`, {
            wireMessages: useCloudChatStore.getState().wireMessages.length,
            tools: tools.map((t) => t.function.name),
          });
          const forced = await streamOne(visibleId, true, 'required', tools, true);
          if (forced.toolCalls.length > 0) {
            await executeToolsAndPushResults(visibleId, forced.toolCalls);
          }
        } catch (err) {
          logger.error(`${TAG} forced extraction failed`, undefined, { error: String(err) });
        }
      };

      // ---------- First pass ----------
      const placeholder: ConversationMessage = { id: assistantId, role: 'assistant', content: '' };
      useCloudChatStore.getState().setMessages((prev) => [...prev, placeholder]);

      // 'auto' (explicit): a text-only reply finishes in one round trip; the
      // model still calls a tool when the turn warrants one (→ continuation).
      const first = await streamOne(assistantId, true, 'auto');
      pushAssistantToWire(first.accContent, first.toolCalls);

      if (first.toolCalls.length > 0) {
        await executeToolsAndPushResults(assistantId, first.toolCalls);
      }

      // ---------- Knowledge tools ----------
      // A knowledge tool (explainMera) returns REFERENCE TEXT that only matters
      // if the model gets to read it, so it changes two decisions below. Names
      // are resolved through normalizeToolName against the agent's OWN live
      // definitions — the same repair every other name comparison in this file
      // uses, so a model that emits `explain_mera` is still recognised.
      // NAME only — deliberately blind to `malformed`. The two consumers below
      // want opposite things from a malformed knowledge call, so the split is
      // made at the call site rather than baked in here:
      //
      //  - extraction: a malformed explainMera is still NOT extraction. Folding
      //    the malformed check in here would let a truncated knowledge call fall
      //    through both predicates, flip `extractedSomething` true, and disable
      //    the very safety net fix (ii) exists to protect — the same silent
      //    fact loss, reached by the other door. Malformed calls are real:
      //    finalizeToolCalls keeps them and captureMessage reports them.
      //  - continuation: a malformed call IS excluded (see below), because it
      //    never reached the wire and produced no result to read back.
      const isKnowledgeName = (tc: { name: string }): boolean => {
        const known = (agentRef.current.getToolDefinitions?.() ?? []).map(
          (d) => d.function.name,
        );
        return KNOWLEDGE_TOOL_NAMES.has(normalizeToolName(tc.name, known) ?? tc.name);
      };

      // Did the turn actually extract anything? Zero tool calls and an EMPTY
      // saveExtractedFacts call both mean no — see isEmptyExtractionCall.
      //
      // A knowledge call is not extraction either. Left counted, a turn whose
      // only tool call was explainMera would flip this true and silently skip
      // the forced-extraction safety net — so the user states a fact while
      // asking a question about Mera, and the fact is lost. Excluded HERE at the
      // call site rather than inside isEmptyExtractionCall, whose name and
      // production-incident docstring are specifically about saveExtractedFacts.
      const extractedSomething = first.toolCalls.some(
        (tc) => !isEmptyExtractionCall(tc) && !isKnowledgeName(tc),
      );

      // Malformed IS excluded here: such a call never reached the wire
      // (pushAssistantToWire drops it) and was never executed, so no `tool`
      // result is owed and there is nothing for a continuation to read.
      const calledKnowledgeTool = first.toolCalls.some(
        (tc) => !tc.malformed && isKnowledgeName(tc),
      );

      // ---------- Which passes does this turn owe? ----------
      //
      // The continuation pass posts the tool results back so the model can
      // actually USE them. It fires when the model returned no text (the
      // original trigger — the bubble would otherwise stay blank) and ALSO
      // whenever a knowledge tool ran, regardless of text: a knowledge result
      // that is pushed to the wire and never read means the model answers the
      // user's question from memory, which is the single failure that tool
      // exists to prevent. It is NOT solvable by prompting the model to emit
      // empty text — the CLOUD prompt hard-requires text in every response.
      const needsContinuation = calledKnowledgeTool || first.accContent.trim() === '';

      // PROD-VISIBLE SIGNAL FOR "the model answered in prose and staged
      // nothing". Every other line on this path is `logger.debug`, which is a
      // no-op in a release build (lib/logger.ts) — so the follow-story refusal
      // users reported could only be diagnosed by reproducing it in a dev build.
      // `warn` reaches Sentry as a breadcrumb. NO user text, no query, no reply:
      // the tool names and the agent id are the whole payload.
      if (first.toolCalls.length === 0 && first.accContent.trim() !== '') {
        logger.warn(`${TAG} turn produced prose and no tool calls`, {
          agent: agentRef.current.id.replace(/-[^-]+$/, ''),
          declaredTools: (agentRef.current.getToolDefinitions?.() ?? []).length,
        });
      }

      // Forced extraction is owed on the original condition, unchanged: the user
      // already has a reply but nothing was extracted. With no text the
      // continuation is the better instrument (visible reply AND another chance
      // at the tool), where a hidden forced pass would leave the bubble blank.
      const needsForcedExtraction = !extractedSomething && first.accContent.trim() !== '';

      // Gate (P0): only run when the agent supplies a payload of tools that are
      // safe to be FORCED. Empty => skip entirely. See forcedExtractionTools.
      const startForcedExtraction = () => {
        const forcedTools = forcedExtractionTools();
        if (forcedTools.length > 0) {
          forcedPassRef.current = true;
          void runForcedExtraction(assistantId, forcedTools).finally(() => {
            forcedPassRef.current = false;
            turnBusyRef.current = false;
            flushPendingHiddenTurn();
          });
        } else {
          logger.debug(`${TAG} forced extraction skipped (gate)`, {
            reason: useFloatingChatStore.getState().proposal
              ? 'proposal pending'
              : 'agent supplies no forced-extraction tools',
          });
        }
      };

      // ---------- Continuation pass ----------
      // When the model returns tool calls but no conversational text — or ran a
      // knowledge tool — post the tool results back and let it produce a real
      // reply in a fresh bubble. Capped at one continuation: if the second turn
      // also drops text, leave the bubble blank rather than looping, and a
      // knowledge tool re-called there is a wasted call, not a recursion.
      //
      // EXCLUSIVE AND ORDERED with forced extraction. Both branches can now be
      // owed by the same turn (knowledge call + text + nothing extracted), and
      // runForcedExtraction is deliberately un-awaited — two streams in flight
      // at once would interleave pushWireMessage / pushAssistantToWire against
      // the same store. So the continuation takes precedence, is awaited, and
      // forced extraction runs only afterwards and only if still warranted.
      if (needsContinuation) {
        const followUpId = `asst-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        logger.debug(`${TAG} sending follow-up turn`, {
          reason: calledKnowledgeTool ? 'knowledge tool result' : 'no text from LLM',
          wireMessages: useCloudChatStore.getState().wireMessages.length,
        });
        const followUpPlaceholder: ConversationMessage = { id: followUpId, role: 'assistant', content: '' };
        useCloudChatStore.getState().setMessages((prev) => [...prev, followUpPlaceholder]);

        const second = await streamOne(followUpId, true, 'auto');
        pushAssistantToWire(second.accContent, second.toolCalls);
        if (second.toolCalls.length > 0) {
          await executeToolsAndPushResults(followUpId, second.toolCalls);
        }

        // "Still warranted": the continuation gets its own shot at the tool, so
        // an extraction there discharges the debt the first pass left.
        const secondExtracted = second.toolCalls.some(
          (tc) => !isEmptyExtractionCall(tc) && !isKnowledgeName(tc),
        );
        if (needsForcedExtraction && !secondExtracted) startForcedExtraction();
        return;
      }

      if (needsForcedExtraction) startForcedExtraction();
    },
    [flushPendingHiddenTurn],
  );

  /**
   * One turn. `visible: false` runs it without ever appending a
   * `ConversationMessage`, so nothing is drawn and — because useChatPersistence
   * reads `messages`, not the wire — nothing is stored either. The model still
   * sees an ordinary trailing `user` turn with fresh <context> on it.
   */
  const startTurn = useCallback(
    (text: string, visible: boolean) => {
      const store = useCloudChatStore.getState();
      logger.debug(`${TAG} startTurn`, { visible, isStreaming: isStreamingRef.current, isBlocked: store.isBlocked });
      // turnBusyRef, not isStreamingRef: startForcedExtraction dispatches with
      // `void`, so the forced pass OUTLIVES this function's finally. A turn
      // started in that window would push a `user` wire message before the
      // forced pass appends its `tool` replies, leaving an orphan `tool` with no
      // matching `tool_calls` — which most OpenAI-compatible endpoints reject.
      if (turnBusyRef.current || isStreamingRef.current || store.isBlocked) {
        if (!visible) {
          // Queued rather than dropped: the user tapped Discard and is owed a
          // reply, so it fires when the current work settles.
          pendingHiddenTurnRef.current = text;
          logger.debug(`${TAG} hidden turn queued`);
        }
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) return;

      logger.debug(`${TAG} sendMessage proceeding`, { text: trimmed });
      store.setError(null);

      if (visible) {
        const userMsg: ConversationMessage = {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: 'user',
          content: trimmed,
        };
        store.setMessages((prev) => [...prev, userMsg]);
      }

      turnBusyRef.current = true;
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
          logger.debug(`${TAG} startTurn done, setting idle`);
          useCloudChatStore.getState().setStatus('idle');
          isStreamingRef.current = false;
          useFloatingChatStore.getState().setTopicPlanTurnInFlight(false);
          // The forced pass, when one is running, owns the release instead.
          if (!forcedPassRef.current) {
            turnBusyRef.current = false;
            flushPendingHiddenTurn();
          }
        }
      })();
    },
    [runSingleShot, flushPendingHiddenTurn],
  );

  startTurnRef.current = startTurn;

  const sendMessage = useCallback((text: string) => startTurn(text, true), [startTurn]);
  const sendHiddenTurn = useCallback((text: string) => startTurn(text, false), [startTurn]);

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
    sendHiddenTurn,
    latestAssistantContent,
    isBlocked,
    blockedReason,
    error,
  };
}
