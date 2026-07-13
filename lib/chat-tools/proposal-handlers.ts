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
import logger from '../logger';

/**
 * Executes staged proposal actions in order. Fact ids are validated upfront in
 * a single `getFacts()` pass — an action referencing a missing id fails with a
 * descriptive error but the remaining actions still run. Never throws; all
 * failures are collected into `errors`. Finishes with a fact-mutation notify.
 */
export async function executeProposalActions(
  actions: ProposalAction[],
): Promise<{ applied: number; errors: string[] }> {
  const errors: string[] = [];
  let applied = 0;

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

  return { applied, errors };
}
