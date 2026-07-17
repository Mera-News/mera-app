// Mutation-Rails Service — WatermelonDB adapter for the bounded persona
// mutations (Wave 8 M-P6). Thin glue: it reads the current persona state,
// delegates the DECISIONS to the pure rails
// (lib/news-harness/persona-management/mutation-rails.ts), writes the result
// via the existing per-collection services, and appends an invertible
// change-log row for every applied mutation. No mutation math lives here.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type TopicModel from '../models/Topic';
import type FactModel from '../models/Fact';
import type PersonaChangeLogModel from '../models/PersonaChangeLog';
import type { PersonaChangeLogSource } from '../models/PersonaChangeLog';
import * as topicService from './topic-service';
import * as locationService from './location-service';
import * as suppressionService from './suppression-service';
import * as changeLogService from './persona-change-log-service';
import logger from '../../logger';
import { ACTION_NAMES } from '../../news-harness/persona-management/action-names';
import {
  nudgeTopicWeight,
  clampWeight,
  buildWrongLocationActions,
  type WrongLocationInput,
} from '../../news-harness/persona-management/mutation-rails';

const topicsCollection = database.get<TopicModel>('topics');
const factsCollection = database.get<FactModel>('facts');
const changeLogCollection = database.get<PersonaChangeLogModel>('persona_change_log');

/** Short 2-dp weight label for change-log summaries (English only). */
function fmt(w: number): string {
  return w.toFixed(2);
}

/** Local midnight (ms) — the per-day nudge-budget window boundary. */
function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseActionJson(json: string): { targetId?: unknown; delta?: unknown } | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Sum of |delta| of today's `set_topic_weight` rows targeting this topic — the
 * budget already spent, fed to the pure `nudgeTopicWeight`.
 */
async function todayTopicBudgetUsedAbs(topicId: string): Promise<number> {
  const sinceMs = startOfTodayMs();
  const rows = await changeLogCollection
    .query(
      Q.where('action_type', ACTION_NAMES.SET_TOPIC_WEIGHT),
      Q.where('created_at', Q.gte(sinceMs)),
    )
    .fetch();
  let used = 0;
  for (const row of rows) {
    // Defensive re-filter (the unit-test mock DB ignores Q.where predicates).
    if (row.actionType !== ACTION_NAMES.SET_TOPIC_WEIGHT) continue;
    if (row.createdAt.getTime() < sinceMs) continue;
    const action = parseActionJson(row.actionJson);
    if (!action || action.targetId !== topicId) continue;
    if (typeof action.delta === 'number') used += Math.abs(action.delta);
  }
  return used;
}

/**
 * Nudge a topic's weight under the per-topic per-day budget. Reads the current
 * weight + today's spent budget, runs the pure rail, and — only when the delta
 * actually moved the weight — writes it and appends a `set_topic_weight` row.
 * When the budget is exhausted (appliedDelta 0) NOTHING is written: the signal
 * is recorded elsewhere, the weight is unchanged, and the digest decides.
 */
export async function nudgeTopic(
  topicId: string,
  delta: number,
  source: PersonaChangeLogSource,
): Promise<{ applied: boolean; after: number }> {
  const topic = await topicsCollection.find(topicId);
  const usedAbs = await todayTopicBudgetUsedAbs(topicId);
  const result = nudgeTopicWeight(topic.weight, delta, usedAbs);

  if (result.appliedDelta === 0) {
    return { applied: false, after: result.before };
  }

  await topicService.setWeight(topicId, result.after);
  await changeLogService.append({
    actionType: ACTION_NAMES.SET_TOPIC_WEIGHT,
    action: {
      targetId: topicId,
      before: result.before,
      after: result.after,
      delta: result.appliedDelta,
    },
    source,
    summary: `Adjusted topic weight ${fmt(result.before)} → ${fmt(result.after)}`,
  });
  return { applied: true, after: result.after };
}

/**
 * Set a topic's high-priority flag (score-only boost; no weight delta). Records
 * the prior boolean so `revertChange` can restore it.
 */
export async function setTopicHighPriority(
  topicId: string,
  highPriority: boolean,
  source: PersonaChangeLogSource,
): Promise<void> {
  const topic = await topicsCollection.find(topicId);
  const before = topic.highPriority;
  if (before === highPriority) return; // no-op — nothing to log
  await topicService.setHighPriority(topicId, highPriority);
  await changeLogService.append({
    actionType: ACTION_NAMES.SET_HIGH_PRIORITY,
    action: { targetId: topicId, before, after: highPriority },
    source,
    summary: highPriority ? 'Pinned topic as high priority' : 'Unpinned topic',
  });
}

/**
 * Nudge a fact's weight. `before` is the ACTUAL stored value (may be null ⇒ the
 * 1.0 baseline is used for the arithmetic but the null is logged verbatim, so
 * revert restores the exact prior state — mirroring revertChange's
 * number|null handling for set_fact_weight).
 */
export async function nudgeFactWeight(
  factId: string,
  delta: number,
  source: PersonaChangeLogSource,
): Promise<void> {
  const fact = await factsCollection.find(factId);
  const before: number | null = fact.weight ?? null;
  const after = clampWeight((before ?? 1) + delta);
  await database.write(async () => {
    await fact.update((f) => {
      f.weight = after;
      f.updatedAt = new Date();
    });
  });
  await changeLogService.append({
    actionType: ACTION_NAMES.SET_FACT_WEIGHT,
    action: { targetId: factId, before, after },
    source,
    summary: `Adjusted fact weight ${fmt(before ?? 1)} → ${fmt(after)}`,
  });
}

/** Wrong-location input MINUS the user's locations — those are loaded here. */
export type ApplyWrongLocationInput = Omit<WrongLocationInput, 'locations'>;

/**
 * Execute a wrong-location feedback signal: load the user's locations, compile
 * the ordered action descriptors via the pure `buildWrongLocationActions`, then
 * apply each (mint a location-anchored NEGATIVE topic; optionally add a SOFT
 * suppression from the article's bad-context entities). Each applied action
 * appends its own invertible change-log row. Wrapped defensively per-action so
 * one failing write can't abort the rest.
 */
export async function applyWrongLocation(
  input: ApplyWrongLocationInput,
  source: PersonaChangeLogSource = 'feedback',
): Promise<void> {
  const locations = (await locationService.getAll()).map((l) => ({
    city: l.city,
    region: l.region,
    countryCode: l.countryCode,
  }));
  const actions = buildWrongLocationActions({ ...input, locations });

  for (const action of actions) {
    try {
      if (action.kind === 'add_negative_topic') {
        const [created] = await topicService.createTopics([
          {
            text: action.text,
            weight: action.weight,
            status: 'active',
            provenance: 'feedback',
          },
        ]);
        if (!created) continue;
        await changeLogService.append({
          actionType: ACTION_NAMES.ADD_NEGATIVE_TOPIC,
          action: { targetId: created.id, text: action.text },
          source,
          summary: `Added negative topic: ${action.text}`,
        });
      } else {
        const suppression = await suppressionService.addSuppression({
          pattern: action.pattern,
          keywords: action.keywords,
          strength: action.strength,
          source: 'feedback',
        });
        await changeLogService.append({
          actionType: ACTION_NAMES.ADD_SUPPRESSION,
          action: { targetId: suppression.id },
          source,
          summary: `Suppressed: ${action.pattern}`,
        });
      }
    } catch (error) {
      logger.captureException(error, {
        tags: { service: 'mutation-rails', method: 'applyWrongLocation' },
      });
    }
  }
}
