import { text, type OnDeviceToolCall, type OnDeviceTurnResult } from '../shared';
import type { PersonaChatReply } from './schema';

export interface PersonaTurnFacts {
  /** Ids of the facts shown in the context: a delete may name only these. */
  factIds: ReadonlySet<string>;
  hasPending: boolean;
}

/**
 * The fields to PersonaUpdateAgent's executors: saveExtractedFacts (which only
 * stages fact cards), deleteUserFacts, applyProposal and cancelProposal.
 */
export function personaChatTurn(value: PersonaChatReply, facts: PersonaTurnFacts): OnDeviceTurnResult {
  const calls: OnDeviceToolCall[] = [];
  const save = (value.save ?? [])
    .map((s) => ({ statement: text(s?.statement), questionnaire_attribute: text(s?.attribute) || 'other' }))
    .filter((s) => s.statement.length > 0);
  if (save.length > 0) calls.push({ name: 'saveExtractedFacts', input: { extracted_user_information: save } });
  const remove = [...new Set((value.delete ?? []).map(text))].filter((id) => facts.factIds.has(id));
  if (remove.length > 0) calls.push({ name: 'deleteUserFacts', input: { fact_ids: remove } });
  if (facts.hasPending && value.confirm === true) calls.push({ name: 'applyProposal', input: {} });
  else if (facts.hasPending && value.cancel === true) calls.push({ name: 'cancelProposal', input: {} });
  return { reply: text(value.reply), calls };
}
