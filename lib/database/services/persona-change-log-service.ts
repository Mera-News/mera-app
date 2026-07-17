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

/**
 * Reverts a logged persona mutation by applying its inverse, marks the row
 * `reverted`, and appends a `revert_change` entry (source 'user').
 *
 * Implemented inversions (this wave):
 *   set_topic_weight / set_fact_weight / set_location_weight → restore `before`
 *   add_topic    → retire the created topic
 *   retire_topic → reactivate the topic
 * Anything else throws — later waves extend this switch as new action types
 * gain rails.
 */
export async function revertChange(changeLogId: string): Promise<void> {
  const row = await changeLogCollection.find(changeLogId);
  if (row.reverted) return;
  const action = parseAction(row);

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
      const targetId = requireTargetId(action, row.id);
      await topicService.reactivate(targetId);
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
}
