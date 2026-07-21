// Pure derivation of the flat, render-ready thread item list.
//
// This module has NO React Native / React dependencies so it can be unit-tested
// in isolation. It takes the current in-memory session (`live`), the persisted
// older messages (`history`), and a few flags, and produces a flat
// `ChatThreadItem[]` ordered newest-LAST (ChatThread inverts internally).

import type {
  ConversationMessage,
  ProposalAction,
  StagedProposal,
  ToolCallRecord,
} from '@/lib/llm/types';
import type { FactConflict } from '@/lib/news-harness/persona-management/fact-conflict';
import type { ChatThreadItem, FactCardAction, PersistedMessage } from './types';

// ---------------------------------------------------------------------------
// Fact-card derivation
// ---------------------------------------------------------------------------
//
// Tool NAMES are authoritative (from PersonaUpdateAgent.getToolDefinitions):
//   saveExtractedFacts | deleteUserFacts | updateUserConfig
//
// The result/input SHAPES below are defensive: the plan documents a richer
// result shape (result.savedFacts / result.deletedStatements) than the current
// tool-handlers actually return, so we prefer those fields when present and
// fall back to the message INPUT (using the real schema field names:
// `extracted_user_information` for saves, `fact_ids` for deletes). See the
// summary for the exact deviation.

interface DerivedCard {
  action: FactCardAction;
  statements: string[];
  factIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Extracts statement strings + ids from a `[{ id, statement }]` result shape. */
function fromSavedFacts(value: unknown): DerivedCard | null {
  if (!Array.isArray(value)) return null;
  const statements: string[] = [];
  const factIds: string[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    const statement = typeof rec?.statement === 'string' ? rec.statement.trim() : '';
    if (!statement) continue;
    statements.push(statement);
    if (typeof rec?.id === 'string') factIds.push(rec.id);
  }
  return statements.length > 0 ? { action: 'saved', statements, factIds } : null;
}

/** Extracts statement strings from a fact-input array (string | { statement }). */
function statementsFromFactInput(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const statements: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) statements.push(trimmed);
      continue;
    }
    const rec = asRecord(entry);
    const statement = typeof rec?.statement === 'string' ? rec.statement.trim() : '';
    if (statement) statements.push(statement);
  }
  return statements;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
}

/** Maps one completed tool call to a fact card, or null if it should not surface. */
function deriveCard(toolCall: ToolCallRecord): DerivedCard | null {
  if (toolCall.status !== 'done') return null;

  const result = toolCall.result ?? {};
  const input = asRecord(toolCall.input) ?? {};

  switch (toolCall.name) {
    case 'saveExtractedFacts': {
      // Prefer the rich result shape when available.
      const fromResult = fromSavedFacts(result.savedFacts);
      if (fromResult) return fromResult;
      // Actual handler returns only { success, factsSaved }. If it explicitly
      // saved nothing, don't surface a card.
      if (typeof result.factsSaved === 'number' && result.factsSaved === 0) return null;
      // Fall back to the message input (no ids available).
      const statements = statementsFromFactInput(
        input.extracted_user_information ?? input.facts,
      );
      return statements.length > 0
        ? { action: 'saved', statements, factIds: [] }
        : null;
    }

    case 'deleteUserFacts': {
      const fromResult = toStringArray(result.deletedStatements);
      if (fromResult.length > 0) {
        return { action: 'deleted', statements: fromResult, factIds: [] };
      }
      // Actual handler returns { success, deletedCount }. If nothing was
      // deleted, don't surface a card.
      if (typeof result.deletedCount === 'number' && result.deletedCount === 0) return null;
      const statements = toStringArray(input.fact_ids);
      return statements.length > 0
        ? { action: 'deleted', statements, factIds: [] }
        : null;
    }

    case 'updateUserConfig':
      return { action: 'updated', statements: [], factIds: [] };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Proposal-card derivation
// ---------------------------------------------------------------------------
//
// The article-feedback agent stages persona changes via a `proposeChanges`
// tool call whose INPUT carries { explanation, expected_effects, actions[] }.
// We rebuild a StagedProposal defensively from that input so a persisted (and
// therefore resumed) proposal re-renders its confirm card. `applyProposal` /
// `cancelProposal` tool calls surface nothing — they only mutate store state.
//
// Proposal id reconciliation: the agent generates the StagedProposal id as its
// own nonce (executeTool never receives the tool-call id), so the tool-call id
// does NOT equal the store proposal id. If the tool RESULT echoes an id we use
// it (lets ProposalCard match store.proposal / resolvedProposals by id); else
// we fall back to the tool-call id as a stable card identity. ProposalCard's
// final pending/expired decision also uses "is this the LAST proposal card"
// so correctness never depends on the echo. See ProposalCard.tsx.

function parseProposalAction(value: unknown): ProposalAction | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const type = typeof rec.type === 'string' ? rec.type : '';
  switch (type) {
    case 'add_fact': {
      const statement = typeof rec.statement === 'string' ? rec.statement.trim() : '';
      return statement ? { type: 'add_fact', statement } : null;
    }
    case 'update_fact': {
      const factId = typeof rec.fact_id === 'string' ? rec.fact_id : '';
      const next = typeof rec.new_statement === 'string' ? rec.new_statement.trim() : '';
      return factId && next ? { type: 'update_fact', fact_id: factId, new_statement: next } : null;
    }
    case 'delete_fact': {
      const factId = typeof rec.fact_id === 'string' ? rec.fact_id : '';
      return factId ? { type: 'delete_fact', fact_id: factId } : null;
    }
    case 'add_topics': {
      const factId = typeof rec.fact_id === 'string' ? rec.fact_id : '';
      const topics = toStringArray(rec.topics);
      return factId && topics.length > 0 ? { type: 'add_topics', fact_id: factId, topics } : null;
    }
    case 'remove_topics': {
      const factId = typeof rec.fact_id === 'string' ? rec.fact_id : '';
      const topics = toStringArray(rec.topics);
      return factId && topics.length > 0
        ? { type: 'remove_topics', fact_id: factId, topics }
        : null;
    }
    case 'submit_feature_request': {
      const title = typeof rec.title === 'string' ? rec.title.trim() : '';
      const summary = typeof rec.summary === 'string' ? rec.summary.trim() : '';
      return title && summary ? { type: 'submit_feature_request', title, summary } : null;
    }
    // -- Wave-9 rails-backed actions (previously dropped on resume — the parser
    //    silently returned null, so a persisted feed-tuning proposal never
    //    re-rendered its confirm card). Mirror the harness validateAction shapes. --
    case 'set_topic_weight': {
      const topicText = typeof rec.topicText === 'string' ? rec.topicText.trim() : '';
      const delta = typeof rec.delta === 'number' && Number.isFinite(rec.delta) ? rec.delta : NaN;
      return topicText && Number.isFinite(delta) && delta !== 0
        ? { type: 'set_topic_weight', topicText, delta }
        : null;
    }
    case 'add_negative_topic': {
      const topicText = typeof rec.topicText === 'string' ? rec.topicText.trim() : '';
      if (!topicText) return null;
      return typeof rec.weight === 'number' && Number.isFinite(rec.weight)
        ? { type: 'add_negative_topic', topicText, weight: rec.weight }
        : { type: 'add_negative_topic', topicText };
    }
    case 'set_publication_pref': {
      const publicationId = typeof rec.publicationId === 'string' ? rec.publicationId.trim() : '';
      const pref = typeof rec.publicationPref === 'string' ? rec.publicationPref.trim() : '';
      return publicationId && (pref === 'boost' || pref === 'deprioritize' || pref === 'mute')
        ? { type: 'set_publication_pref', publicationId, publicationPref: pref }
        : null;
    }
    case 'add_suppression': {
      const pattern = typeof rec.suppressionPattern === 'string' ? rec.suppressionPattern.trim() : '';
      if (!pattern) return null;
      const keywords = toStringArray(rec.suppressionKeywords);
      const action: ProposalAction = { type: 'add_suppression', suppressionPattern: pattern };
      if (keywords.length > 0) action.suppressionKeywords = keywords;
      if (typeof rec.suppressionStrength === 'number' && Number.isFinite(rec.suppressionStrength)) {
        action.suppressionStrength = rec.suppressionStrength;
      }
      return action;
    }
    case 'set_high_priority': {
      const topicText = typeof rec.topicText === 'string' ? rec.topicText.trim() : '';
      return topicText && typeof rec.highPriority === 'boolean'
        ? { type: 'set_high_priority', topicText, highPriority: rec.highPriority }
        : null;
    }
    case 'retire_topic': {
      const topicText = typeof rec.topicText === 'string' ? rec.topicText.trim() : '';
      return topicText ? { type: 'retire_topic', topicText } : null;
    }
    default:
      return null;
  }
}

/** Rebuilds a StagedProposal from a completed `proposeChanges` tool call. */
function deriveProposal(toolCall: ToolCallRecord): StagedProposal | null {
  if (toolCall.status !== 'done' || toolCall.name !== 'proposeChanges') return null;

  const input = asRecord(toolCall.input) ?? {};
  const rawActions = Array.isArray(input.actions) ? input.actions : [];
  const actions: ProposalAction[] = [];
  for (const raw of rawActions) {
    const action = parseProposalAction(raw);
    if (action) actions.push(action);
  }
  // A proposal with no valid action is malformed — skip it entirely.
  if (actions.length === 0) return null;

  const explanation = typeof input.explanation === 'string' ? input.explanation.trim() : '';
  const expectedEffects =
    typeof input.expected_effects === 'string'
      ? input.expected_effects.trim()
      : typeof input.expectedEffects === 'string'
        ? input.expectedEffects.trim()
        : '';

  // Prefer an id echoed by the tool result; otherwise use the tool-call id.
  const result = asRecord(toolCall.result);
  const echoedId =
    typeof result?.id === 'string'
      ? result.id
      : typeof result?.proposalId === 'string'
        ? result.proposalId
        : null;

  // Single-select mode: recover from the tool INPUT (choose_one) with the RESULT
  // echo as a fallback. Only meaningful with ≥2 alternatives.
  const chooseOne =
    (input.choose_one === true || result?.chooseOne === true) && actions.length >= 2;

  return {
    id: echoedId ?? toolCall.id,
    explanation,
    expectedEffects,
    actions,
    ...(chooseOne ? { chooseOne: true } : {}),
  };
}

/**
 * Rebuilds a track StagedProposal from a completed `proposeTrack` tool call. The
 * tool INPUT carries only `{ track }`; the confirmable origin `subject` is
 * echoed in the RESULT (see decideProposeTrack), so we recover the full
 * `track_story` action from input + result. On resume without a result the card
 * still renders (dimmed, no confirm) from the track text alone.
 */
function deriveTrackProposal(toolCall: ToolCallRecord): StagedProposal | null {
  if (toolCall.status !== 'done' || toolCall.name !== 'proposeTrack') return null;

  const input = asRecord(toolCall.input) ?? {};
  const result = asRecord(toolCall.result);

  // Subject is only load-bearing on Confirm (live session, result present). A
  // resumed card is dimmed, so an empty subject is harmless there.
  const subjectRec = asRecord(result?.subject);
  const subject = {
    origin: (subjectRec?.origin === 'article' ? 'article' : 'suggestion') as
      | 'article'
      | 'suggestion',
    surface: typeof subjectRec?.surface === 'string' ? subjectRec.surface : 'detail',
    articleId: typeof subjectRec?.articleId === 'string' ? subjectRec.articleId : '',
    title: typeof subjectRec?.title === 'string' ? subjectRec.title : '',
    stableClusterId:
      typeof subjectRec?.stableClusterId === 'string' ? subjectRec.stableClusterId : null,
    publicationName:
      typeof subjectRec?.publicationName === 'string' ? subjectRec.publicationName : null,
    ...(typeof subjectRec?.pubDate === 'string' ? { pubDate: subjectRec.pubDate } : {}),
  };

  // Multi-option (scope choice): rebuild from input.options (result.options as a
  // fallback), deduped. ≥2 → a single-select proposal of track_story actions.
  const rawOptions =
    (Array.isArray(input.options) && input.options) ||
    (Array.isArray(result?.options) && result.options) ||
    [];
  const options = Array.from(
    new Set(
      rawOptions
        .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
        .map((o) => o.trim()),
    ),
  );

  const echoedId = typeof result?.proposalId === 'string' ? result.proposalId : null;

  if (options.length >= 2) {
    const actions: ProposalAction[] = options.map((trackText) => ({
      type: 'track_story',
      trackText,
      subject,
    }));
    return {
      id: echoedId ?? toolCall.id,
      explanation: '',
      expectedEffects: '',
      actions,
      chooseOne: true,
    };
  }

  const trackText =
    (typeof input.track === 'string' && input.track.trim()) ||
    (typeof result?.track === 'string' && result.track.trim()) ||
    options[0] ||
    '';
  if (!trackText) return null;

  const actions: ProposalAction[] = [{ type: 'track_story', trackText, subject }];
  return { id: echoedId ?? toolCall.id, explanation: '', expectedEffects: '', actions };
}

// ---------------------------------------------------------------------------
// Topic-plan-card + conflict-card derivation (Wave 11)
// ---------------------------------------------------------------------------
//
// Both are derived from a completed `saveExtractedFacts` tool RESULT (the same
// persistence-friendly pattern as the proposal card) so a resumed thread
// re-renders them without re-inference:
//   - topic-plan-card: one per saved fact that has an id (the card subscribes to
//     that fact's live topic rows via observeByFact inside the component).
//   - conflict-card: one per detected conflict in result.conflicts.

/** Saved facts with a stable id — the seed for the per-fact topic-plan card. */
function savedFactsWithIds(result: Record<string, unknown>): Array<{ id: string; statement: string }> {
  const value = result.savedFacts;
  if (!Array.isArray(value)) return [];
  const out: Array<{ id: string; statement: string }> = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    const id = typeof rec?.id === 'string' ? rec.id : '';
    const statement = typeof rec?.statement === 'string' ? rec.statement.trim() : '';
    if (id && statement) out.push({ id, statement });
  }
  return out;
}

/** Defensively validate the FactConflict[] echoed by the save result. */
function conflictsFromResult(result: Record<string, unknown>): FactConflict[] {
  const value = result.conflicts;
  if (!Array.isArray(value)) return [];
  const out: FactConflict[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const newFactId = typeof rec.newFactId === 'string' ? rec.newFactId : '';
    const newStatement = typeof rec.newStatement === 'string' ? rec.newStatement : '';
    const existingFactId = typeof rec.existingFactId === 'string' ? rec.existingFactId : '';
    const existingStatement = typeof rec.existingStatement === 'string' ? rec.existingStatement : '';
    const kind = rec.kind === 'attribute' || rec.kind === 'contradiction' ? rec.kind : null;
    const suggestedMerge = typeof rec.suggestedMerge === 'string' ? rec.suggestedMerge : '';
    if (!newFactId || !newStatement || !existingFactId || !existingStatement || !kind) continue;
    out.push({
      newFactId,
      newStatement,
      existingFactId,
      existingStatement,
      kind,
      ...(typeof rec.attributeKey === 'string' ? { attributeKey: rec.attributeKey } : {}),
      suggestedMerge: suggestedMerge || newStatement,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message → thread items
// ---------------------------------------------------------------------------

/**
 * Emits a message item (if non-placeholder) followed by any fact cards.
 * `keyPrefix` distinguishes history (`hist`) from live (`live`) sources.
 */
function emitMessage(
  out: ChatThreadItem[],
  message: ConversationMessage,
  keyPrefix: 'hist' | 'live',
): void {
  const cards: ChatThreadItem[] = [];
  if (message.role === 'assistant' && message.toolCalls) {
    message.toolCalls.forEach((tc, idx) => {
      // Proposal cards take precedence — a `proposeChanges` call never doubles
      // as a fact card (and applyProposal/cancelProposal surface nothing).
      const proposal = deriveProposal(tc) ?? deriveTrackProposal(tc);
      if (proposal) {
        cards.push({
          kind: 'proposal-card',
          key: `proposal-${message.id}-${idx}`,
          proposal,
        });
        return;
      }
      const card = deriveCard(tc);
      if (card) {
        cards.push({
          kind: 'fact-card',
          key: `card-${message.id}-${idx}`,
          action: card.action,
          statements: card.statements,
          factIds: card.factIds,
        });
      }

      // Wave 11: after the saved fact-card, surface the conflict resolution
      // card(s) then the per-fact topic-planning widget(s). Additive — the
      // fact-card behaviour above is unchanged.
      if (tc.status === 'done' && tc.name === 'saveExtractedFacts') {
        const result = tc.result ?? {};
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
    });
  }

  const hasContent = message.content.trim().length > 0;
  // Skip empty assistant placeholders that produced no cards.
  if (!hasContent && cards.length === 0 && message.role === 'assistant') {
    return;
  }

  if (hasContent || message.role === 'user') {
    out.push({ kind: 'message', key: `${keyPrefix}-${message.id}`, message });
  }
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
}): ChatThreadItem[] {
  const { live, history, introMessage, isStreaming, earlierConversationLabel } = opts;
  const resume = opts.resume ?? [];
  const out: ChatThreadItem[] = [];

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
    emitMessage(out, toConversationMessage(persisted), 'hist');
  }

  // --- Divider between OLDER conversations and the current one ---
  if (sortedHistory.length > 0) {
    out.push({ kind: 'divider', key: 'div-live', label: earlierConversationLabel });
  }

  // --- Resumed current-conversation messages (oldest-first, no divider) ---
  const sortedResume = [...resume].sort((a, b) => a.createdAt - b.createdAt);
  const resumeIds = new Set(sortedResume.map((m) => m.id));
  for (const persisted of sortedResume) {
    emitMessage(out, toConversationMessage(persisted), 'hist');
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

  // --- Live session (skip anything already rendered via resume) ---
  for (const message of live) {
    if (resumeIds.has(message.id)) continue;
    emitMessage(out, message, 'live');
  }

  // --- Typing indicator ---
  const lastLive = live[live.length - 1];
  const showTyping =
    isStreaming &&
    (!lastLive ||
      lastLive.role === 'user' ||
      (lastLive.role === 'assistant' && lastLive.content.trim().length === 0));
  if (showTyping) {
    out.push({ kind: 'typing', key: 'typing' });
  }

  return out;
}
