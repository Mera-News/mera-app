// Proposal Executor — applies a staged persona proposal deterministically in
// pure TypeScript (no inference). Runs on both the one-shot local path and the
// cloud path so "Confirm" and a typed "yes" converge on identical behaviour.

import {
  addFact,
  deleteFact,
  getFacts,
  updateFact,
} from '../database/services/fact-service';
import type { Fact } from '../mera-protocol-toolkit/types';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import { triggerTopicGeneration } from './tool-handlers';
import type { ProposalAction } from '../llm/types';
import { submitFeatureRequest } from '../feedback';
import { getAllByNormalizedText } from '../database/services/topic-service';
import {
  applyPersonaAction,
  type PersonaAction,
} from '../database/services/persona-action-executor';
import { ACTION_NAMES } from '../news-harness/persona-management/action-names';
import { trackStoryWithProposal } from '../tracking/track-actions';
import type { FeedbackSubject } from '../../components/custom/cards/feedback-subject';
import logger from '../logger';

/** Outcome of one executed proposal — richer than a bare count so the chat can
 *  render "what changed" and offer undo (changeLogIds power `revert_change`). */
export interface ExecuteProposalResult {
  applied: number;
  errors: string[];
  /** Human-readable summaries of every APPLIED rails-backed mutation. */
  summaries: string[];
  /** Change-log row ids of applied rails-backed mutations (undo handles). */
  changeLogIds: string[];
}

/**
 * Resolve a matched-topic TEXT (all the feedback context exposes) to an ACTIVE
 * topic id for the weight/high-priority executor actions. Prefers the
 * highest-|weight| active row when several share a normalized text.
 */
async function resolveActiveTopicId(topicText: string): Promise<string | null> {
  const rows = await getAllByNormalizedText(topicText);
  const active = rows.filter((t) => t.status === 'active');
  if (active.length === 0) return null;
  active.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return active[0].id;
}

/**
 * Executes staged proposal actions in order. Legacy fact/topic-CRUD actions are
 * applied directly against fact-service (fact ids validated upfront in a single
 * `getFacts()` pass). The Wave-9 rails-backed actions (topic-weight nudges,
 * negative topics, publication prefs, suppressions, high-priority pins) route
 * through `applyPersonaAction` with source `'user'` — which mints its own
 * invertible persona_change_log row (so we never double-log here). Never throws;
 * failures are collected into `errors`. Finishes with a fact-mutation notify.
 */
export async function executeProposalActions(
  actions: ProposalAction[],
): Promise<ExecuteProposalResult> {
  const errors: string[] = [];
  const summaries: string[] = [];
  const changeLogIds: string[] = [];
  let applied = 0;

  // Route a rails-backed action through the executor and fold its result in.
  const runRails = async (personaAction: PersonaAction, label: string): Promise<void> => {
    const r = await applyPersonaAction(personaAction, 'user');
    if (r.applied) {
      applied++;
      summaries.push(r.summary);
      if (r.changeLogId) changeLogIds.push(r.changeLogId);
    } else {
      // The executor never throws — a non-applied result is a skip/no-op we
      // surface as an error line (e.g. "Nudge budget exhausted").
      errors.push(`${label}: ${r.summary}`);
    }
  };

  // One pass to resolve current facts for id validation + topic rewrites.
  const facts = await getFacts();
  const factsById = new Map<string, Fact>(facts.map((f) => [f.id, f]));
  const newFactEntries: Array<{ id: string; statement: string }> = [];

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'add_fact': {
          const statement = action.statement.trim();
          if (!statement) {
            errors.push('add_fact: empty statement');
            break;
          }
          const saved = await addFact(statement);
          newFactEntries.push({ id: saved.id, statement });
          applied++;
          break;
        }
        case 'update_fact': {
          const fact = factsById.get(action.fact_id);
          if (!fact) {
            errors.push(`update_fact: fact ${action.fact_id} not found`);
            break;
          }
          const statement = action.new_statement.trim();
          if (!statement) {
            errors.push(`update_fact: empty statement for ${action.fact_id}`);
            break;
          }
          await updateFact(action.fact_id, { statement });
          applied++;
          break;
        }
        case 'delete_fact': {
          const fact = factsById.get(action.fact_id);
          if (!fact) {
            errors.push(`delete_fact: fact ${action.fact_id} not found`);
            break;
          }
          await deleteFact(action.fact_id);
          applied++;
          break;
        }
        case 'add_topics': {
          const fact = factsById.get(action.fact_id);
          if (!fact) {
            errors.push(`add_topics: fact ${action.fact_id} not found`);
            break;
          }
          const current = fact.metadata?.topics ?? [];
          const merged = Array.from(new Set([...current, ...action.topics]));
          await updateFact(action.fact_id, {
            metadata: { ...(fact.metadata ?? {}), topics: merged },
          });
          applied++;
          break;
        }
        case 'remove_topics': {
          const fact = factsById.get(action.fact_id);
          if (!fact) {
            errors.push(`remove_topics: fact ${action.fact_id} not found`);
            break;
          }
          const remove = new Set(action.topics);
          const next = (fact.metadata?.topics ?? []).filter((t) => !remove.has(t));
          await updateFact(action.fact_id, {
            metadata: { ...(fact.metadata ?? {}), topics: next },
          });
          applied++;
          break;
        }
        case 'submit_feature_request': {
          // No fact_id involved — nothing to resolve against factsById.
          const ok = submitFeatureRequest(action.title, action.summary);
          if (!ok) {
            errors.push('submit_feature_request: feedback submission unavailable in this build');
            break;
          }
          applied++;
          break;
        }
        // -- Wave-9 rails-backed actions (routed through applyPersonaAction) --
        case 'set_topic_weight': {
          const topicId = await resolveActiveTopicId(action.topicText);
          if (!topicId) {
            errors.push(`set_topic_weight: no active topic matching "${action.topicText}"`);
            break;
          }
          await runRails(
            { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId, delta: action.delta },
            'set_topic_weight',
          );
          break;
        }
        case 'add_negative_topic': {
          await runRails(
            {
              action_type: ACTION_NAMES.ADD_NEGATIVE_TOPIC,
              topicText: action.topicText,
              ...(typeof action.weight === 'number' ? { weight: action.weight } : {}),
            },
            'add_negative_topic',
          );
          break;
        }
        case 'set_publication_pref': {
          await runRails(
            {
              action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
              publicationId: action.publicationId,
              publicationPref: action.publicationPref,
            },
            'set_publication_pref',
          );
          break;
        }
        case 'add_suppression': {
          await runRails(
            {
              action_type: ACTION_NAMES.ADD_SUPPRESSION,
              suppressionPattern: action.suppressionPattern,
              ...(action.suppressionKeywords ? { suppressionKeywords: action.suppressionKeywords } : {}),
              ...(typeof action.suppressionStrength === 'number'
                ? { suppressionStrength: action.suppressionStrength }
                : {}),
            },
            'add_suppression',
          );
          break;
        }
        case 'set_high_priority': {
          const topicId = await resolveActiveTopicId(action.topicText);
          if (!topicId) {
            errors.push(`set_high_priority: no active topic matching "${action.topicText}"`);
            break;
          }
          await runRails(
            { action_type: ACTION_NAMES.SET_HIGH_PRIORITY, topicId, highPriority: action.highPriority },
            'set_high_priority',
          );
          break;
        }
        case 'track_story': {
          // Follow the tapped article's story as a topic. The origin snapshot is
          // embedded in the action (staged by decideProposeTrack), so this stays
          // self-contained — no store read. trackStoryWithProposal mints the
          // topic + local TrackedStory row and fires archive backfill.
          const text = action.trackText.trim();
          if (!text) {
            errors.push('track_story: empty trackText');
            break;
          }
          await trackStoryWithProposal(action.subject as FeedbackSubject, text);
          summaries.push(`Following "${text}"`);
          applied++;
          break;
        }
        default: {
          // Exhaustiveness guard — unreachable if ProposalAction is respected.
          errors.push(`unknown action type: ${(action as { type: string }).type}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[proposal-handlers] action failed', { type: action.type, error: msg });
      errors.push(`${action.type}: ${msg}`);
    }
  }

  // Newly-added facts need topics generated (same trigger as chat fact-saving).
  triggerTopicGeneration(newFactEntries);

  useFloatingChatStore.getState().notifyFactMutation();

  return { applied, errors, summaries, changeLogIds };
}
