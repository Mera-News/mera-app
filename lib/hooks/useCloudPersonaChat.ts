// The cloud chat engine (persona update and every other cloud agent). The
// file keeps its old name; it is no longer a hook. `createCloudEngine` is
// owned by the chat session (lib/chat-session), so a turn survives the chat
// being closed. State is in cloud-chat-store; the turn bookkeeping is closure
// state here.

import type { ChatEngine, MoreOptionsRequest, MoreOptionsResult } from '@/lib/chat-session/engine';
import { FollowStoryAgent } from '../llm/agents/FollowStoryAgent';
import logger from '../logger';
import { CallerAbortError, cloudChatStream, type WireMessage } from '../llm/cloudComplete';
import { BIG_MODEL, CHAT_MAX_OUTPUT_TOKENS } from '../llm/constants';
import { markChatFailed, markChatReady } from '../llm/prewarm';

import type { ConversationMessage, IAgent, ToolCallRecord, ToolDefinition } from '../llm/types';
import {
  createAgentState,
  createAgentTurnState,
  replaceClauseDashes,
  runAgentTurn,
  type AgentLeg,
  type AgentState,
} from '../mera-harness';
import {
  buildAgentPersona,
  makeAgentDeps,
  type CardToolDeps,
  type ToolSignal,
} from '../chat-tools/agent-device-port';
import { useCloudChatStore } from '../stores/cloud-chat-store';
import { makePhaseSink, type PhaseSink } from '@/lib/services/chat-phase';
import { applyChatPhase, useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import {
  detachedCopy,
  finalizeToolCalls,
  followedInChatLabels,
  FOLLOW_STORY_HINT,
  runsOnHarness,
  i18nInstance,
  parseToolArgs,
  pendingCardStatements,
  activeFiltersView,
  applyToolSideEffects,
  pendingProposalView,
  scheduleFrame,
  TAG,
  withCombinedFactMemory,
  wireMessageTokens,
  type CloudState,
  type ToolCallAccumulator,
} from '@/lib/chat-session/cloud-engine-helpers';
import { normaliseTrackText } from '@/components/custom/floating-chat/track-options';
import type { ProposalAction } from '../news-harness/core/types';
import { selectHistoryWindow } from '../news-harness/persona-management/history-window';
import { normalizeToolName } from '../news-harness/persona-management/tool-names';
import {
  CLOUD_HISTORY_BUDGET_TOKENS,
  KNOWLEDGE_TOOL_NAMES,
  MAX_HISTORY_USER_TURNS,
} from '../news-harness/persona-management/persona-agent-core';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function createCloudEngine(initialAgent: IAgent): ChatEngine {
  let alive = true;
  // A New chat disposes this engine while its turn may still run. From then on
  // the turn reads a frozen copy of its own conversation and writes nowhere, so
  // it can never end, overwrite or persist into the next conversation's turn.
  let detached: CloudState | null = null;
  const cloud = (): CloudState => (alive || !detached ? useCloudChatStore.getState() : detached);
  const isStreamingRef = { current: false };
  /** Covers the WHOLE turn: every leg and the device tool work between them.
   *  See startTurn. */
  const turnBusyRef = { current: false };
  /** THE STOP BUTTON. One controller per turn; `stop()` aborts it, which cancels
   *  the stream on both hedge legs, and every later step of the turn checks it
   *  (no more legs, no tool calls). */
  const stopRef: { current: AbortController } = { current: new AbortController() };
  const throwIfStopped = (): void => {
    if (stopRef.current.signal.aborted) throw new CallerAbortError('turn stopped');
  };

  /**
   * Sets `turnBusyRef` AND mirrors it onto the store's `agentTurnState`, so the
   * two cannot drift. Every write to `turnBusyRef` goes through here.
   *
   * `turnActive` must be true across every leg AND every gap between them
   * (device tool execution) and false only at turn end or transport failure.
   * Deriving it from `status` renders a live turn as interrupted, which is
   * exactly the failure the interruption state exists to report.
   */
  const setTurnBusy = (next: boolean): void => {
    if (turnBusyRef.current === next) return;
    turnBusyRef.current = next;
    const store = cloud();
    const current = store.agentTurnState;
    if (current) {
      if (current.turnActive !== next) {
        store.setAgentTurnState({ ...current, turnActive: next });
      }
      return;
    }
    // No loop state yet (a turn before the agent loop drives this hook). Mint
    // the minimum the thread needs rather than leaving the flag unreadable.
    store.setAgentTurnState({ ...createAgentTurnState(), turnActive: next });
  };
  /** A hidden turn that arrived mid-turn, waiting for the current one to settle. */
  const pendingHiddenTurnRef: { current: string | null } = { current: null };

  /** Held in a ref so `flushPendingHiddenTurn` can re-enter `startTurn` without
   *  the two depending on each other. */
  const startTurnRef: { current: ((text: string, visible: boolean) => void) | null } = { current: null };

  const flushPendingHiddenTurn = (): void => {
    const pending = pendingHiddenTurnRef.current;
    if (!pending) return;
    pendingHiddenTurnRef.current = null;
    startTurnRef.current?.(pending, false);
  };

  const agentRef = { current: initialAgent };

  /** proposeTrack and searchNews run on the follow-story agent. On any other
   *  harness chat a lazy one stands in: its executeTool ignores the user id. */
  let delegate: FollowStoryAgent | null = null;
  const cardTools = (): CardToolDeps => ({
    execute: (name, args) => {
      if (name !== 'proposeTrack' && name !== 'searchNews') return agentRef.current.executeTool(name, args);
      if (agentRef.current.id.startsWith('follow-story-')) return agentRef.current.executeTool(name, args);
      delegate ??= new FollowStoryAgent('delegate');
      return delegate.executeTool(name, args);
    },
    onSideEffects: (se) => applyToolSideEffects(se, { alive, cloud: cloud() }),
    pending: pendingProposalView,
  });
  /** Where the chat was opened, for the loop's `<surface>` block. */
  const surfaceFor = (): AgentState['surfaceContext'] =>
    agentRef.current.id.startsWith('follow-story-')
      ? { kind: 'follow-story', hint: FOLLOW_STORY_HINT, context: null }
      : null;
  const noAnswerLine = (): string => i18nInstance().t('chat.turnNoAnswer');

  /** The loop's state, threaded turn to turn. In a ref rather than rebuilt per
   *  turn: `pendingChoice` has to survive to the turn that answers it, or a tap
   *  arrives as a bare display string and the place is looked up twice. */
  const agentStateRef: { current: AgentState | null } = { current: null };

  /**
   * The wait line's sink for the turn in flight, or null when no turn owns it.
   *
   * A REF, not a parameter, because `runAgentLoopTurn` and `runSingleShot` are
   * separate callbacks that `startTurn` chooses between, and the mark has to
   * be per TURN rather than per path. Null outside a turn.
   */
  const phaseSinkRef: { current: PhaseSink | null } = { current: null };

  /**
   * ONE TURN through the agent loop. This is the shipped cloud path for the
   * persona agent; `runSingleShot` still serves every other agent.
   *
   * The loop lives in lib/mera-harness and is the SAME code the eval drives,
   * which is the point: a harness green is evidence about the app rather than
   * about a parallel implementation.
   */
  const runAgentLoopTurn = async (assistantId: string, userMessage: string): Promise<void> => {
      const store = cloud();
      const persona = await buildAgentPersona(agentRef.current.id);
      // NEW CHAT clears the store's agentTurnState, and this ref has to follow
      // it or the loop keeps a pendingChoice from the previous conversation.
      // On device a fresh "Yes" was matched to a stale choice about a wife's
      // hospital in Alkmaar, because the ref outlived the thread that asked.
      // The store is the authority on "is this the same conversation".
      if (store.agentTurnState === null) agentStateRef.current = null;
      if (!agentStateRef.current) agentStateRef.current = createAgentState(persona);
      // Readings still waiting on a card, so a typed reply cannot produce a
      // second card for the same thing (owner ruling ux1, F7).
      agentStateRef.current.pendingCardStatements = pendingCardStatements(store.messages);
      // Facts are re-read every turn; only the TURN half persists.
      agentStateRef.current.persona = persona;
      // The card on screen and the filters it could retire, so a typed yes or no
      // can settle the card and `retire_suppression` names a real id.
      agentStateRef.current.pendingProposal = pendingProposalView();
      agentStateRef.current.activeFilters = await activeFiltersView();
      agentStateRef.current.surfaceContext = surfaceFor();
      agentStateRef.current.followedInChat = followedInChatLabels(store.messages);

      // TWO BUBBLES PER TURN. The acknowledgement streams into its own bubble
      // and is never replaced; the answer lands in the second one, which also
      // carries every tool call (and so every card) of the turn. One bubble
      // used to take every leg's text in turn and then swap to the final
      // reply, so the words being read changed under the reader and the
      // bubble jumped. An empty bubble with no cards is not rendered, so a turn
      // with no acknowledgement shows one bubble, exactly as before.
      const ackId = `${assistantId}-ack`;
      store.setMessages((prev) => [
        ...prev,
        { id: ackId, role: 'assistant', content: '' } as ConversationMessage,
        { id: assistantId, role: 'assistant', content: '' } as ConversationMessage,
      ]);

      // Per-FRAME bubble writes, not per token: every delta is one token, and
      // cloning the message array per token competes with the per-token
      // decrypt for the same JS thread on a low-end device.
      let acc = '';
      let queued = false;
      let armed = true;
      // Cleared as the turn OPENS, so a box never shows the previous turn's
      // terminal while this one is still running.
      cloud().setAgentTerminal(null);
      const flush = () => {
        queued = false;
        if (!armed) return;
        useCloudChatStore
          .getState()
          .setMessages((prev) =>
            prev.map((m) => (m.id === ackId ? { ...m, content: acc } : m)),
          );
      };
      const schedule = () => {
        if (queued) return;
        queued = true;
        scheduleFrame(flush);
      };

      const onLeg = (leg: AgentLeg) => {
        // The SHAPE of each leg: which tools, how many facts it proposed, and
        // sizes. Never content: no inference text in any log, dev builds
        // included (owner ruling).
        logger.debug(`${TAG} agent leg`, {
          leg: leg.index,
          role: leg.role,
          forced: leg.forced === true,
          stateLength: (leg.messages[0]?.content ?? '').length,
          tools: leg.toolCalls.map((c) => c.name),
          proposedCount: leg.toolCalls
            .filter((c) => c.name === 'saveExtractedFacts')
            .reduce((n, c) => {
              const list = parseToolArgs(c.argumentsRaw).extracted_user_information;
              return n + (Array.isArray(list) ? list.length : 0);
            }, 0),
          textLength: leg.rawOutput.length,
        });
        // Live progress rows: the result only arrives at the end of a turn that
        // can run ~10s, so the steps box would otherwise sit empty and then
        // fill at once.
        if (leg.toolCalls.length === 0) return;
        // `input` IS THE TOOL'S ARGUMENTS. It carried the tool RESULT, and
        // every card the thread derives reads arguments: `ask_choice` looks for
        // `input.options`, and its result is `{awaiting:'user'}`, so the chips
        // were dropped for having fewer than two options. Measured on device,
        // "I live in Nieuw-West Amsterdam" ran a correct three-leg turn ending
        // `awaiting-user` with ask_choice called, and the user saw only the
        // acknowledgement and then nothing: the model had asked which Nieuw-West
        // and the question never reached the screen. Shipped in 7b3f77d3.
        const records: ToolCallRecord[] = leg.toolCalls.map((c, i) => ({
          id: `leg${leg.index}-${i}`,
          name: c.name,
          input: parseToolArgs(c.argumentsRaw),
          result: leg.toolResults[i]?.result as Record<string, unknown> | undefined,
          status: leg.toolResults[i] ? 'done' : 'pending',
        }));
        cloud().setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, toolCalls: [...(m.toolCalls ?? []), ...records] } : m,
          ),
        );
      };

      // The live step row. Written only while THIS turn still owns the line:
      // a tool past its Stop guard finishes on its own, and its `end` must not
      // clear the next turn's row.
      const turnSink = phaseSinkRef.current;
      const onTool: ToolSignal = (event, tool) => {
        if (!alive || turnSink === null || phaseSinkRef.current !== turnSink) return;
        if (event === 'start') useChatPhaseStore.getState().toolStarted(tool);
        else useChatPhaseStore.getState().toolEnded();
      };

      try {
        const out = await runAgentTurn({
          state: agentStateRef.current,
          userMessage,
          deps: withCombinedFactMemory(makeAgentDeps(
            userMessage,
            (d) => {
              // The arrival signal carries no payload, and the line is already
              // on `thinking` from the post-headers route, so there is nothing
              // to do here but avoid falling into the content branch.
              if (d.reasoning !== undefined && acc === '') return;
              if (d.content) {
                // The ACKNOWLEDGEMENT. It is not the answer, so the wait line
                // below it keeps running until the answer lands; releasing it
                // here emptied the wait bubble under the acknowledgement
                // (ux1 C2). The turn's own finally releases it.
                acc += d.content;
                schedule();
              }
            },
            (signal) => phaseSinkRef.current?.(signal),
            stopRef.current.signal,
            cardTools(),
            onTool,
          )),
          onLeg,
          // Mera's two replacement lines, in the reader's language.
          fallbacks: {
            leak: i18nInstance().t('chat.replyLeakFallback'),
            process: i18nInstance().t('chat.replyProcessFallback'),
            noAnswer: noAnswerLine(),
          },
        });
        if (queued) flush();
        if (stopRef.current.signal.aborted) {
          // STOPPED: the partial acknowledgement stays as the reply, and nothing
          // else the turn produced is kept (no cards, no terminal, no state).
          // What the reader SAW still counts as context: their message and the
          // partial text go in as the earlier exchange. The question, choice,
          // skill and offers of the half-run turn do not carry over.
          Object.assign(agentStateRef.current.turn, {
            pendingChoice: null,
            resolvedChoice: null,
            lastTurnAskedQuestion: false,
            lastQuestion: null,
            lastRoute: null,
            lastSkill: null,
            confirmedPlace: null,
            offeredStatements: [],
            lastUserMessage: userMessage,
            lastReply: replaceClauseDashes(acc).trim() || null,
          });
          // The loop has already recorded this exchange with its own view of
          // the reply; the reader saw the partial text instead.
          {
            const t = agentStateRef.current.turn;
            t.recentExchanges = [
              ...t.recentExchanges.slice(0, -1),
              { user: userMessage, reply: t.lastReply ?? '' },
            ];
          }
          // A card staged on THIS turn goes with it; an earlier turn's card, and
          // an apply that already completed, stay as they were.
          const card = agentStateRef.current.turn.lastCard;
          const shown = useFloatingChatStore.getState().proposal;
          if (alive && card && card.turn === agentStateRef.current.turn.turnNumber && shown && card.proposalId === shown.id) {
            useFloatingChatStore.getState().setProposal(null);
          }
          cloud().setMessages((prev) =>
            prev.map((m) =>
              m.id === ackId
                ? { ...m, content: replaceClauseDashes(acc) }
                : m.id === assistantId
                  ? { ...m, content: '' }
                  : m,
            ),
          );
          return;
        }
        // The loop's text is dash-cleaned and gated; the streamed accumulation
        // is not, so these final writes are the authoritative ones. An
        // acknowledgement the loop dropped (it narrated or leaked) empties its
        // bubble, which then stops rendering.
        // ONE BUBBLE PER TURN (owner ruling ux2 D12, option a). The streamed
        // acknowledgement restated the user's message, and with the answer
        // below it every turn read as an echo. An answer with text now takes
        // the acknowledgement's slot (the emptied bubble stops rendering); a
        // card-only turn keeps the acknowledgement as its one bubble.
        const answer = out.reply.trim();
        cloud().setMessages((prev) =>
          prev.map((m) =>
            m.id === ackId
              ? { ...m, content: answer ? '' : out.acknowledgement }
              : m.id === assistantId
                ? { ...m, content: out.reply }
                : m,
          ),
        );
        cloud().setAgentTurnState({ ...agentStateRef.current.turn });
        // ON SCREEN, not only in the log. Four distinct terminals used to reach
        // the user as whatever prose the last leg produced, and an empty one as
        // an empty bubble.
        cloud().setAgentTerminal(out.terminalReason);
        // A turn that settled proves the model answers, so the header badge says so.
        if (out.terminalReason === 'settled' || out.terminalReason === 'awaiting-user') markChatReady();
        // WHY A TURN PRODUCED WHAT IT DID, in one line. The abnormal-terminal
        // warn below fires only for a non-settled turn, so a turn that settled
        // having shown the user nothing logged nothing at all and could only be
        // guessed at from token counts.
        logger.debug(`${TAG} agent turn summary`, {
          terminal: out.terminalReason,
          legs: out.legs.length,
          proposals: out.proposals.length,
          reProposals: out.reProposals,
          forcedProposal: out.forcedProposal,
          replyChars: out.reply.length,
          skill: out.skillLoaded,
          replyRetries: out.replyRetries,
          toolCalls: out.legs.flatMap((l) => l.toolCalls.map((t) => t.name)),
        });
        if (out.terminalReason !== 'settled' && out.terminalReason !== 'awaiting-user') {
          logger.warn(`${TAG} agent turn ended abnormally`, {
            reason: out.terminalReason,
            unknownTools: out.unknownTools,
            legs: out.legs.length,
          });
        }
      } finally {
        armed = false;
        // The line is released in `startTurn`'s finally, which is the ONE
        // owner. This block runs inside that try, and a second release here
        // would only make the ownership ambiguous for the next reader.
      }
    };

  const runSingleShot = async (
      systemPrompt: string,
      tools: ToolDefinition[],
      assistantId: string,
      context: string,
    ): Promise<void> => {
      const store = cloud();
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
      ): Promise<{ accContent: string; toolCalls: ReturnType<typeof finalizeToolCalls> }> => {
        let accContent = '';
        const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

        // Window wireMessages to a TOKEN BUDGET (not a message count), newest
        // first. selectHistoryWindow owns the two structural invariants — the
        // window starts on a user turn, and never splits an
        // assistant(tool_calls) / tool result pair — so the continuation pass,
        // which lands here with the tail [user, assistant(tool_calls), tool],
        // keeps that tail intact.
        const allWire = cloud().wireMessages;
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
          tools,
          toolChoice: 'auto',
          stream: true,
          model: BIG_MODEL,
          maxTokens: CHAT_MAX_OUTPUT_TOKENS,
          enableThinking: agentRef.current.chatThinking,
          onPhase: (signal) => phaseSinkRef.current?.(signal),
          signal: stopRef.current.signal,
        });

        // ONE store write per frame, not per token. Every SSE delta is a
        // single token, so a 300-token reply used to be 300 `setMessages`
        // calls, each cloning the message array and re-rendering the whole
        // thread — on a low-end Android that render work competed with the
        // per-token decrypt for the same JS thread. Text is accumulated on
        // every delta as before; only the store write is deferred to the next
        // frame. `flushContentRender` commits synchronously at stream end so
        // nothing downstream (tool execution, persistence, tests) ever sees
        // a bubble that lags the accumulated text.
        let renderQueued = false;
        let renderArmed = true;
        // Hands the wait line over. Idempotent in the sink.
        const releaseWaitLine = () => phaseSinkRef.current?.(null);
        const renderContent = () => {
          renderQueued = false;
          if (!renderArmed) return; // the stream failed; the error bubble owns the slot now
          // Dash-cleaned on EVERY render, not only at the end: a cleanup that
          // landed after the stream re-wrapped a finished bubble by a line
          // (ux1 C2, a 21pt shift after the reply had settled).
          const shown = replaceClauseDashes(accContent);
          // THE HANDOVER, in the same tick as the first visible text. It used
          // to happen on the delta, a frame before this render, so the wait
          // bubble emptied and the thread dropped 42pt, then rose again when
          // the reply mounted (ux1 C2). Now the reply takes the wait row's
          // slot in one commit.
          if (shown.length > 0) releaseWaitLine();
          cloud().setMessages((prev) =>
            prev.map((m) => m.id === targetId ? { ...m, content: shown } : m),
          );
        };
        const scheduleContentRender = () => {
          if (renderQueued) return;
          renderQueued = true;
          scheduleFrame(renderContent);
        };
        const flushContentRender = () => {
          if (renderQueued) renderContent();
        };

        let eventCount = 0;
        try {
        for await (const event of stream) {
          eventCount++;
          if (eventCount <= 5 || event.type === 'finish' || event.type === 'error') {
            logger.debug(`${TAG} SSE event #${eventCount}`, {
              type: event.type,
              ...(event.type === 'text-delta' ? { deltaLength: event.delta.length } : {}),
              ...(event.type === 'tool-call-delta' ? { name: event.name } : {}),
            });
          }
          if (event.type === 'reasoning') {
            // Tolerated and ignored. The trace is dropped undecrypted upstream,
            // and the line is already on `thinking` from the post-headers
            // route, which fires on every call including the many that emit no
            // reasoning at all.
          } else if (event.type === 'text-delta') {
            accContent += event.delta;
            scheduleContentRender();
          } else if (event.type === 'tool-call-delta') {
            // No handover here: the wait row stays until text lands or the
            // steps box takes over, never an empty bubble in between.
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
        flushContentRender();
        // THE DASH RULE, for the agents that do not run through the loop. The
        // loop cleans its own replies; the single-shot "why was this shown"
        // answer reached users with an em dash in it. Applied once the stream
        // is whole, so a clause dash split across two deltas is still seen.
        const cleaned = replaceClauseDashes(accContent);
        if (cleaned !== accContent) {
          accContent = cleaned;
          renderContent();
        }
        } catch (err) {
          // STOP: land the tokens already received before the exception
          // disarms the render, or the last frame's worth of the partial reply
          // never reaches the bubble.
          if (stopRef.current.signal.aborted) flushContentRender();
          throw err;
        } finally {
          renderArmed = false;
          // Released in `startTurn`'s finally, the one owner. See the agent
          // loop's matching note.
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
        cloud().pushWireMessage(
          wireToolCalls
            ? { role: 'assistant', content: accContent, tool_calls: wireToolCalls }
            : { role: 'assistant', content: accContent },
        );
      };

      // Execute tool calls in parallel, render each result into the bubble AS IT
      // SETTLES, and push tool result messages onto wire (preserving order).
      //
      // TWO RULES, both load-bearing, both previously violated here:
      //
      //  1. WRITE BACK PER PROMISE, not once behind the slowest call. This used
      //     to `await Promise.all(...)` and then write every record in ONE
      //     setMessages, so the UI could never observe a staggered "2 done, 1
      //     pending" state -- every row flipped at the same instant. The chat's
      //     per-tool-call progress rows need the intermediate states.
      //
      //  2. Replace the record with a FRESH OBJECT at its ORIGINAL INDEX, never
      //     mutate in place. The old code did `records[i].status = ...` and then
      //     re-wrapped the same array, so a row memoized on its own `toolCall`
      //     prop was blind to its own status changing. And the index must be the
      //     call's own, never completion order: `fact-commit.ts` and
      //     `deriveThreadItems.ts` key card identity on
      //     `${messageId}::${toolCallIndex}`, so a result landing in the wrong
      //     slot corrupts identity, not merely display order.
      //
      // useLocalLLM.ts already satisfies both by construction (sequential loop,
      // fresh .map() each time); this parallel path is the one that needed them
      // spelled out.
      const executeToolsAndPushResults = async (
        targetId: string,
        toolCalls: ReturnType<typeof finalizeToolCalls>,
      ) => {
        // No tool starts after Stop. One already running finishes atomically.
        throwIfStopped();
        const pendingRecords: ToolCallRecord[] = toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
          status: 'pending' as const,
        }));
        cloud().setMessages((prev) =>
          prev.map((m) => m.id === targetId ? { ...m, toolCalls: pendingRecords } : m),
        );

        // Settled payloads by ORIGINAL index, for the wire push below.
        const settled = new Array<
          { result: Record<string, unknown>; status: 'done' | 'error' } | undefined
        >(toolCalls.length);

        /** Commit ONE call's outcome at its own index, as a new record object.
         *  Siblings keep their identity so an unsettled row does not re-render. */
        const writeBack = (
          index: number,
          result: Record<string, unknown>,
          status: 'done' | 'error',
        ) => {
          settled[index] = { result, status };
          cloud().setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== targetId) return m;
              const current = m.toolCalls ?? pendingRecords;
              return {
                ...m,
                toolCalls: current.map((rec, i) =>
                  i === index ? { ...rec, result, status } : rec,
                ),
              };
            }),
          );
        };

        const knownNames = (agentRef.current.getToolDefinitions?.() ?? []).map(
          (d) => d.function.name,
        );

        // The whole batch is work on the phone, not a model call, so the strip
        // rests there (searchNews is a plain GraphQL query). Only while this
        // turn owns the line: the forced pass runs after the sink is cleared.
        const turnSink = phaseSinkRef.current;
        const ownsLine = () => alive && turnSink !== null && phaseSinkRef.current === turnSink;
        if (ownsLine()) useChatPhaseStore.getState().setDeviceWork(true);
        try {
          await Promise.all(
            toolCalls.map(async (tc, i) => {
              // Never execute a call whose arguments did not parse — surface it
              // as an error the user can see instead of running it with {}.
              if (tc.malformed) {
                writeBack(
                  i,
                  { error: 'malformed tool arguments — call was not executed' },
                  'error',
                );
                return;
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
                logger.debug(`${TAG} tool result`, { name: tc.name, resultLength: JSON.stringify(result).length, sideEffects: sideEffects ? Object.keys(sideEffects) : [] });

                applyToolSideEffects(sideEffects, { alive, cloud: cloud() });

                // Committed HERE, the moment this call settles — not after the
                // slowest sibling.
                writeBack(i, result, 'done');
              } catch (err) {
                logger.error(`${TAG} Tool execution failed`, undefined, { tool: tc.name, error: String(err) });
                writeBack(i, { error: String(err) }, 'error');
              }
            }),
          );
        } finally {
          if (ownsLine()) useChatPhaseStore.getState().setDeviceWork(false);
        }

        // The WIRE push stays here, after every call has settled: the wire is
        // ordered, and a `role:'tool'` message must follow its
        // `assistant(tool_calls)` partner intact. Only calls that made it onto
        // the wire are owed a reply. Indexed by the call's own position, never
        // by id — local ids are `local-tc-${n}` and collide across messages.
        toolCalls.forEach((tc, i) => {
          if (tc.malformed) return;
          const resultPayload = settled[i]?.result ?? { error: 'no result' };
          cloud().pushWireMessage({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(resultPayload),
          });
        });
      };

      // ---------- First pass ----------
      const placeholder: ConversationMessage = { id: assistantId, role: 'assistant', content: '' };
      cloud().setMessages((prev) => [...prev, placeholder]);

      // 'auto' (explicit): a text-only reply finishes in one round trip; the
      // model still calls a tool when the turn warrants one (→ continuation).
      const first = await streamOne(assistantId, true);
      throwIfStopped();
      pushAssistantToWire(first.accContent, first.toolCalls);

      if (first.toolCalls.length > 0) {
        await executeToolsAndPushResults(assistantId, first.toolCalls);
      }

      // ---------- Knowledge tools ----------
      // A knowledge tool (explainMera) returns REFERENCE TEXT that only matters
      // if the model gets to read it. Names are resolved through
      // normalizeToolName against the agent's OWN live definitions, so a model
      // that emits `explain_mera` is still recognised.
      const isKnowledgeName = (tc: { name: string }): boolean => {
        const known = (agentRef.current.getToolDefinitions?.() ?? []).map(
          (d) => d.function.name,
        );
        return KNOWLEDGE_TOOL_NAMES.has(normalizeToolName(tc.name, known) ?? tc.name);
      };

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

      // ---------- Continuation pass ----------
      // When the model returns tool calls but no conversational text — or ran a
      // knowledge tool — post the tool results back and let it produce a real
      // reply in a fresh bubble. Capped at one continuation: if the second turn
      // also drops text, leave the bubble blank rather than looping, and a
      // knowledge tool re-called there is a wasted call, not a recursion.
      if (needsContinuation) {
        const followUpId = `asst-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        logger.debug(`${TAG} sending follow-up turn`, {
          reason: calledKnowledgeTool ? 'knowledge tool result' : 'no text from LLM',
          wireMessages: cloud().wireMessages.length,
        });
        const followUpPlaceholder: ConversationMessage = { id: followUpId, role: 'assistant', content: '' };
        cloud().setMessages((prev) => [...prev, followUpPlaceholder]);

        const second = await streamOne(followUpId, true);
        throwIfStopped();
        pushAssistantToWire(second.accContent, second.toolCalls);
        if (second.toolCalls.length > 0) {
          await executeToolsAndPushResults(followUpId, second.toolCalls);
        }
      }
    };

  /**
   * One turn. `visible: false` runs it without ever appending a
   * `ConversationMessage`, so nothing is drawn and — because the session's persistence
   * reads `messages`, not the wire — nothing is stored either. The model still
   * sees an ordinary trailing `user` turn with fresh <context> on it.
   */
  /** After a stop: drop the stopped turn's tool calls (nothing is staged or
   *  saved from a half-run turn) and mark the last bubble with text, or the
   *  answer slot when nothing was said, as stopped. The partial text stays. */
  const markStopped = (assistantId: string): void => {
    const ids = new Set([`${assistantId}-ack`, assistantId]);
    cloud().setMessages((prev) => {
      const turn = prev.filter((m) => ids.has(m.id));
      const target = [...turn].reverse().find((m) => m.content.trim().length > 0) ?? turn[turn.length - 1];
      return prev.map((m) =>
        !ids.has(m.id)
          ? m
          : { ...m, toolCalls: undefined, ...(m.id === target?.id ? { stopped: true } : {}) },
      );
    });
  };

  const startTurn = (text: string, visible: boolean) => {
      const store = cloud();
      logger.debug(`${TAG} startTurn`, { visible, isStreaming: isStreamingRef.current, isBlocked: store.isBlocked });
      // A turn started while one runs would push a `user` wire message between
      // an `assistant(tool_calls)` and its `tool` replies, which most
      // OpenAI-compatible endpoints reject.
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

      logger.debug(`${TAG} sendMessage proceeding`, { length: trimmed.length });
      store.setError(null);

      if (visible) {
        const userMsg: ConversationMessage = {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: 'user',
          content: trimmed,
          createdAt: Date.now(),
        };
        store.setMessages((prev) => [...prev, userMsg]);
      }

      setTurnBusy(true);
      isStreamingRef.current = true;
      store.setStatus('streaming');
      stopRef.current = new AbortController();
      const turnStop = stopRef.current;

      // SYNCHRONOUSLY, before the async IIFE. Everything between here and the
      // first gateway call is real work the user waits through:
      // `buildSystemPrompt`, `getToolDefinitions`, `buildContext` (a DB read)
      // and, on the persona path, `buildAgentPersona`. Publishing from inside
      // the IIFE would leave the opening frames of the wait unnarrated, which
      // is the gap this line exists to close.
      useChatPhaseStore.getState().reset();
      const phase = makePhaseSink((p) => {
        if (alive) applyChatPhase(p);
      });
      phaseSinkRef.current = phase;
      phase('preparing');

      const assistantId = `asst-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      void (async () => {
        try {
          if (runsOnHarness(agentRef.current.id)) {
            // THE SHIPPED PATH for the persona agent. No flag: a loop behind a
            // flag is a loop nobody runs, which is exactly how the device pass
            // found the old single-shot prompt still live.
            //
            // The one-shot system prompt, tools and context are NOT built here.
            // They were built and logged on every turn while the loop sent its
            // own router prompt and state line, so the log showed a prompt the
            // model never saw (its "Middle East politics" example and its
            // searchNews rule were blamed for a turn they never reached).
            cloud().pushWireMessage({ role: 'user', content: trimmed });
            await runAgentLoopTurn(assistantId, trimmed);
            logger.debug(`${TAG} agent loop completed`);
          } else {
            const systemPrompt = await agentRef.current.buildSystemPrompt(false);
            logger.debug(`${TAG} system prompt built`, { length: systemPrompt.length });

            const tools = agentRef.current.getToolDefinitions?.() ?? [];
            logger.debug(`${TAG} tool definitions`, { count: tools.length, names: tools.map(t => t.function.name) });

            let context = '';
            if (agentRef.current.buildContext) {
              try {
                context = await agentRef.current.buildContext();
                logger.debug(`${TAG} context built`, { length: context.length });
              } catch (err) {
                logger.warn(`${TAG} buildContext failed, proceeding without context`, { error: String(err) });
              }
            }
            // A8: the stories the user followed from cards, so the model does not offer them again.
            const followed = followedInChatLabels(cloud().messages);
            if (followed.length > 0) context = `${context}\nuser followed: ${followed.join(', ')}`.trim();
            // Push only the RAW user text into wireMessages. Context is re-injected
            // fresh onto the last user message in runSingleShot — never persisted,
            // so multi-turn chats don't accumulate N copies of the facts/guide block.
            cloud().pushWireMessage({ role: 'user', content: trimmed });
            logger.debug(`${TAG} starting runSingleShot`, { wireMessages: cloud().wireMessages.length });
            await runSingleShot(systemPrompt, tools, assistantId, context);
            logger.debug(`${TAG} runSingleShot completed`);
          }
        } catch (err) {
          // A stop is not a failure: no banner, no report.
          if (!turnStop.signal.aborted) {
            const msg = `Cloud chat failed: ${(err as Error)?.message ?? String(err)}`;
            logger.error(`${TAG} sendMessage failed`, err, { stack: (err as Error)?.stack });
            cloud().setError(msg);
            markChatFailed();
          }
        } finally {
          if (turnStop.signal.aborted) {
            // The single-shot agents read history from the wire: the visible
            // partial reply belongs there (the persona loop keeps its own state).
            if (!runsOnHarness(agentRef.current.id)) {
              const state = cloud();
              const partial = state.messages.find((m) => m.id === assistantId)?.content.trim();
              // Only when nothing of this turn reached the wire yet (it still
              // ends on the user's message): a later pass pushed its own.
              if (partial && state.wireMessages[state.wireMessages.length - 1]?.role === 'user') {
                cloud().pushWireMessage({ role: 'assistant', content: partial });
              }
            }
            markStopped(assistantId);
          }
          logger.debug(`${TAG} startTurn done, setting idle`);
          // THE ONE RELEASE, and it is in a `finally` on purpose: it has to run
          // on the throw path too, or a 429 leaves the line reassuring the user
          // underneath the error banner for the rest of the session.
          phase(null);
          if (phaseSinkRef.current === phase) phaseSinkRef.current = null;
          cloud().setStatus('idle');
          isStreamingRef.current = false;
          if (alive) useFloatingChatStore.getState().setTopicPlanTurnInFlight(false);
          // Runs on a throw too, so a transport failure ends the turn here.
          setTurnBusy(false);
          flushPendingHiddenTurn();
        }
      })();
    };

  startTurnRef.current = startTurn;

  /** The Stop button's handle on a More options call in flight. */
  let moreAbort: AbortController | null = null;

  const moreOptions = async (req: MoreOptionsRequest): Promise<MoreOptionsResult> => {
    if (turnBusyRef.current || isStreamingRef.current) return { actions: [], reason: 'busy' };
    const ctl = new AbortController();
    moreAbort = ctl;
    try {
      const id = agentRef.current.id;
      const state: AgentState = agentStateRef.current
        ? structuredClone(agentStateRef.current)
        : createAgentState(await buildAgentPersona(id));
      state.surfaceContext = surfaceFor();
      state.followedInChat = followedInChatLabels(cloud().messages);
      // CAPTURE the staged card; this is not a turn, so nothing reaches the store.
      let staged: ProposalAction[] = [];
      const deps = makeAgentDeps('', () => {}, undefined, ctl.signal, {
        ...cardTools(),
        onSideEffects: (se) => {
          staged = se?.proposal?.actions ?? staged;
        },
      });
      await runAgentTurn({
        state,
        userMessage: '',
        deps,
        mode: 'moreOptions',
        moreOptions: { shown: req.shown, room: req.room },
        fallbacks: {
          leak: i18nInstance().t('chat.replyLeakFallback'),
          process: i18nInstance().t('chat.replyProcessFallback'),
          noAnswer: noAnswerLine(),
        },
      });
      if (ctl.signal.aborted) return { actions: [], reason: 'stopped' };
      const seenLabels = new Set(req.shown.map((o) => normaliseTrackText(o.label)));
      const seenSearch = new Set(req.shown.map((o) => normaliseTrackText(o.searchText)));
      const actions: MoreOptionsResult['actions'] = [];
      for (const a of staged) {
        if (a.type !== 'track_story' || actions.length >= req.room) continue;
        const label = normaliseTrackText(a.label);
        const search = normaliseTrackText(a.searchText);
        if (seenLabels.has(label) || seenSearch.has(search)) continue;
        seenLabels.add(label);
        seenSearch.add(search);
        actions.push({ ...a, subject: req.subject });
      }
      return { actions, reason: actions.length > 0 ? undefined : 'none' };
    } catch (err) {
      if (ctl.signal.aborted) return { actions: [], reason: 'stopped' };
      logger.warn(`${TAG} moreOptions failed`, { error: String(err) });
      return { actions: [], reason: 'failed' };
    } finally {
      if (moreAbort === ctl) moreAbort = null;
    }
  };

  return {
    send: (text) => {
      if (alive) startTurn(text, true);
    },
    moreOptions,
    sendHidden: (text) => {
      if (alive) startTurn(text, false);
    },
    setAgent: (agent) => {
      agentRef.current = agent;
    },
    stop: () => {
      // A hidden turn queued behind the running one is part of the same stop.
      pendingHiddenTurnRef.current = null;
      stopRef.current.abort();
      moreAbort?.abort();
    },
    dispose: () => {
      detached = detachedCopy(useCloudChatStore.getState());
      alive = false;
    },
  };
}
