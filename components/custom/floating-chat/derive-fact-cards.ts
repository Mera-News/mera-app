import type { ToolCallRecord } from '@/lib/llm/types';
import {
  groupIdOf,
  readGroupResolutions,
  readPendingGroups,
} from '@/lib/chat-tools/fact-choice-resolution';
import type { FactConflict } from '@/lib/news-harness/persona-management/fact-conflict';
import type {
  ChatThreadItem,
  FactCardAction,
  SaveAsWrittenOffer,
} from './types';

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

export function asRecord(value: unknown): Record<string, unknown> | null {
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

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
}

/** The loop's "Save as I wrote it" entry on a call's result, and its saved
 *  outcome once tapped (ux2 D9). Null when the call carries none. */
export function saveAsWrittenOf(
  tc: ToolCallRecord,
  resultKey: string,
): { offer: SaveAsWrittenOffer; saved: { id: string; statement: string }[] | null } | null {
  const result = asRecord(tc.result);
  const raw = asRecord(result?.saveAsWritten);
  if (!result || !raw || typeof raw.statement !== 'string' || !raw.statement.trim()) return null;
  const entry: SaveAsWrittenOffer['entry'] = {
    statement: raw.statement,
    ...(typeof raw.questionnaire_attribute === 'string' ? { questionnaire_attribute: raw.questionnaire_attribute } : {}),
    ...(typeof raw.topic_skill_id === 'string' ? { topic_skill_id: raw.topic_skill_id } : {}),
  };
  const saved = Array.isArray(result.saveAsWrittenSaved)
    ? (result.saveAsWrittenSaved as unknown[])
        .map((f) => asRecord(f))
        .filter((f): f is Record<string, unknown> => !!f && typeof f.id === 'string' && typeof f.statement === 'string')
        .map((f) => ({ id: f.id as string, statement: f.statement as string }))
    : null;
  return { offer: { resultKey, baseResult: result, entry }, saved: saved && saved.length > 0 ? saved : null };
}

/** The saved sentence and its topics, in place of the chip. */
export function pushSavedAsWritten(
  cards: ChatThreadItem[],
  messageId: string,
  idx: number,
  saved: { id: string; statement: string }[],
  topicSkillId?: string,
): void {
  cards.push({
    kind: 'fact-card',
    key: `card-${messageId}-${idx}-as-written`,
    action: 'saved',
    statements: saved.map((f) => f.statement),
    factIds: saved.map((f) => f.id),
  });
  for (const f of saved) {
    cards.push({
      kind: 'chat-topics-card',
      key: `chat-topics-${messageId}-${idx}-as-written-${f.id}`,
      factId: f.id,
      factStatement: f.statement,
      ...(topicSkillId ? { topicSkillId } : {}),
    });
  }
}

/** Maps one completed tool call to a fact card, or null if it should not surface. */
export function deriveCard(toolCall: ToolCallRecord): DerivedCard | null {
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
      // A BLOCKED delete (the loop's ask-first gate) is an error result. It
      // used to fall through to `input.fact_ids` and render "Removed from your
      // persona" listing ids, once per blocked call, before the user had
      // confirmed anything (ux2 C4). With the statements the gate resolved it
      // is a PENDING card; without them it is nothing.
      // The user answered the card (ux2 M6): the outcome is recorded on the
      // call's result by `confirmPendingDelete`.
      if (result.deleteOutcome === 'removed') {
        const gone = toStringArray(result.deletedStatements);
        return gone.length > 0 ? { action: 'deleted', statements: gone, factIds: [] } : null;
      }
      if (result.deleteOutcome === 'kept') return { action: 'deleteKept', statements: [], factIds: [] };
      if (typeof result.error === 'string') {
        const pending = toStringArray(result.pendingStatements);
        return pending.length > 0
          ? { action: 'deletePending', statements: pending, factIds: toStringArray(result.pendingFactIds) }
          : null;
      }
      // Only what the handler actually removed, never the ids it was handed.
      const fromResult = toStringArray(result.deletedStatements);
      return fromResult.length > 0
        ? { action: 'deleted', statements: fromResult, factIds: [] }
        : null;
    }

    case 'updateUserConfig':
      return { action: 'updated', statements: [], factIds: [] };

    default:
      return null;
  }
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
export function savedFactsWithIds(result: Record<string, unknown>): Array<{ id: string; statement: string }> {
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
export function conflictsFromResult(result: Record<string, unknown>): FactConflict[] {
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
export function emitFactChoiceGroups(
  cards: ChatThreadItem[],
  messageId: string,
  idx: number,
  result: Record<string, unknown>,
  resolutions: ReturnType<typeof readGroupResolutions> & object,
  stale: boolean,
  followedByUser = false,
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
      // GONE once the user has moved on (owner ruling ux2 M3). A skipped card
      // kept its Undo forever and "✕ Not added" cards piled up down the
      // thread; Undo stays reachable until the next user message.
      if (followedByUser) continue;
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
        ...(group.topicSkillId ? { topicSkillId: group.topicSkillId } : {}),
      });
    }
  }

  // Bulk row: INLINE, immediately after the last pending card of this group, and
  // only while 2+ remain pending. Spliced rather than appended so it cannot end
  // up below an already-resolved group's cards.
  //
  // REPLACEMENT GROUPS ARE INCLUDED (owner ruling ux2). The row then says
  // what it does: "Replace all" / "Keep all" / "Skip all", never a plain
  // "Add all" that would destroy facts under an add label, and each replace
  // card above it still names what it removes. Every pending group counts.
  const bulkable = groups.filter((g) => resolutions[groupIdOf(g)] === undefined);
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
        replaces: g.replaces ?? null,
      })),
    });
  }

}
