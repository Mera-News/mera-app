// Pure derivation of the flat, render-ready thread item list.
//
// This module has NO React Native / React dependencies so it can be unit-tested
// in isolation. It takes the current in-memory session (`live`), the persisted
// older messages (`history`), and a few flags, and produces a flat
// `ChatThreadItem[]` ordered newest-LAST (ChatThread inverts internally).

import type { ConversationMessage, ToolCallRecord } from '@/lib/llm/types';
import {
  readGroupResolutions,
  readPendingGroups,
} from '@/lib/chat-tools/fact-choice-resolution';
import { isFactPickChoice, joinFactPick } from '@/lib/mera-harness/core/fact-pick';
import { stripThinkTags } from '@/lib/algorithms/think-strip';
import type { LiveTool } from '@/lib/llm/chat-phase-store';
import type { QuickFactCheckEntry } from '@/lib/stores/floating-chat-store';
import type {
  AgentTerminal,
  ChatThreadItem,
  PersistedMessage,
} from './types';
import {
  asRecord,
  conflictsFromResult,
  deriveCard,
  emitFactChoiceGroups,
  pushSavedAsWritten,
  saveAsWrittenOf,
  savedFactsWithIds,
  toStringArray,
} from './derive-fact-cards';
import {
  deriveFactCheckProposal,
  deriveProposal,
  deriveTrackProposal,
} from './derive-proposals';
import { readTrackOutcomes } from './track-options';
import {
  bubbleCarries,
  buildTurnBoxes,
  keepBox,
  type AgentStepsItem,
} from './derive-steps';

/**
 * A proposal card sits AFTER the turn's last assistant bubble.
 *
 * A single-shot turn is two messages: the tool call (which owns the card) and
 * the reply that follows the tool result. Emitted in message order, the card
 * came first and its own instruction ("Pick the story you want to follow
 * below") came after it (audit F34). Moved within its own turn only, never
 * past the next user message or the live tail.
 */
function placeProposalCardsLast(items: ChatThreadItem[]): ChatThreadItem[] {
  const out = [...items];
  const isBoundary = (it: ChatThreadItem) =>
    (it.kind === 'message' && it.message.role === 'user')
    || it.kind === 'typing'
    || it.kind === 'quick-fact-check-card'
    || it.kind === 'divider';
  for (let i = 0; i < out.length; i++) {
    const card = out[i];
    if (card.kind !== 'proposal-card') continue;
    let lastBubble = -1;
    for (let j = i + 1; j < out.length && !isBoundary(out[j]); j++) {
      const it = out[j];
      if (it.kind === 'message' && it.message.role === 'assistant') lastBubble = j;
    }
    if (lastBubble === -1) continue;
    out.splice(i, 1);
    out.splice(lastBubble, 0, card);
    i--; // the item now at i has not been examined
  }
  return out;
}

/** The change-log ids of an applyProposal that really changed something, else null. */
function appliedByTyping(tc: ToolCallRecord): string[] | null {
  const r = asRecord(tc.result);
  if (!r || typeof r.applied !== 'number' || r.applied <= 0) return null;
  const ids = toStringArray(r.changeLogIds);
  return ids.length > 0 ? ids : null;
}

// ---------------------------------------------------------------------------
// Message → thread items
// ---------------------------------------------------------------------------

/**
 * Emits a message item (if non-placeholder) followed by any fact cards.
 * `keyPrefix` distinguishes history (`hist`) from live (`live`) sources.
 */
interface StreamingInfo {
  id: string;
  showWords: boolean;
  engine: 'cloud' | 'local';
  handover: boolean;
}

function emitMessage(
  out: ChatThreadItem[],
  message: ConversationMessage,
  keyPrefix: 'hist' | 'live',
  toolCallResults: Record<string, Record<string, unknown>> = {},
  stale = false,
  boxes?: Map<string, AgentStepsItem>,
  answeredAsk = false,
  streaming: StreamingInfo | null = null,
): void {
  // A hidden turn is the model's business only — it produces no bubble and no
  // cards. Filtered here rather than at the call sites so every source (live,
  // resume, history) is covered by one line.
  if (message.hidden) return;
  // Think tags are stripped at the engines; this covers history persisted
  // before that, one line for every source.
  if (message.role === 'assistant') {
    const shown = stripThinkTags(message.content);
    if (shown !== message.content) message = { ...message, content: shown };
  }

  const cards: ChatThreadItem[] = [];
  if (message.role === 'assistant' && message.toolCalls) {
    message.toolCalls.forEach((tc0, idx) => {
      // A tool result REWRITTEN after the fact wins over the persisted one. A
      // fact-choice card commits from the UI long after the model's call
      // returned `staged: true`, and every card below reads `savedFacts` off the
      // result — so the commit rewrites the result rather than teaching each
      // card a second source. Keyed by message id + INDEX: local tool-call ids
      // are `local-tc-${n}` and collide across messages.
      const override = toolCallResults[`${message.id}::${idx}`];
      const tc = override ? { ...tc0, result: override, status: 'done' as const } : tc0;
      // Proposal cards take precedence — a `proposeChanges` call never doubles
      // as a fact card (and applyProposal/cancelProposal surface nothing).
      const proposal =
        deriveProposal(tc) ?? deriveTrackProposal(tc) ?? deriveFactCheckProposal(tc);
      if (proposal) {
        const result = asRecord(tc.result);
        cards.push({
          kind: 'proposal-card',
          key: `proposal-${message.id}-${idx}`,
          proposal,
          ...(tc.name === 'proposeTrack'
            ? {
                track: {
                  resultKey: `${message.id}::${idx}`,
                  baseResult: asRecord(tc0.result) ?? {},
                  outcomes: readTrackOutcomes(result?.followed),
                  dismissed: result?.dismissed === true,
                  superseded: false,
                },
              }
            : {}),
        });
        return;
      }
      // A change applied by a typed yes: one row, with Undo until the user
      // sends another message (same rule as a skipped card).
      if (tc.name === 'applyProposal') {
        const applied = appliedByTyping(tc);
        if (applied) {
          cards.push({
            kind: 'applied-by-typing',
            key: `applied-${message.id}-${idx}`,
            changeLogIds: applied,
            undoable: !stale && !answeredAsk,
          });
        }
        return;
      }
      // ask_choice: chips under this bubble. Derived from the tool INPUT, and
      // `answered` is decided by the caller, which is the only place that can
      // see whether a later user message exists.
      // "SAVE AS I WROTE IT" standing alone: the loop wrote it after a lookup
      // that placed nothing (ux2 D9). Rendered as a chip-only card.
      if (tc.name === 'saveAsWritten') {
        const own = saveAsWrittenOf(tc, `${message.id}::${idx}`);
        if (own?.saved) pushSavedAsWritten(cards, message.id, idx, own.saved, own.offer.entry.topic_skill_id);
        else if (own) {
          cards.push({
            kind: 'ask-choice-card',
            key: `ask-choice-${message.id}-${idx}`,
            question: null,
            options: [],
            saveAll: null,
            saveAsWritten: own.offer,
            answered: answeredAsk,
          });
        }
        return;
      }
      if (tc.name === 'ask_choice') {
        // CHIPS ONLY FOR A QUESTION THE LOOP ACCEPTED (ux2 D4). A refused call
        // (`{error}`) still rendered chips, so the user saw a question beside
        // the card the loop offered instead, and a chip read as Mera's own
        // first-person sentence. A record with no result yet is still waiting.
        const askResult = asRecord(tc.result);
        if (askResult && askResult.awaiting !== 'user') return;
        const askInput = asRecord(tc.input) ?? {};
        const allOptions = toStringArray(askInput.options);
        // An on-device Kev ask (D39) is always a pick-one, even over fact
        // statements ("which fact do you mean"), and carries Something else.
        const somethingElse = askInput.somethingElse === true;
        // Distinct facts are never a pick-one: their chip list carries Save
        // all, which always covers EVERY option, even past the chips shown.
        const factPick = !somethingElse && isFactPickChoice(allOptions);
        const options = allOptions.slice(0, factPick ? 4 : 3);
        const own = saveAsWrittenOf(tc, `${message.id}::${idx}`);
        if (options.length >= 2) {
          const question =
            typeof askInput.question === 'string' ? askInput.question.trim() : '';
          cards.push({
            kind: 'ask-choice-card',
            key: `ask-choice-${message.id}-${idx}`,
            // Suppressed ONLY when the bubble already carries the question as
            // prose. It used to be suppressed whenever the bubble had ANY text,
            // so an acknowledgement or a narration beside the call left the
            // chips on screen with no question above them.
            question: !question || bubbleCarries(message.content, question) ? null : question,
            options,
            saveAll: factPick ? joinFactPick(allOptions) : null,
            saveAsWritten: own && !own.saved ? own.offer : null,
            ...(somethingElse ? { somethingElse: true } : {}),
            answered: answeredAsk,
          });
          if (own?.saved) pushSavedAsWritten(cards, message.id, idx, own.saved, own.offer.entry.topic_skill_id);
        }
        return;
      }

      const card = deriveCard(tc);
      // One pending-delete card per statement set per message: the model
      // retrying a blocked delete must not stack identical cards.
      if (
        card
        && card.action === 'deletePending'
        && cards.some(
          (c) =>
            c.kind === 'fact-card'
            && c.action === 'deletePending'
            && c.statements.join('\u0001') === card.statements.join('\u0001'),
        )
      ) {
        return;
      }
      if (card) {
        cards.push({
          kind: 'fact-card',
          key: `card-${message.id}-${idx}`,
          action: card.action,
          statements: card.statements,
          factIds: card.factIds,
          // Live only: a card from an earlier conversation removes nothing.
          ...(card.action === 'deletePending' && card.factIds.length > 0 && !stale
            ? { pendingDelete: { resultKey: `${message.id}::${idx}`, baseResult: asRecord(tc.result) ?? {}, factIds: card.factIds } }
            : {}),
        });
      }

      // Wave 11: after the saved fact-card, surface the conflict resolution
      // card(s) then the per-fact topic-planning widget(s). Additive — the
      // fact-card behaviour above is unchanged.
      if (tc.status === 'done' && tc.name === 'saveExtractedFacts') {
        const result = tc.result ?? {};
        const resolutions = readGroupResolutions(result);
        // The new path owns a blob that is group-shaped OR still has pending
        // groups. The second half matters: a LEGACY PENDING blob (staged by an
        // older bundle, so no marker) is still answerable, and routing it here
        // means `groupIdOf` recomputes its ids and the first commit materialises
        // the marker. Sending it down the legacy branch instead would render it
        // with placeholder ids and write resolutions nothing could read back.
        const pendingGroups = readPendingGroups(result);
        if (resolutions !== null || pendingGroups.length > 0) {
          emitFactChoiceGroups(cards, message.id, idx, result, resolutions ?? {}, stale, answeredAsk);
        } else {
          // LEGACY blob (no `groupResolutions` marker): a result persisted by a
          // pre-change bundle. Rendered exactly as it was — this is the whole
          // reason the marker is written at staging time rather than on first
          // commit, so "old shape" and "new shape" are decidable without
          // guessing from which fields happen to be populated.
          conflictsFromResult(result).forEach((conflict, cIdx) => {
            cards.push({
              kind: 'conflict-card',
              key: `conflict-${message.id}-${idx}-${cIdx}`,
              conflict,
            });
          });
          savedFactsWithIds(result).forEach((fact) => {
            cards.push({
              kind: 'topic-plan-card',
              key: `topic-plan-${message.id}-${idx}-${fact.id}`,
              factId: fact.id,
              factStatement: fact.statement,
            });
          });
        }
      }
    });
  }

  // A stopped turn with nothing said still shows its "Stopped" line.
  const hasContent = message.content.trim().length > 0 || message.stopped === true;
  const ownedBox = boxes?.get(message.id);
  // Skip empty assistant placeholders that produced no cards AND own no steps
  // box. The `ownedBox` clause is the fix: without it a content-less message
  // whose tool calls are still pending returns here and its box never renders.
  if (
    !hasContent &&
    cards.length === 0 &&
    message.role === 'assistant' &&
    !(ownedBox && keepBox(ownedBox))
  ) {
    return;
  }

  if (hasContent || message.role === 'user') {
    out.push({
      kind: 'message',
      key: `${keyPrefix}-${message.id}`,
      message,
      // The Mera mark rides the live streaming bubble, so it does not blink
      // out the moment the first token lands.
      ...(streaming?.id === message.id
        ? {
            streaming: true,
            showWords: streaming.showWords,
            engine: streaming.engine,
            handover: streaming.handover,
          }
        : {}),
    });
  }

  // The turn's steps box, anchored on the message that opened the turn. Pushed
  // BEFORE this message's own cards so the narrative reads work-then-result,
  // and — crucially — pushed outside the early return above, which drops an
  // assistant message that has no content and produced no cards. A turn whose
  // tool calls are all still `pending` is exactly that shape, which is why the
  // thread was silent during tool execution before this existed.
  const box = boxes?.get(message.id);
  if (box && keepBox(box)) out.push(box);

  // Cards appear immediately after their parent message.
  out.push(...cards);
}

/** Normalizes a persisted message to the in-memory ConversationMessage shape. */
function toConversationMessage(m: PersistedMessage): ConversationMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls ?? undefined,
    createdAt: m.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function deriveThreadItems(opts: {
  live: ConversationMessage[];
  history: PersistedMessage[];
  introMessage: string | null;
  isStreaming: boolean;
  earlierConversationLabel: string;
  /**
   * Persisted messages of the CURRENT app-session conversation, oldest-first.
   * Rendered as part of the live session (NO "Earlier conversation" divider —
   * same conversation). Deduped against `live` by id: because messages persist
   * under their in-memory id, a live message already present here is skipped so
   * it renders statically (via resume) instead of replaying the entering anim.
   */
  resume?: PersistedMessage[];
  /**
   * When the chat context is an article-suggestion, the subject article — emitted
   * as a PINNED card at the very top of the thread (before history/intro), so the
   * conversation always shows what it's about (Round-4 P4 handoff).
   */
  articleContext?: { articleId?: string; suggestionId?: string; title: string };
  /**
   * When the chat context is the daily optimisation plan, the interactive plan
   * card is emitted as a PINNED card at the very top of the thread (before
   * history/intro), mirroring `articleContext` (Round-4 C5).
   */
  optimisationPlan?: { key: string };
  /**
   * Quick fact checks started in this thread (oldest-first), appended AFTER the
   * live messages.
   *
   * Injected rather than derived, unlike every other card here, and that is the
   * point: nothing in the message stream produces one. The user taps a claim
   * pill, the check runs off-model, and the answer the reader sees is the one
   * the handler decided — there is no turn in between that could restate "we
   * could not search" as "I found nothing".
   */
  quickFactChecks?: QuickFactCheckEntry[];
  /** Tool results rewritten by a card commit, keyed `${messageId}::${toolCallIndex}`. */
  toolCallResults?: Record<string, Record<string, unknown>>;
  /**
   * TURN-SCOPED: is a turn running right now? From P1's agent turn state.
   *
   * NOT `isStreaming` and not the store's `status`. Both read as stream-scoped,
   * behave turn-scoped almost everywhere, and go idle early during a forced
   * pass — which would paint a healthy turn interrupted in that window. See
   * buildTurnBoxes.
   *
   * `undefined` while P1's state is unwired: the fallback collapses on
   * "everything settled" and marks nothing interrupted unless it is stale.
   */
  turnActive?: boolean;
  /** Why the latest agent turn stopped, when the user needs telling. */
  agentTerminal?: AgentTerminal | null;
  /** Which engine runs this turn. Local always shows the words. */
  engine?: 'cloud' | 'local';
  /** The tool the phone is running between two model calls. */
  liveTool?: LiveTool | null;
  /** A `retrying` phase was shown this turn. */
  retriedThisTurn?: boolean;
}): ChatThreadItem[] {
  const { live, history, introMessage, isStreaming, earlierConversationLabel } = opts;
  const resume = opts.resume ?? [];
  const toolCallResults = opts.toolCallResults ?? {};
  const out: ChatThreadItem[] = [];

  // --- Pinned optimisation-plan card (always first when present) ---
  if (opts.optimisationPlan) {
    out.push({ kind: 'optimisation-plan-card', key: opts.optimisationPlan.key });
  }

  // --- Pinned article-context card (always first) ---
  if (opts.articleContext) {
    out.push({
      kind: 'article-context-card',
      key: 'article-context',
      articleId: opts.articleContext.articleId,
      suggestionId: opts.articleContext.suggestionId,
      title: opts.articleContext.title,
    });
  }

  // --- History (re-sorted oldest-first) ---
  const sortedHistory = [...history].sort((a, b) => a.createdAt - b.createdAt);
  // Turn boxes are computed per SEQUENCE so a turn never spans the
  // "earlier conversation" divider. History is stale by definition.
  const historyBoxes = buildTurnBoxes(
    sortedHistory.map((m) => ({ message: toConversationMessage(m) })),
    true,
    opts.turnActive,
    // NEVER on history: the store's one terminal belongs to the live turn, and
    // stamping it on a box from an earlier conversation would be a lie.
    null,
  );
  let prevConversationId: string | null = null;
  for (const persisted of sortedHistory) {
    // Divider at every conversation boundary (not before the first message).
    if (prevConversationId !== null && persisted.conversationId !== prevConversationId) {
      out.push({
        kind: 'divider',
        key: `div-hist-${persisted.id}`,
        label: earlierConversationLabel,
      });
    }
    prevConversationId = persisted.conversationId;
    // stale: true — an earlier conversation's card can never be committed.
    // An earlier conversation's offer can never be taken: always inert.
    emitMessage(
      out,
      toConversationMessage(persisted),
      'hist',
      toolCallResults,
      true,
      historyBoxes,
      true,
    );
  }

  // --- Divider between OLDER conversations and the current one ---
  if (sortedHistory.length > 0) {
    out.push({ kind: 'divider', key: 'div-live', label: earlierConversationLabel });
  }

  // --- Resumed current-conversation messages (oldest-first, no divider) ---
  const sortedResume = [...resume].sort((a, b) => a.createdAt - b.createdAt);
  const resumeIds = new Set(sortedResume.map((m) => m.id));

  // Resume and live are ONE sequence: a turn's legs can straddle them when
  // persistence lands mid-turn, and splitting them would cut that turn in two.
  // They are not stale — a resumed current-conversation turn is still the live
  // one, which is why the discriminator here is `stale` and never the
  // 'hist' | 'live' key prefix (resumed messages carry the 'hist' prefix).
  // Assistant messages that a later USER message follows. An ask_choice offer
  // on one of these is spent: the user has moved on, by tapping a chip or by
  // typing past it. Derived purely, so no store field records "answered".
  const liveSequence = [
    ...sortedResume.map((m) => toConversationMessage(m)),
    ...live.filter((m) => !resumeIds.has(m.id)),
  ];
  const answeredAskIds = new Set<string>();
  let sawLaterUser = false;
  for (let i = liveSequence.length - 1; i >= 0; i--) {
    const m = liveSequence[i];
    if (m.role === 'user' && !m.hidden) {
      sawLaterUser = true;
      continue;
    }
    if (sawLaterUser) answeredAskIds.add(m.id);
  }

  const liveBoxes = buildTurnBoxes(
    [
      ...sortedResume.map((m) => ({ message: toConversationMessage(m) })),
      ...live.filter((m) => !resumeIds.has(m.id)).map((message) => ({ message })),
    ],
    false,
    opts.turnActive,
    opts.agentTerminal ?? null,
    { liveTool: opts.liveTool ?? null, retried: opts.retriedThisTurn ?? false },
  );
  const engine = opts.engine ?? 'cloud';
  const lastUserIdx = (() => {
    for (let i = liveSequence.length - 1; i >= 0; i--) {
      if (liveSequence[i].role === 'user' && !liveSequence[i].hidden) return i;
    }
    return -1;
  })();
  const lastUserId = lastUserIdx >= 0 ? liveSequence[lastUserIdx].id : null;
  // Words show on a turn's first message only (history excluded), on device,
  // or after a retry.
  const userCount = liveSequence.filter((m) => m.role === 'user' && !m.hidden).length;
  const showWords = engine === 'local' || (opts.retriedThisTurn ?? false) || userCount < 2;
  const ackShowing = liveSequence
    .slice(lastUserIdx + 1)
    .some((m) => m.role === 'assistant' && m.content.trim().length > 0);
  // The typing item sits right after the last user message and its box.
  let typingAt: number | null = null;
  for (const persisted of sortedResume) {
    // Resumed CURRENT-conversation messages are live for this purpose: their
    // cards are still answerable, so they are not stale.
    emitMessage(
      out,
      toConversationMessage(persisted),
      'hist',
      toolCallResults,
      false,
      liveBoxes,
      answeredAskIds.has(persisted.id),
    );
    if (persisted.id === lastUserId) typingAt = out.length;
  }

  // --- Intro pseudo-message: suppressed once the conversation has resumed
  // messages (ChatSessionView already clears introMessage on the first send,
  // so intro never coexists with a live message in practice). ---
  if (introMessage !== null && sortedResume.length === 0) {
    out.push({
      kind: 'message',
      key: 'live-intro',
      message: { id: 'intro', role: 'assistant', content: introMessage },
    });
  }

  // The assistant message currently being streamed into: the LAST live one,
  // and only while the turn is running. Tracked here rather than in the
  // component because only the deriver sees the whole ordered list.
  const lastLiveMsg = live[live.length - 1];
  const liveBox = lastUserId ? liveBoxes.get(lastUserId) : undefined;
  const streaming: StreamingInfo | null =
    isStreaming && lastLiveMsg?.role === 'assistant'
      ? { id: lastLiveMsg.id, showWords, engine, handover: !(liveBox && keepBox(liveBox)) }
      : null;

  // --- Live session (skip anything already rendered via resume) ---
  for (const message of live) {
    if (resumeIds.has(message.id)) continue;
    emitMessage(
      out,
      message,
      'live',
      toolCallResults,
      false,
      liveBoxes,
      answeredAskIds.has(message.id),
      streaming,
    );
    if (message.id === lastUserId) typingAt = out.length;
  }

  // --- Typing indicator ---
  const lastLive = live[live.length - 1];
  // Exactly ONE liveness signal at a time. While a steps box has a pending TOOL
  // row the box IS the signal, so the dots would be a second one saying the
  // same thing. The dots keep the window they already owned — after the user
  // sends and before any tool call exists — which is also where the shipped
  // "Thinking…" caption lives, so nothing is lost by suppressing them later.
  const stepsBoxIsLive = Array.from(liveBoxes.values()).some(
    (box) => !box.collapsed && box.steps.some((s) => s.status === 'pending'),
  );
  const showTyping =
    isStreaming &&
    !stepsBoxIsLive &&
    (!lastLive ||
      lastLive.role === 'user' ||
      (lastLive.role === 'assistant' && lastLive.content.trim().length === 0));
  if (showTyping) {
    const typing: ChatThreadItem = { kind: 'typing', key: 'typing', showWords, ackShowing, engine };
    if (typingAt === null) out.push(typing);
    else out.splice(typingAt, 0, typing);
  }

  // --- Quick fact checks (always last: they answer the newest tap) ---
  for (const entry of [...(opts.quickFactChecks ?? [])].sort((a, b) => a.createdAt - b.createdAt)) {
    out.push({ kind: 'quick-fact-check-card', key: `qfc-${entry.id}`, entry });
  }

  return placeProposalCardsLast(markSupersededTrackCards(out));
}

/** Every follow card but the newest is superseded: a later proposeTrack replaced it. */
function markSupersededTrackCards(items: ChatThreadItem[]): ChatThreadItem[] {
  let newest = -1;
  items.forEach((it, i) => {
    if (it.kind === 'proposal-card' && it.track) newest = i;
  });
  return items.map((it, i) =>
    it.kind === 'proposal-card' && it.track && i !== newest
      ? { ...it, track: { ...it.track, superseded: true } }
      : it,
  );
}
