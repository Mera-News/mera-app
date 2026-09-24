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
import { parseTrackScopeOptions } from '@/lib/news-harness/article-feedback/agent-core';
import { parseFactCheckClaimOptions } from '@/lib/news-harness/fact-check';
import {
  SUPPRESSION_KINDS,
  type SuppressionKindName,
} from '@/lib/news-harness/core/types';
import {
  groupIdOf,
  readGroupResolutions,
  readPendingGroups,
} from '@/lib/chat-tools/fact-choice-resolution';
import type { FactConflict } from '@/lib/news-harness/persona-management/fact-conflict';
import { resolveCountryScope } from '@/lib/news-harness/persona-management/persona-agent-core';
import { isFactPickChoice, joinFactPick } from '@/lib/mera-harness/core/fact-pick';
import type { QuickFactCheckEntry } from '@/lib/stores/floating-chat-store';
import type {
  AgentStep,
  AgentTerminal,
  ChatThreadItem,
  FactCardAction,
  PersistedMessage,
} from './types';
import {
  changedDataFrom,
  legStartStep,
  stepsForMessage,
  continuingStep,
} from './agent-step-labels';

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
      // GROUP-SHAPED RESULT: the per-group loop in `emitMessage` owns every card
      // this call produces, including one Saved card per accepted group. This
      // legacy reader must stay silent or it emits a SECOND, aggregate fact-card
      // alongside them — one that grows with every tap, which is precisely the
      // "replaced in line, at its own position" requirement failing. Gated on
      // the MARKER, not on whether anything is resolved yet, so a staged turn
      // and a finished one behave the same way.
      if (readGroupResolutions(result) !== null) return null;
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

/**
 * Re-validate ONE persisted proposal action into a `ProposalAction`.
 *
 * This deliberately stays a SECOND parser rather than reusing the harness
 * sanitizer (`decideProposeChanges`/`validateAction`): that one is
 * context-sensitive — it corroborates a structured filter's value against the
 * live article context and resolves a `retire_suppression` id against the
 * filter list it rendered into <context>. Neither input exists on resume. What
 * we re-read here is already-sanitized output, so the job is a shape check, not
 * a sanitize.
 *
 * The cost of that split is real (it is exactly what silently dropped
 * structured filters and `retire_suppression` from every resumed card), so it
 * is EXPORTED and covered by the action-type coverage test that walks both
 * agents' tool enums.
 */
export function parseProposalAction(value: unknown): ProposalAction | null {
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
    case 'set_source_scope_pref': {
      // source-pref v47 (D2/D6). The PERSISTED args carry what the model said
      // (`scopeCountry`, an English country NAME) — not the resolved token —
      // so the resume path has to redo the resolution the sanitizer did.
      // `resolveCountryScope` is the sanitizer's own helper, shared rather than
      // reimplemented: two copies of a closed-vocabulary mapping is exactly the
      // drift that makes a resumed card mean something different from the one
      // the user first saw. Unresolvable ⇒ null ⇒ the action is dropped, same
      // as at staging time.
      const resolved = resolveCountryScope(
        typeof rec.scopeCountry === 'string' ? rec.scopeCountry : '',
      );
      const pref = typeof rec.publicationPref === 'string' ? rec.publicationPref.trim() : '';
      // No `mute`: nothing implements a scope exclusion, so a mute is rejected
      // here exactly as the sanitizer and the executor reject it.
      return resolved && (pref === 'boost' || pref === 'deprioritize')
        ? {
            type: 'set_source_scope_pref',
            scopeKind: 'country',
            scopeValue: resolved.scopeValue,
            label: resolved.label,
            publicationPref: pref,
          }
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
      // Structured filter (D9): kind + value travel together or not at all — a
      // kind with no value matches NOTHING, so an incomplete pair degrades to
      // the keyword filter the pattern already describes.
      const kind =
        typeof rec.suppressionKind === 'string' ? rec.suppressionKind.trim().toLowerCase() : '';
      const value = typeof rec.suppressionValue === 'string' ? rec.suppressionValue.trim() : '';
      if (value && (SUPPRESSION_KINDS as readonly string[]).includes(kind)) {
        action.suppressionKind = kind as SuppressionKindName;
        action.suppressionValue = value;
      }
      return action;
    }
    case 'retire_suppression': {
      const suppressionId =
        typeof rec.suppressionId === 'string' ? rec.suppressionId.trim() : '';
      if (!suppressionId) return null;
      // `pattern` is resolved by the sanitizer from OUR filter list and is NOT
      // echoed into the persisted tool result, so a resumed card usually has
      // none. That costs a detail line — dropping the whole action (the old
      // behaviour) cost the entire card.
      const pattern = typeof rec.pattern === 'string' ? rec.pattern.trim() : '';
      return { type: 'retire_suppression', suppressionId, pattern };
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
    // No payload to validate — the action is its own instruction. Needed so a
    // RESUMED conversation still renders the card (and so its Confirm button
    // still works) after the popover was closed and reopened.
    case 'run_calibration':
      return { type: 'run_calibration' };
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
 * tool INPUT carries the scope `options` (label + hidden search); the confirmable
 * origin `subject` and the parsed options are echoed in the RESULT (see
 * decideProposeTrack), so we recover the full `track_story` actions from input +
 * result via the same parser the live path uses. On resume without a result the
 * card still renders (dimmed, no confirm) from the options alone.
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

  // Rebuild the scope pills from input.options (result.options as fallback), or a
  // legacy `track` string. Same parser as the live path → identical actions.
  const rawOptions =
    (Array.isArray(input.options) && input.options) ||
    (Array.isArray(result?.options) && result.options) ||
    (typeof input.track === 'string' && input.track.trim() ? [input.track] : []) ||
    [];
  const options = parseTrackScopeOptions(rawOptions);
  if (options.length === 0) return null;

  const echoedId = typeof result?.proposalId === 'string' ? result.proposalId : null;
  const actions: ProposalAction[] = options.map((o) => ({
    type: 'track_story',
    label: o.label,
    searchText: o.search,
    subject,
  }));
  return {
    id: echoedId ?? toolCall.id,
    explanation: '',
    expectedEffects: '',
    actions,
    ...(actions.length >= 2 ? { chooseOne: true } : {}),
  };
}

/**
 * Rebuilds a fact-check StagedProposal from a completed `proposeFactCheck` tool
 * call. Structurally identical to `deriveTrackProposal`: the tool INPUT carries
 * the claim `options` (label + searchable claim); the confirmable article
 * `subject` and the parsed options are echoed in the RESULT (see
 * decideProposeFactCheck), so we recover the full `fact_check_claim` actions
 * from input + result through the SAME parser the live path uses — a resumed
 * thread therefore rebuilds byte-identical actions. On resume without a result
 * the card still renders (dimmed, no confirm) from the options alone.
 */
function deriveFactCheckProposal(toolCall: ToolCallRecord): StagedProposal | null {
  if (toolCall.status !== 'done' || toolCall.name !== 'proposeFactCheck') return null;

  const input = asRecord(toolCall.input) ?? {};
  const result = asRecord(toolCall.result);

  // Subject is only load-bearing on Confirm (live session, result present). A
  // resumed card is dimmed, so an empty subject is harmless there — and
  // `enqueueFactCheck` would be handed an empty articleId rather than a wrong
  // one, which the executor's own empty-claim guard cannot mask.
  const subjectRec = asRecord(result?.subject);
  const subject = {
    surface: typeof subjectRec?.surface === 'string' ? subjectRec.surface : 'fact-check-chat',
    articleId: typeof subjectRec?.articleId === 'string' ? subjectRec.articleId : '',
    articleTitle: typeof subjectRec?.articleTitle === 'string' ? subjectRec.articleTitle : '',
    ...(typeof subjectRec?.articleUrl === 'string' ? { articleUrl: subjectRec.articleUrl } : {}),
    ...(typeof subjectRec?.publicationName === 'string'
      ? { publicationName: subjectRec.publicationName }
      : {}),
  };

  // Rebuild the claim pills from input.options (result.options as fallback), or
  // a legacy lone `claim` string. Same parser as the live path → identical
  // actions.
  // RESULT FIRST, unlike the track card above. The staged options are a superset
  // of the model's: decideProposeFactCheck appends the whole-article pill, and
  // reading `input.options` in preference would rebuild a card missing it.
  const rawOptions =
    (Array.isArray(result?.options) && result.options) ||
    (Array.isArray(input.options) && input.options) ||
    (typeof input.claim === 'string' && input.claim.trim() ? [input.claim] : []) ||
    [];
  const options = parseFactCheckClaimOptions(rawOptions);
  if (options.length === 0) return null;

  const echoedId = typeof result?.proposalId === 'string' ? result.proposalId : null;
  const actions: ProposalAction[] = options.map((o) => ({
    type: 'fact_check_claim',
    label: o.label,
    claim: o.claim,
    subject,
    // The trailing whole-article pill. It only ever reaches this parser via
    // `result.options` (the model never emits it and the tool INPUT never
    // carries it), which is exactly why decideProposeFactCheck echoes the
    // options it staged rather than only the ones it was given — without that
    // echo a resumed card would silently lose the thorough path.
    ...(o.mode === 'article' ? { mode: 'article' as const } : {}),
  }));
  return {
    id: echoedId ?? toolCall.id,
    explanation: '',
    expectedEffects: '',
    actions,
    ...(actions.length >= 2 ? { chooseOne: true } : {}),
  };
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

/**
 * Emit every card one group-shaped `saveExtractedFacts` call produces.
 *
 * The ORDER here is the product requirement, not an implementation detail. The
 * staged `pendingFacts` array is walked in its staged order and each group emits
 * whatever its own state calls for, so an accepted group's Saved card lands at
 * exactly the position its question occupied and its still-pending siblings do
 * not move. Nothing re-sorts and nothing is appended to a bucket, because both
 * of those would decouple position from identity — which is the defect this
 * whole path exists to fix.
 *
 * Three per-group states:
 *   unresolved  -> the readings, still tappable
 *   dismissed   -> a one-line "Not saved" with Undo, IN PLACE
 *   saved       -> Saved card, then that group's conflict cards, then one
 *                  topics accordion PER SAVED FACT
 */
function emitFactChoiceGroups(
  cards: ChatThreadItem[],
  messageId: string,
  idx: number,
  result: Record<string, unknown>,
  resolutions: ReturnType<typeof readGroupResolutions> & object,
  stale: boolean,
): void {
  const resultKey = `${messageId}::${idx}`;
  const groups = readPendingGroups(result);
  let lastPendingAt = -1;

  for (const group of groups) {
    const groupId = groupIdOf(group);
    const resolution = resolutions[groupId];

    if (resolution === undefined) {
      cards.push({
        kind: 'fact-choice-card',
        key: `fact-choice-${messageId}-${idx}-${groupId}`,
        resultKey,
        baseResult: result,
        groupIndex: group.index,
        groupId,
        options: group.options,
        questionnaireAttribute: group.questionnaireAttribute,
        replacesFactId: group.replaces ?? null,
        topicSkillId: group.topicSkillId ?? null,
        dismissed: false,
        // A card derived from an EARLIER conversation can never be committed —
        // its context is gone — so it renders inert and, crucially, is not
        // counted by the composer gate. Revealing history must not re-block the
        // input.
        stale,
      });
      lastPendingAt = cards.length - 1;
      continue;
    }

    if (resolution.status === 'dismissed') {
      cards.push({
        kind: 'fact-choice-card',
        key: `fact-choice-${messageId}-${idx}-${groupId}`,
        resultKey,
        baseResult: result,
        groupIndex: group.index,
        groupId,
        options: resolution.options,
        questionnaireAttribute: resolution.questionnaireAttribute,
        replacesFactId: group.replaces ?? null,
        topicSkillId: group.topicSkillId ?? null,
        dismissed: true,
        stale,
      });
      continue;
    }

    cards.push({
      kind: 'fact-card',
      key: `card-${messageId}-${idx}-${groupId}`,
      action: 'saved',
      statements: resolution.statements,
      factIds: resolution.savedFacts.map((f) => f.id),
    });
    // This group's OWN conflicts, keyed under the group rather than the call, so
    // two groups raising a conflict cannot collide on one key and so a conflict
    // stays next to the fact that caused it.
    resolution.conflicts.forEach((conflict, cIdx) => {
      cards.push({
        kind: 'conflict-card',
        key: `conflict-${messageId}-${idx}-${groupId}-${cIdx}`,
        conflict,
      });
    });

    // ONE CARD PER FACT, batch or not. The merged "Add all" card is gone: a
    // collapsed accordion is one line, so N of them no longer stack the chip
    // wall that merging existed to avoid, and each fact keeps its own
    // generation status in its own header.
    for (const f of resolution.savedFacts) {
      cards.push({
        kind: 'chat-topics-card',
        key: `chat-topics-${messageId}-${idx}-${groupId}-${f.id}`,
        factId: f.id,
        factStatement: f.statement,
      });
    }
  }

  // Bulk row: INLINE, immediately after the last pending card of this group, and
  // only while 2+ remain pending. Spliced rather than appended so it cannot end
  // up below an already-resolved group's cards.
  //
  // A REPLACEMENT GROUP IS EXCLUDED, from the row and from the count that
  // decides whether the row renders at all. "Add all" performing an
  // irreversible destroy on facts the user never looked at individually is
  // consent fabricated in bulk — the same shape as forcing a tool call the
  // user never asked for. A replacement has to be tapped on its own card,
  // where what it destroys is named.
  const bulkable = groups.filter(
    (g) => resolutions[groupIdOf(g)] === undefined && !g.replaces,
  );
  if (bulkable.length >= 2 && !stale && lastPendingAt >= 0) {
    cards.splice(lastPendingAt + 1, 0, {
      kind: 'fact-choice-bulk-row',
      key: `fact-choice-bulk-${messageId}-${idx}`,
      resultKey,
      baseResult: result,
      groups: bulkable.map((g) => ({
        groupId: groupIdOf(g),
        groupIndex: g.index,
        options: g.options,
        questionnaireAttribute: g.questionnaireAttribute,
        topicSkillId: g.topicSkillId ?? null,
      })),
    });
  }

}

// ---------------------------------------------------------------------------
// Agent-steps boxes (pagent P2)
// ---------------------------------------------------------------------------
//
// ONE BOX PER TURN, not per message. A turn is several legs and therefore
// several assistant messages; a box per leg would flicker in and out as each
// leg settled. There is no turn id anywhere in the tree (every leg gets its own
// `asst-${Date.now()}-${rand}`), so a turn is derived from the sequence itself:
// the run of assistant messages following a user message. That costs one
// accumulator and keeps this module pure.
//
// The box is anchored AFTER the user message that opened the turn, so it never
// moves as legs accumulate, and a leg's prose renders below it.

type AgentStepsItem = Extract<ChatThreadItem, { kind: 'agent-steps' }>;

interface TurnAccum {
  anchorId: string;
  firstAssistantId: string | null;
  steps: AgentStep[];
  toolStepCount: number;
}

interface SeqEntry {
  message: ConversationMessage;
}

/**
 * Build the per-turn boxes for one ordered message sequence.
 *
 * `turnActive` is the TURN-SCOPED flag from P1's agent turn state. It is
 * deliberately not `status` / `isStreaming` / `isStreamingRef`: all three are
 * named as though they were stream-scoped, behave turn-scoped nearly
 * everywhere, and go idle EARLY during a forced-extraction pass
 * (`useCloudPersonaChat` sets status idle unconditionally but releases
 * `turnBusyRef` only when no forced pass is running). Keying on one of those
 * paints a healthy turn as interrupted in that window, and P1's multi-leg loop
 * widens it to every gap between legs.
 *
 * `undefined` means the flag is not wired yet. The fallback is deliberately the
 * SAFE direction: collapse on "everything settled" (the old behaviour) and mark
 * nothing interrupted unless it is stale. Under-reporting an interruption looks
 * like today; over-reporting paints a live turn dead.
 */
function buildTurnBoxes(
  seq: SeqEntry[],
  stale: boolean,
  turnActive: boolean | undefined,
  agentTerminal: AgentTerminal | null,
): Map<string, AgentStepsItem> {
  const turns: TurnAccum[] = [];
  let current: TurnAccum | null = null;

  for (const { message } of seq) {
    if (message.hidden) continue;
    if (message.role === 'user') {
      current = {
        anchorId: message.id,
        firstAssistantId: null,
        steps: [],
        toolStepCount: 0,
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      // An assistant message with no user turn before it (a resumed thread that
      // begins mid-turn). Anchor the box on the assistant message itself.
      current = {
        anchorId: message.id,
        firstAssistantId: message.id,
        steps: [],
        toolStepCount: 0,
      };
      turns.push(current);
    }
    if (current.firstAssistantId === null) current.firstAssistantId = message.id;
    const toolSteps = stepsForMessage(message.id, message.toolCalls, false);
    current.steps.push(...toolSteps);
    current.toolStepCount += toolSteps.length;
  }

  // THE LAST TURN OVERALL, not the last one that happened to call a tool. A
  // new turn has no tool calls yet, so keying on "last with tools" made the
  // PREVIOUS turn's box reopen with "Working on it" the moment the user sent
  // a new message (audit F5, 5 of 5 on device).
  const lastTurn = turns[turns.length - 1];
  const withTools = turns.filter(
    (t) =>
      t.toolStepCount > 0
      // A turn with no tools still needs a box to carry its terminal
      // sentence, or a `no-route` turn ends in silence.
      || (t === lastTurn && agentTerminal !== null && t.firstAssistantId !== null),
  );

  const out = new Map<string, AgentStepsItem>();
  for (const turn of withTools) {
    const isLast = turn === lastTurn;
    // Only the LAST turn of the live sequence can still be running.
    const active = !stale && isLast && turnActive === true;

    const hasPending = turn.steps.some((s) => s.status === 'pending');
    const allSettled = !hasPending;

    // Without the flag, fall back to the old settled-based collapse.
    const collapsed = turnActive === undefined ? allSettled : !active;
    const interrupted =
      turnActive === undefined ? stale && hasPending : !active && hasPending;

    // Strand pending rows only once the turn really cannot settle them.
    const steps = interrupted
      ? turn.steps.map((step) =>
          step.status === 'pending'
            ? {
                ...step,
                status: 'error' as const,
                consequenceKey: 'agentSteps.consequence.interrupted',
              }
            : step,
        )
      : turn.steps;

    // ONE ROW PER REPEATED STEP. Three find_similar_facts calls rendered as
    // "Looking for things you've already told me" three times in one box
    // (audit F6). Consecutive steps with the same text merge into one row,
    // which carries the worst status among them.
    const mergedSteps = mergeRepeatedSteps(steps);

    // The leg-start row is the box's first entry and always settled: the box
    // only exists once a tool call has appeared, which means the thinking phase
    // it describes is over.
    //
    // A STILL-RUNNING turn gets a trailing PENDING row. `onLeg` fires only
    // after a leg's whole tool loop settles, so without it every row is `done`
    // the instant the box appears, the box has no live indicator between legs,
    // and — because the typing suppression below keys on "this box has a
    // pending row" — the box and the wait line were BOTH on screen. A
    // simulator pass caught that on real pixels across consecutive frames.
    const full: AgentStep[] = [
      legStartStep(turn.firstAssistantId ?? turn.anchorId, true),
      ...mergedSteps,
      ...(active ? [continuingStep(turn.anchorId)] : []),
    ];

    out.set(turn.anchorId, {
      kind: 'agent-steps',
      key: `agent-steps-${turn.anchorId}`,
      steps: full,
      collapsed,
      doneCount: full.filter((s) => s.status === 'done').length,
      failedCount: full.filter((s) => s.status === 'error').length,
      // Only the LAST turn: the store holds one terminal, and stamping it on an
      // older box would relabel a turn that ended for a different reason.
      terminal: isLast ? (agentTerminal ?? null) : null,
      interrupted,
      changedData: changedDataFrom(full),
    });
  }
  return out;
}

const STATUS_RANK: Record<AgentStep['status'], number> = { done: 0, pending: 1, error: 2 };

/** Merge consecutive steps that render the same line. Keeps the first step's
 *  id, so keys stay stable as later repeats arrive. */
function mergeRepeatedSteps(steps: AgentStep[]): AgentStep[] {
  const out: AgentStep[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    const same =
      prev
      && prev.kind === step.kind
      && prev.labelKey === step.labelKey
      && JSON.stringify(prev.labelValues ?? null) === JSON.stringify(step.labelValues ?? null);
    if (!same) {
      out.push(step);
      continue;
    }
    if (STATUS_RANK[step.status] > STATUS_RANK[prev.status]) {
      out[out.length - 1] = { ...prev, status: step.status, consequenceKey: step.consequenceKey };
    }
  }
  return out;
}

/** Does the bubble text already carry this question? Compared loosely: case,
 *  spacing and the closing punctuation do not matter. */
function bubbleCarries(content: string, question: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').replace(/[?.!\s]+$/, '').trim();
  const q = norm(question);
  return q.length > 0 && norm(content).includes(q);
}

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

/**
 * Should this settled box survive in the thread?
 *
 * A turn that CHANGED DATA keeps its line; a pure-read turn does not. Facts are
 * extracted on nearly every turn, so keeping every settled box would put a line
 * under most bubbles in the thread. A failure is always kept: a failure the
 * user never learns about is the case this surface exists to prevent.
 *
 * A TERMINAL is kept for exactly that reason, and it has to be its own clause.
 * The terminal sentence is carried BY this box, so dropping the box drops the
 * only thing on screen that says the turn ended badly. Measured on device: a
 * residence turn spent its legs on place lookups that all missed, ended
 * `leg-cap` with no proposal and an empty reply, and every tool call had
 * succeeded on its own terms, so `changedData` was false, `failedCount` was
 * zero, the box was dropped and the user was left looking at their own message
 * with no response of any kind. Silence is the one outcome this whole surface
 * exists to prevent.
 */
function keepBox(box: AgentStepsItem): boolean {
  if (!box.collapsed) return true;
  return box.changedData || box.failedCount > 0 || box.terminal !== null;
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
  toolCallResults: Record<string, Record<string, unknown>> = {},
  stale = false,
  boxes?: Map<string, AgentStepsItem>,
  answeredAsk = false,
  streamingMessageId: string | null = null,
): void {
  // A hidden turn is the model's business only — it produces no bubble and no
  // cards. Filtered here rather than at the call sites so every source (live,
  // resume, history) is covered by one line.
  if (message.hidden) return;

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
        cards.push({
          kind: 'proposal-card',
          key: `proposal-${message.id}-${idx}`,
          proposal,
        });
        return;
      }
      // ask_choice: chips under this bubble. Derived from the tool INPUT, and
      // `answered` is decided by the caller, which is the only place that can
      // see whether a later user message exists.
      if (tc.name === 'ask_choice') {
        const askInput = asRecord(tc.input) ?? {};
        const allOptions = toStringArray(askInput.options);
        // Distinct facts are never a pick-one: their chip list carries Save
        // all, which always covers EVERY option, even past the chips shown.
        const factPick = isFactPickChoice(allOptions);
        const options = allOptions.slice(0, factPick ? 4 : 3);
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
            answered: answeredAsk,
          });
        }
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
        const resolutions = readGroupResolutions(result);
        // The new path owns a blob that is group-shaped OR still has pending
        // groups. The second half matters: a LEGACY PENDING blob (staged by an
        // older bundle, so no marker) is still answerable, and routing it here
        // means `groupIdOf` recomputes its ids and the first commit materialises
        // the marker. Sending it down the legacy branch instead would render it
        // with placeholder ids and write resolutions nothing could read back.
        const pendingGroups = readPendingGroups(result);
        if (resolutions !== null || pendingGroups.length > 0) {
          emitFactChoiceGroups(cards, message.id, idx, result, resolutions ?? {}, stale);
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

  const hasContent = message.content.trim().length > 0;
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
      ...(streamingMessageId === message.id ? { streaming: true } : {}),
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
  );
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
  const streamingMessageId =
    isStreaming && lastLiveMsg?.role === 'assistant' ? lastLiveMsg.id : null;

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
      streamingMessageId,
    );
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
    out.push({ kind: 'typing', key: 'typing' });
  }

  // --- Quick fact checks (always last: they answer the newest tap) ---
  for (const entry of [...(opts.quickFactChecks ?? [])].sort((a, b) => a.createdAt - b.createdAt)) {
    out.push({ kind: 'quick-fact-check-card', key: `qfc-${entry.id}`, entry });
  }

  return placeProposalCardsLast(out);
}
