// Persona-Change-Log Service — WatermelonDB adapter for persona-v3
// `persona_change_log`. Every persona mutation (nudge, slider, chat action,
// digest, migration) appends a row whose `action_json` carries enough state
// ({ before, after, targetId, delta }) to invert the action.
//
// `revertChange` is the revert SCAFFOLD: it applies the inverse of the logged
// action for the action types that exist in this wave (weight-set / create /
// retire) and throws for anything it does not know how to invert. The full
// rails (per-day budgets, richer action types) arrive in a later wave and
// extend the switch below.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type PersonaChangeLogModel from '../models/PersonaChangeLog';
import type { PersonaChangeLogSource } from '../models/PersonaChangeLog';
import type FactModel from '../models/Fact';
import * as topicService from './topic-service';
import * as locationService from './location-service';
import * as suppressionService from './suppression-service';
import * as publicationPreferenceService from './publication-preference-service';
import type { PublicationPrefKind } from './publication-preference-service';
import { ACTION_NAMES } from '../../news-harness/persona-management/action-names';
import {
  markFeedNeedsRefresh,
  runSweepFor,
  sweepForRevert,
  type SweepDecisionInput,
} from './persona-mutation-sweeps';

const changeLogCollection = database.get<PersonaChangeLogModel>('persona_change_log');
const factsCollection = database.get<FactModel>('facts');

/** The invertible payload every rails mutation must log. */
export interface ChangeLogAction {
  targetId?: string;
  before?: unknown;
  after?: unknown;
  delta?: number;
  [key: string]: unknown;
}

export interface AppendChangeInput {
  actionType: string;
  action: ChangeLogAction;
  source: PersonaChangeLogSource;
  summary: string;
}

export async function append(input: AppendChangeInput): Promise<PersonaChangeLogModel> {
  return database.write(async () => {
    return changeLogCollection.create((row) => {
      row.actionType = input.actionType;
      row.actionJson = JSON.stringify(input.action);
      row.source = input.source;
      row.summary = input.summary;
      row.reverted = false;
      row.createdAt = new Date();
    });
  });
}

/** Batch append (single write) — used by the silent migration. */
export async function appendMany(inputs: AppendChangeInput[]): Promise<void> {
  if (inputs.length === 0) return;
  await database.write(async () => {
    const now = new Date();
    const prepared = inputs.map((input) =>
      changeLogCollection.prepareCreate((row) => {
        row.actionType = input.actionType;
        row.actionJson = JSON.stringify(input.action);
        row.source = input.source;
        row.summary = input.summary;
        row.reverted = false;
        row.createdAt = now;
      }),
    );
    await database.batch(prepared);
  });
}

export async function getById(id: string): Promise<PersonaChangeLogModel> {
  return changeLogCollection.find(id);
}

/** Reactive query of the most recent entries (audit screen). */
export function observeRecent(limit = 100) {
  return changeLogCollection
    .query(Q.sortBy('created_at', Q.desc), Q.take(limit))
    .observe();
}

export async function getRecent(limit = 100): Promise<PersonaChangeLogModel[]> {
  return changeLogCollection
    .query(Q.sortBy('created_at', Q.desc), Q.take(limit))
    .fetch();
}

function parseAction(row: PersonaChangeLogModel): ChangeLogAction {
  try {
    const parsed = JSON.parse(row.actionJson);
    if (parsed && typeof parsed === 'object') return parsed as ChangeLogAction;
  } catch {
    // fall through
  }
  throw new Error(`persona_change_log ${row.id}: unparseable action_json`);
}

function requireTargetId(action: ChangeLogAction, rowId: string): string {
  if (typeof action.targetId !== 'string' || !action.targetId) {
    throw new Error(`persona_change_log ${rowId}: action_json has no targetId`);
  }
  return action.targetId;
}

function requireNumericBefore(action: ChangeLogAction, rowId: string): number {
  if (typeof action.before !== 'number') {
    throw new Error(`persona_change_log ${rowId}: action_json has no numeric 'before'`);
  }
  return action.before;
}

function requireBooleanBefore(action: ChangeLogAction, rowId: string): boolean {
  if (typeof action.before !== 'boolean') {
    throw new Error(`persona_change_log ${rowId}: action_json has no boolean 'before'`);
  }
  return action.before;
}

/**
 * Was this suppression row a HARD filter? Reads the row rather than the log,
 * because `add_suppression`/`retire_suppression` entries record kind/value but
 * not strength. A row that no longer exists can't have excluded anything, so
 * a miss is `false` — never a throw, since this only informs the sweep.
 */
async function suppressionWasHard(suppressionId: string): Promise<boolean> {
  try {
    const all = await suppressionService.getAll();
    const found = all.find((s) => s.id === suppressionId);
    return !!found && found.strength >= suppressionService.HARD_SUPPRESSION_STRENGTH;
  } catch {
    return false;
  }
}

/**
 * Reverts a logged persona mutation by applying its inverse, marks the row
 * `reverted`, appends a `revert_change` entry (source 'user'), and then runs
 * whatever retroactive feed sweep the undo requires (D12) plus the feed-dirty
 * flag (D18) — the same reconciliation the persona-action-executor seam does,
 * via the same shared policy module. A revert is a persona mutation like any
 * other; skipping this is what let an undone hard filter leave its purged
 * articles gone for the rest of the 48h window.
 *
 * Implemented inversions:
 *   set_topic_weight / set_fact_weight / set_location_weight → restore `before`
 *   add_topic          → retire the created topic
 *   retire_topic       → reactivate the topic
 *   set_high_priority  → restore the prior boolean flag
 *   add_negative_topic → retire the created (negative) topic
 *   add_suppression    → retire the created suppression
 *   retire_suppression → reactivate the suppression (D5: removing a filter is
 *                        an audited, undoable mutation, not a silent delete)
 *   suppress_topic     → reactivate the topic (forward-compat)
 *   set_publication_pref → restore the prior pref kind (or clear if it was none)
 * Anything else throws — later waves extend this switch as new action types
 * gain rails.
 */
export async function revertChange(changeLogId: string): Promise<void> {
  const row = await changeLogCollection.find(changeLogId);
  if (row.reverted) return;
  const action = parseAction(row);

  // D12 + D18. A revert is a persona mutation like any other, so it owes the
  // feed the same reconciliation the forward path does. Described in FORWARD
  // terms — `sweepForRevert` mirrors it — so a new action type can never be
  // wired into one path and forgotten in the other.
  const sweepInput: SweepDecisionInput = { actionType: row.actionType };

  switch (row.actionType) {
    case 'set_topic_weight': {
      const targetId = requireTargetId(action, row.id);
      await topicService.setWeight(targetId, requireNumericBefore(action, row.id));
      break;
    }
    case 'set_fact_weight': {
      const targetId = requireTargetId(action, row.id);
      const before = action.before;
      if (before !== null && typeof before !== 'number') {
        throw new Error(`persona_change_log ${row.id}: 'before' must be number|null for set_fact_weight`);
      }
      const fact = await factsCollection.find(targetId);
      await database.write(async () => {
        await fact.update((f) => {
          f.weight = before;
          f.updatedAt = new Date();
        });
      });
      break;
    }
    case 'set_location_weight': {
      const targetId = requireTargetId(action, row.id);
      await locationService.setWeight(targetId, requireNumericBefore(action, row.id));
      break;
    }
    case 'add_topic': {
      // Inverse of creation is retirement, not deletion — retired rows keep
      // serving dedup/history.
      const targetId = requireTargetId(action, row.id);
      await topicService.retire(targetId);
      break;
    }
    case 'retire_topic': {
      // ACCEPTED DRIFT: `reactivate` restores status 'active', not whatever the
      // row held before. Removing a NEGATIVE topic routes through retire_topic
      // (there is no retire_negative_topic), so reverting the removal of a
      // topic that had been 'suppressed' brings it back 'active' instead. The
      // weight — which is what actually makes a negative topic negative — is
      // untouched, so the topic is still disliked; it just loses hard-suppressed
      // status. Not worth a second action type; revisit if suppressed topics
      // ever become user-visible as a distinct state.
      const targetId = requireTargetId(action, row.id);
      await topicService.reactivate(targetId);
      break;
    }
    case ACTION_NAMES.SET_HIGH_PRIORITY: {
      const targetId = requireTargetId(action, row.id);
      await topicService.setHighPriority(targetId, requireBooleanBefore(action, row.id));
      break;
    }
    case ACTION_NAMES.ADD_NEGATIVE_TOPIC: {
      // Inverse of creation is retirement (mirrors add_topic).
      const targetId = requireTargetId(action, row.id);
      await topicService.retire(targetId);
      break;
    }
    case ACTION_NAMES.ADD_SUPPRESSION: {
      const targetId = requireTargetId(action, row.id);
      // Undoing a HARD add retires the filter, so its casualties must come
      // back — the mirror of the purge the add performed (D12c).
      sweepInput.hardFilter = await suppressionWasHard(targetId);
      await suppressionService.retireSuppression(targetId);
      break;
    }
    case ACTION_NAMES.RETIRE_SUPPRESSION: {
      // Mirror of add_suppression's inverse. reactivateSuppression keeps the
      // ORIGINAL expires_at, so undoing the removal of a long-expired SOFT
      // filter is deliberately inert rather than a silent 30-day extension.
      const targetId = requireTargetId(action, row.id);
      // Undoing a removal puts the filter back, so a HARD one must re-purge
      // what it had been blocking.
      sweepInput.hardFilter = await suppressionWasHard(targetId);
      await suppressionService.reactivateSuppression(targetId);
      break;
    }
    case ACTION_NAMES.SUPPRESS_TOPIC: {
      // Forward-compat: undo a topic suppression by reactivating it.
      const targetId = requireTargetId(action, row.id);
      await topicService.reactivate(targetId);
      break;
    }
    case ACTION_NAMES.SET_PUBLICATION_PREF: {
      // `before` is the PRIOR pref kind ('boost'|'deprioritize'|'mute') or
      // 'none' (no prior preference). Restoring 'none' retires the row.
      const targetId = requireTargetId(action, row.id);
      const before = action.before;
      if (before !== 'none' && before !== 'boost' && before !== 'deprioritize' && before !== 'mute') {
        throw new Error(
          `persona_change_log ${row.id}: 'before' must be a publication pref kind for set_publication_pref`,
        );
      }
      // Crossing the mute boundary is a hard-filter change in either
      // direction; sweepForRevert mirrors it (restoring 'mute' purges,
      // leaving 'mute' releases).
      sweepInput.prefBefore = before;
      sweepInput.prefAfter = typeof action.after === 'string' ? action.after : undefined;
      await publicationPreferenceService.setPreferenceKind(
        targetId,
        before as PublicationPrefKind | 'none',
      );
      break;
    }
    // source-pref v47 (D2/D6). MANDATORY, not optional: `isRevertible` in
    // components/custom/persona-audit/action-display.ts is a DENY-list, so this
    // action type is already offered an Undo button on the Activity screen —
    // without a case here that button can only produce an error toast.
    //
    // `targetId` is the composite `'{scopeKind}:{scopeValue}'` ('country:IND').
    // A scope has no row id to point at, so the log has to carry enough to
    // rebuild the whole SourceScopeRef; the executor and the Source-preferences
    // screen both write exactly this encoding.
    case ACTION_NAMES.SET_SOURCE_SCOPE_PREF: {
      const targetId = requireTargetId(action, row.id);
      const sep = targetId.indexOf(':');
      const scopeKind = sep > 0 ? targetId.slice(0, sep) : '';
      const scopeValue = sep > 0 ? targetId.slice(sep + 1) : '';
      if (scopeKind !== 'country' || !scopeValue) {
        throw new Error(
          `persona_change_log ${row.id}: targetId must be '{scopeKind}:{scopeValue}' for set_source_scope_pref`,
        );
      }
      const before = action.before;
      if (before !== 'none' && before !== 'boost' && before !== 'deprioritize' && before !== 'mute') {
        throw new Error(
          `persona_change_log ${row.id}: 'before' must be a publication pref kind for set_source_scope_pref`,
        );
      }
      // Same mute-boundary wiring as set_publication_pref — inert for scopes
      // today (both gates reject a scope mute) but kept symmetric so the two
      // paths cannot drift. See persona-mutation-sweeps.
      sweepInput.prefBefore = before;
      sweepInput.prefAfter = typeof action.after === 'string' ? action.after : undefined;
      // `label` is only consulted when `before` is a concrete kind (restoring
      // 'none' retires the row and keeps its stored label for the audit trail).
      const label = typeof action.label === 'string' && action.label.trim() ? action.label.trim() : scopeValue;
      await publicationPreferenceService.setScopePreferenceKind(
        { scopeKind, scopeValue },
        before as PublicationPrefKind | 'none',
        label,
      );
      break;
    }
    default:
      throw new Error(
        `persona_change_log ${row.id}: no inverse implemented for action_type '${row.actionType}'`,
      );
  }

  await database.write(async () => {
    await row.update((r) => {
      r.reverted = true;
    });
  });
  await append({
    actionType: 'revert_change',
    action: { targetId: row.id, revertedActionType: row.actionType },
    source: 'user',
    summary: `Reverted: ${row.summary}`,
  });

  // D12 + D18, AFTER the inverse is committed and audited (both sweeps read the
  // persona live, so running earlier would screen against the pre-revert
  // state). Identical policy and identical failure handling to the executor
  // seam: a sweep failure is caught and logged inside runSweepFor, never
  // propagated — the revert already happened, so throwing here would report a
  // completed undo as failed. A failed purge falls through to the dirty flag.
  const purged = await runSweepFor(sweepForRevert(sweepInput), row.actionType);
  if (!purged) markFeedNeedsRefresh();
}
