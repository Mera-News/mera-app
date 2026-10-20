// The on-device chat engine. The file keeps its old name; it is no longer a
// hook. `createLocalEngine` is owned by the chat session (lib/chat-session), so
// a turn survives the chat being closed.
//
// The turn itself belongs to the on-device agent (lib/llm/agents/on-device):
// it builds its prompt, runs the model (structured output, or a plain stream
// for tutorial help) and names the executor tools its reply maps to. This file
// shows the reply and runs those tools exactly as cloud tool calls run, so the
// cards (fact choices, proposals, story options) are the same ones.

import type { ChatEngine } from '@/lib/chat-session/engine';
import { useLocalChatStore, type LocalChatState } from '@/lib/chat-session/local-chat-store';
import { isTextModelResident } from '../mera-protocol-toolkit';
import { inferenceQueue } from '../inference/InferenceQueue';
import { makePhaseSink, type PhaseSink } from '@/lib/services/chat-phase';
import { applyChatPhase, useChatPhaseStore } from './chat-phase-store';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import logger from '../logger';
import type { ConversationMessage, ToolCallRecord } from './types';
import type { OnDeviceAgent } from './agents/on-device/types';

const TAG = '[LocalLLM]';

// Module-level counter ensures unique tool call IDs across all inference runs.
let toolCallCounter = 0;

type LocalLLMStatus = LocalChatState['status'];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function createLocalEngine(initialAgent: OnDeviceAgent): ChatEngine<OnDeviceAgent> {
  // State lives in useLocalChatStore so it outlives every component. Writes
  // stop once the engine is replaced (a new chat), so a turn still finishing
  // in the background can never touch the next conversation's thread.
  let alive = true;
  const st = useLocalChatStore.getState;
  const put = (patch: Partial<LocalChatState>): void => {
    if (alive) useLocalChatStore.setState(patch);
  };
  const setMessages = (
    next: ConversationMessage[] | ((prev: ConversationMessage[]) => ConversationMessage[]),
  ): void => put({ messages: typeof next === 'function' ? next(st().messages) : next });
  const setStatus = (status: LocalLLMStatus): void => put({ status });
  // Deliberately NOT cleared at the same point as `status`: see the store's
  // doc on `turnBusy`. Cleared only in `runInference`'s outer `finally`, the
  // one place the whole turn (stream AND tools) is actually done.
  const setTurnBusy = (turnBusy: boolean): void => put({ turnBusy });
  const setIsBlocked = (isBlocked: boolean): void => put({ isBlocked });
  const setBlockedReason = (blockedReason: string | null): void => put({ blockedReason });
  const setError = (error: string | null): void => put({ error });

  const agentRef = { current: initialAgent };
  const isStreamingRef = { current: false };
  /** THE STOP BUTTON, for the turn in flight. Read by the text sink and at the
   *  early-exit points before a completion starts. */
  const stopRef = { requested: false };
  /** Aborted by Stop: wakes the turn at once and tells the toolkit to halt a
   *  stream, neither of which waits for a token. One per turn. */
  const abortRef = { current: new AbortController() };

  /**
   * The wait line's sink for the turn in flight.
   *
   * On-device has no queue, no attestation and no network, so it gets its own
   * three disjoint phase ids and its own copy, which may never mention
   * encryption or a server. Nothing leaves the phone on this path and a line
   * implying otherwise is a false claim, not a cosmetic slip.
   */
  const phaseSinkRef: { current: PhaseSink | null } = { current: null };

  const runInference = async (conversationMessages: ConversationMessage[]): Promise<void> => {
      // Chosen SYNCHRONOUSLY, before the first await. `inferenceQueue.pause()`
      // waits for whatever job holds the model to finish, and on a cold turn
      // the toolkit then loads the text model inside its lock: both are real
      // seconds the user sits through, and publishing after them would miss the
      // part of the wait that most needs a sentence.
      const coldModel = !isTextModelResident();
      const phase = phaseSinkRef.current;
      phase?.(coldModel ? 'deviceLoading' : 'devicePreparing');
      await inferenceQueue.pause();
      try {
        // Stop pressed while the queue paused: end the turn, start no completion.
        if (stopRef.requested) return;

        const assistantId = `asst-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let accContent = '';
        const placeholder: ConversationMessage = {
          id: assistantId,
          role: 'assistant',
          content: '',
          toolCalls: [],
        };
        setMessages([...conversationMessages, placeholder]);
        const setContent = (content: string, extra: Partial<ConversationMessage> = {}) =>
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content, ...extra } : m)));

        // A cold turn is still loading inside the toolkit, so it keeps
        // deviceLoading until the reply (the sink only moves forward).
        if (!coldModel) phase?.('deviceThinking');

        // Stop must end the turn NOW, but a structured call cannot be cut short
        // and a stream only ends once the model has unwound. So the turn races
        // the abort, and an abandoned turn finishes (and is ignored) in the
        // background; the toolkit releases its lock on its own.
        const signal = abortRef.current.signal;
        const aborted = new Promise<'aborted'>((resolve) => {
          if (signal.aborted) resolve('aborted');
          else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        const turn = agentRef.current.respond(conversationMessages, {
          signal,
          onText: (delta) => {
            if (stopRef.requested) return;
            // Real text. The bubble is the liveness signal from here; the sink
            // swallows a repeat, so this costs one store write on the first delta.
            phase?.(null);
            accContent += delta;
            setContent(accContent);
          },
        });
        turn.catch(() => {}); // an abandoned turn may reject later; nobody is waiting
        const outcome = await Promise.race([turn, aborted]);

        if (outcome === 'aborted' || stopRef.requested) {
          // STOPPED: the partial reply stays; nothing is staged or run.
          setContent(accContent, { toolCalls: undefined, stopped: true });
          return;
        }

        phase?.(null);
        const accToolCalls: ToolCallRecord[] = outcome.calls.map((c) => ({
          id: `local-tc-${toolCallCounter++}`,
          name: c.name,
          input: c.input,
          status: 'pending',
        }));
        logger.debug(`${TAG} turn complete`, {
          replyLength: outcome.reply.length,
          tools: accToolCalls.map((t) => t.name),
        });
        setContent(outcome.reply, { toolCalls: accToolCalls });

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
            const { result, sideEffects } = await agentRef.current.executeTool(tc.name, tc.input);
            logger.debug(`${TAG} tool result`, { name: tc.name, resultLength: JSON.stringify(result).length, sideEffects: sideEffects ? Object.keys(sideEffects) : [] });

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
        // On the throw path too. A local failure leaves the same generic error
        // banner as a cloud one, and a line still saying "thinking it through
        // on your phone" underneath it is the worse half of the bug.
        phase?.(null);
        if (phaseSinkRef.current === phase) phaseSinkRef.current = null;
        inferenceQueue.resume();
        setStatus('idle');
        isStreamingRef.current = false;
        // The ONE place `turnBusy` clears. Never at the early release above —
        // that early release IS the gap this flag exists to cover.
        setTurnBusy(false);
      }
    };

  /**
   * One turn. `hidden` makes it invisible to the user and unpersisted, while the
   * model still reads it as an ordinary trailing `user` turn.
   *
   * It HAS to be a user turn on this path: the on-device flows render the
   * thread as `User:` / `Mera:` lines, and one ending on Mera's own line makes
   * a small model continue its previous message.
   */
  const startTurn = (text: string, hidden: boolean): void => {
      if (isStreamingRef.current || st().turnBusy || st().isBlocked) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      logger.debug(`${TAG} startTurn`, { length: trimmed.length, hidden });
      setError(null);

      const userMsg: ConversationMessage = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
        ...(hidden ? { hidden: true } : {}),
      };
      const newMessages = [...st().messages, userMsg];
      setMessages(newMessages);

      stopRef.requested = false;
      abortRef.current = new AbortController();
      isStreamingRef.current = true;
      setStatus('streaming');
      setTurnBusy(true);

      // Created here rather than in `runInference` so the mark is per TURN and
      // exists before the first await inside it.
      useChatPhaseStore.getState().reset();
      phaseSinkRef.current = makePhaseSink(applyChatPhase);

      void runInference(newMessages);
  };

  return {
    send: (text) => startTurn(text, false),
    sendHidden: (text) => startTurn(text, true),
    setAgent: (agent) => {
      agentRef.current = agent;
    },
    stop: () => {
      stopRef.requested = true;
      abortRef.current.abort();
    },
    dispose: () => {
      alive = false;
    },
  };
}
